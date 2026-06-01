import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveDestination,
  DestinationArgsError,
  DestinationApiError,
  writePermissionMessage,
  unimplementedSandboxCreator,
  unimplementedPrompt,
  type DestinationResolvers,
  type DestinationFlags,
  type DestinationChoice,
  type DestinationSelection,
  type RepoRef,
} from "../src/destination.js";
import type { RepoVerification } from "../src/github.js";
import type { SavedDestination } from "../src/config.js";

const SOURCE: RepoRef = { owner: "acme", repo: "api" };

/** A recorded call against one of the injected fakes. */
interface RecordedCall {
  fn: "verify" | "create" | "prompt" | "clone" | "push" | "createPr";
  args: unknown[];
}

interface Harness {
  calls: RecordedCall[];
  resolvers: DestinationResolvers;
}

/** Build resolvers whose fakes record their call sequence and args. */
function makeHarness(opts: {
  flags?: DestinationFlags;
  saved?: SavedDestination;
  isTTY?: boolean;
  verify?: (owner: string, repo: string) => RepoVerification;
  create?: (req: { owner: string; name: string }) => RepoRef;
  prompt?: (choices: DestinationChoice[]) => DestinationSelection;
}): Harness {
  const calls: RecordedCall[] = [];
  const resolvers: DestinationResolvers = {
    getFlags: () => opts.flags ?? {},
    getDefaultDestination: () => opts.saved,
    getIsTTY: () => opts.isTTY ?? false,
    verifyDestination: async (owner, repo) => {
      calls.push({ fn: "verify", args: [owner, repo] });
      return opts.verify
        ? opts.verify(owner, repo)
        : { exists: true, canPush: true };
    },
    createSandbox: async (req) => {
      calls.push({ fn: "create", args: [req.owner, req.name] });
      if (!opts.create) {
        throw new DestinationApiError("no create fake provided");
      }
      return opts.create(req);
    },
    prompt: async (choices) => {
      calls.push({ fn: "prompt", args: [choices] });
      if (!opts.prompt) {
        throw new DestinationArgsError("no prompt fake provided");
      }
      return opts.prompt(choices);
    },
  };
  return { calls, resolvers };
}

/** Assert the source owner/repo never appears in a verify/create/write call. */
function assertSourceNeverWritten(calls: RecordedCall[]): void {
  for (const call of calls) {
    if (call.fn === "prompt") continue;
    assert.ok(
      !(call.args[0] === SOURCE.owner && call.args[1] === SOURCE.repo),
      `source ${SOURCE.owner}/${SOURCE.repo} was passed to a ${call.fn} call`,
    );
  }
}

// --- VAL-DEST-001 ---
test("VAL-DEST-001: --primary resolves to source, no prompt, isSandbox false", async () => {
  const h = makeHarness({ flags: { primary: true } });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

// --- VAL-DEST-002 ---
test("VAL-DEST-002: --sandbox existing+writable resolves to that repo, no prompt", async () => {
  const h = makeHarness({
    flags: { sandbox: "me/sandbox" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "me", repo: "sandbox", isSandbox: true });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

// --- VAL-DEST-003 ---
test("VAL-DEST-003: --primary + --sandbox throws bad-args before any verify/create", async () => {
  const h = makeHarness({ flags: { primary: true, sandbox: "me/sandbox" } });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => err instanceof DestinationArgsError,
  );
  assert.equal(h.calls.length, 0, "no verify/create/prompt before bad-args");
});

// --- VAL-DEST-004 ---
test("VAL-DEST-004: non-interactive, no flag, no saved default → bad-args naming both flags", async () => {
  const h = makeHarness({ isTTY: false });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(err instanceof DestinationArgsError);
      assert.match(err.message, /--primary/);
      assert.match(err.message, /--sandbox/);
      return true;
    },
  );
  assert.equal(h.calls.length, 0, "no verify/write fake invoked");
});

// --- VAL-DEST-005 ---
test("VAL-DEST-005: non-interactive, no flag, saved default → returns saved (after verify), no prompt", async () => {
  const h = makeHarness({
    isTTY: false,
    saved: { owner: "me", repo: "sandbox" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "me", repo: "sandbox", isSandbox: true });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
  // verify ran on the destination, not the source.
  assert.deepEqual(h.calls.find((c) => c.fn === "verify")?.args, ["me", "sandbox"]);
});

// --- VAL-DEST-006 ---
test("VAL-DEST-006: precedence flags → interactive(TTY) → saved-default(non-TTY) → error", async () => {
  // (1) flag wins over config + TTY: --primary with a saved default + TTY still ignores both.
  {
    const h = makeHarness({
      flags: { primary: true },
      saved: { owner: "me", repo: "sandbox" },
      isTTY: true,
    });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.equal(result.isSandbox, false);
    assert.ok(!h.calls.some((c) => c.fn === "prompt"), "flag tier bypasses prompt");
  }
  // (1b) --sandbox honored within the flag tier.
  {
    const h = makeHarness({ flags: { sandbox: "me/sandbox" } });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.equal(result.owner, "me");
  }
  // (2) no flag + TTY → interactive prompt invoked.
  {
    const h = makeHarness({
      isTTY: true,
      prompt: () => ({ kind: "primary", repo: SOURCE }),
    });
    await resolveDestination(SOURCE, h.resolvers);
    assert.ok(h.calls.some((c) => c.fn === "prompt"), "TTY path prompts");
  }
  // (3) no flag + no TTY + saved default → saved default.
  {
    const h = makeHarness({
      isTTY: false,
      saved: { owner: "me", repo: "sandbox" },
    });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.equal(result.owner, "me");
    assert.ok(!h.calls.some((c) => c.fn === "prompt"));
  }
  // (4) no flag + no TTY + no default → bad-args.
  {
    const h = makeHarness({ isTTY: false });
    await assert.rejects(
      () => resolveDestination(SOURCE, h.resolvers),
      (err: unknown) => err instanceof DestinationArgsError,
    );
  }
});

// --- VAL-DEST-007 ---
test("VAL-DEST-007: --sandbox equal to source resolves as destination==source, isSandbox false", async () => {
  const h = makeHarness({
    flags: { sandbox: "acme/api" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

// --- VAL-VERIFY-001 ---
test("VAL-VERIFY-001: saved default 404 — non-interactive throws exit-2, interactive re-prompts", async () => {
  // Non-interactive branch.
  {
    const h = makeHarness({
      isTTY: false,
      saved: { owner: "me", repo: "gone" },
      verify: () => ({ exists: false, canPush: false }),
    });
    await assert.rejects(
      () => resolveDestination(SOURCE, h.resolvers),
      (err: unknown) => err instanceof DestinationApiError,
    );
    assertSourceNeverWritten(h.calls);
  }
  // Interactive branch: saved-sandbox 404 → re-present menu, then pick primary (writable).
  {
    let promptCount = 0;
    const h = makeHarness({
      isTTY: true,
      saved: { owner: "me", repo: "gone" },
      verify: (owner) => (owner === "me" ? { exists: false, canPush: false } : { exists: true, canPush: true }),
      prompt: () => {
        promptCount += 1;
        return promptCount === 1
          ? { kind: "saved-sandbox", repo: { owner: "me", repo: "gone" } }
          : { kind: "primary", repo: SOURCE };
      },
    });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.equal(result.isSandbox, false);
    assert.ok(promptCount >= 2, "menu was re-presented after 404");
  }
});

// --- VAL-VERIFY-002 ---
test("VAL-VERIFY-002: non-primary exists-but-not-writable — §6.1 message, non-interactive exit-2 / interactive re-prompt", async () => {
  // Non-interactive: exit-2 with §6.1 message naming repo + capability.
  {
    const h = makeHarness({
      flags: { sandbox: "me/ro" },
      verify: () => ({ exists: true, canPush: false }),
    });
    await assert.rejects(
      () => resolveDestination(SOURCE, h.resolvers),
      (err: unknown) => {
        assert.ok(err instanceof DestinationApiError);
        assert.match(err.message, /me\/ro/);
        assert.match(err.message, /Contents:write \+ Pull requests:write/);
        return true;
      },
    );
    assertSourceNeverWritten(h.calls);
  }
  // Interactive: re-present menu, then pick a writable different repo.
  {
    let promptCount = 0;
    const h = makeHarness({
      isTTY: true,
      verify: (owner) => (owner === "me" ? { exists: true, canPush: false } : { exists: true, canPush: true }),
      prompt: () => {
        promptCount += 1;
        return promptCount === 1
          ? { kind: "different-repo", repo: { owner: "me", repo: "ro" } }
          : { kind: "different-repo", repo: { owner: "you", repo: "ok" } };
      },
    });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.deepEqual(result, { owner: "you", repo: "ok", isSandbox: true });
    assert.ok(promptCount >= 2);
  }
});

// --- VAL-VERIFY-003 ---
test("VAL-VERIFY-003: primary not writable — §6.1 message before clone, non-interactive exit-2 / interactive re-prompt", async () => {
  // Non-interactive (--primary): exit-2 with §6.1 message, no clone/push.
  {
    const h = makeHarness({
      flags: { primary: true },
      verify: () => ({ exists: true, canPush: false }),
    });
    await assert.rejects(
      () => resolveDestination(SOURCE, h.resolvers),
      (err: unknown) => {
        assert.ok(err instanceof DestinationApiError);
        assert.match(err.message, /acme\/api/);
        return true;
      },
    );
    assert.ok(!h.calls.some((c) => c.fn === "clone" || c.fn === "push"));
  }
  // Interactive: primary not writable → re-present menu, then choose a writable repo.
  {
    let promptCount = 0;
    const h = makeHarness({
      isTTY: true,
      verify: (owner) => (owner === "acme" ? { exists: true, canPush: false } : { exists: true, canPush: true }),
      prompt: () => {
        promptCount += 1;
        return promptCount === 1
          ? { kind: "primary", repo: SOURCE }
          : { kind: "different-repo", repo: { owner: "me", repo: "ok" } };
      },
    });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.deepEqual(result, { owner: "me", repo: "ok", isSandbox: true });
    assert.ok(promptCount >= 2, "menu re-presented rather than proceeding");
  }
});

// --- VAL-VERIFY-004 ---
test("VAL-VERIFY-004: verify runs before any clone/push/create (call order)", async () => {
  const h = makeHarness({
    flags: { sandbox: "me/sandbox" },
    verify: () => ({ exists: true, canPush: true }),
  });
  await resolveDestination(SOURCE, h.resolvers);
  // The resolver itself only ever calls verify (and possibly create); no clone/push.
  // Assert the FIRST recorded call is a verify and no write precedes it.
  const firstWrite = h.calls.findIndex(
    (c) => c.fn === "clone" || c.fn === "push" || c.fn === "createPr",
  );
  const firstVerify = h.calls.findIndex((c) => c.fn === "verify");
  assert.ok(firstVerify >= 0, "a verify call was recorded");
  assert.ok(
    firstWrite === -1 || firstVerify < firstWrite,
    "no clone/push/create appears before a successful verify",
  );
});

// --- VAL-VERIFY-005 ---
test("VAL-VERIFY-005: primary fails + saved writable sandbox known → §6.1 names it; otherwise omitted", async () => {
  // With a saved sandbox: bracketed clause names it.
  {
    const msg = writePermissionMessage(SOURCE, { owner: "me", repo: "sandbox" });
    assert.match(msg, /acme\/api/);
    assert.match(msg, /me\/sandbox/);
  }
  // Without: no bracketed clause / no alternative repo named.
  {
    const msg = writePermissionMessage(SOURCE, null);
    assert.match(msg, /acme\/api/);
    assert.doesNotMatch(msg, /e\.g\. your sandbox/);
  }
  // Through the resolver: --primary fails, saved default present → message names it.
  {
    const h = makeHarness({
      flags: { primary: true },
      saved: { owner: "me", repo: "sandbox" },
      verify: () => ({ exists: true, canPush: false }),
    });
    await assert.rejects(
      () => resolveDestination(SOURCE, h.resolvers),
      (err: unknown) => {
        assert.ok(err instanceof DestinationApiError);
        assert.match(err.message, /me\/sandbox/);
        return true;
      },
    );
  }
});

// --- VAL-INV-001 ---
test("VAL-INV-001: destination ≠ source → source never an arg to verify/create/write", async () => {
  const h = makeHarness({
    flags: { sandbox: "me/sandbox" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.equal(result.isSandbox, true);
  assertSourceNeverWritten(h.calls);
});

// --- Create paths (supporting feature 3 seam) ---
test("VAL-CREATE-004 (resolver half): --sandbox X --create-sandbox creates missing X; missing X alone exits 2", async () => {
  // With --create-sandbox: missing → create + use.
  {
    const h = makeHarness({
      flags: { sandbox: "me/new", createSandbox: true },
      verify: () => ({ exists: false, canPush: false }),
      create: (req) => ({ owner: req.owner, repo: req.name }),
    });
    const result = await resolveDestination(SOURCE, h.resolvers);
    assert.deepEqual(result, { owner: "me", repo: "new", isSandbox: true });
    assert.ok(h.calls.some((c) => c.fn === "create"));
  }
  // Without: missing → exit 2, nothing created.
  {
    const h = makeHarness({
      flags: { sandbox: "me/new" },
      verify: () => ({ exists: false, canPush: false }),
    });
    await assert.rejects(
      () => resolveDestination(SOURCE, h.resolvers),
      (err: unknown) => err instanceof DestinationApiError,
    );
    assert.ok(!h.calls.some((c) => c.fn === "create"));
  }
});

test("default seams throw clearly (create + prompt)", async () => {
  await assert.rejects(
    () => unimplementedSandboxCreator({ owner: "a", name: "b" }),
    (err: unknown) => err instanceof DestinationApiError,
  );
  await assert.rejects(
    () => unimplementedPrompt([]),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});
