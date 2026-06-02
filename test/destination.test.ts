import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";

import {
  resolveDestination,
  makeSandboxCreator,
  makeInteractivePrompt,
  DestinationArgsError,
  DestinationApiError,
  writePermissionMessage,
  type DestinationResolvers,
  type DestinationFlags,
  type DestinationChoice,
  type DestinationChoiceKind,
  type DestinationSelection,
  type RepoRef,
} from "../src/destination.js";
import { readConfig } from "../src/config.js";
import type { Octokit } from "@octokit/rest";
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
  /** Authenticated login for the personal-sandbox row. `"throw"` makes the seam reject. */
  login?: string | "throw";
}): Harness {
  const calls: RecordedCall[] = [];
  const resolvers: DestinationResolvers = {
    getFlags: () => opts.flags ?? {},
    getDefaultDestination: () => opts.saved,
    getIsTTY: () => opts.isTTY ?? false,
    getAuthenticatedLogin:
      opts.login === undefined
        ? undefined
        : async () => {
            if (opts.login === "throw") {
              throw new Error("getAuthenticatedLogin failed");
            }
            return opts.login as string;
          },
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

test("--primary resolves to source, no prompt, isSandbox false", async () => {
  const h = makeHarness({ flags: { primary: true } });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

test("--sandbox existing+writable resolves to that repo, no prompt", async () => {
  const h = makeHarness({
    flags: { sandbox: "me/sandbox" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "me", repo: "sandbox", isSandbox: true });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

test("--primary + --sandbox throws bad-args before any verify/create", async () => {
  const h = makeHarness({ flags: { primary: true, sandbox: "me/sandbox" } });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => err instanceof DestinationArgsError,
  );
  assert.equal(h.calls.length, 0, "no verify/create/prompt before bad-args");
});

test("non-interactive, no flag, no saved default → bad-args naming both flags", async () => {
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

test("non-interactive, no flag, saved default → returns saved (after verify), no prompt", async () => {
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

test("precedence flags → interactive(TTY) → saved-default(non-TTY) → error", async () => {
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

test("--sandbox equal to source resolves as destination==source, isSandbox false", async () => {
  const h = makeHarness({
    flags: { sandbox: "acme/api" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

test("--sandbox with different case than source resolves as primary (isSandbox false)", async () => {
  // Mixed-case owner AND repo vs the lowercase source acme/api.
  const h = makeHarness({
    flags: { sandbox: "Acme/API" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  // Treated as the primary: destination == source, never a sandbox write.
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(!h.calls.some((c) => c.fn === "prompt"));
});

// --- #3: malformed --sandbox slug → DestinationArgsError (exit 1) ---
test("malformed --sandbox value throws DestinationArgsError (bad args), not a raw Error", async () => {
  const h = makeHarness({ flags: { sandbox: "not-a-valid-slug" } });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(
        err instanceof DestinationArgsError,
        "a malformed slug is a bad-args error, not an API error or raw Error",
      );
      assert.match(err.message, /--sandbox/);
      return true;
    },
  );
  // No verify/create ran for an unparseable slug.
  assert.equal(h.calls.filter((c) => c.fn !== "prompt").length, 0);
});

// --- #3: non-404 verify error → DestinationApiError (exit 2) ---
test("non-404 verify failure (403) maps to DestinationApiError, not a raw escape", async () => {
  const h = makeHarness({
    flags: { sandbox: "me/sandbox" },
    verify: () => {
      throw httpError(403);
    },
  });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(
        err instanceof DestinationApiError,
        "a 403 during verify is an API error (exit 2), not a raw error (exit 1)",
      );
      assert.match(err.message, /me\/sandbox/);
      return true;
    },
  );
});

test("non-404 verify failure on --primary also maps to DestinationApiError", async () => {
  const h = makeHarness({
    flags: { primary: true },
    verify: () => {
      throw httpError(500);
    },
  });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => err instanceof DestinationApiError,
  );
});

// --- #7: --create-sandbox without --sandbox is a silent no-op ---
test("--create-sandbox alone (no --sandbox, non-TTY, no default) → bad-args, never creates", async () => {
  const h = makeHarness({
    flags: { createSandbox: true },
    isTTY: false,
    create: (req) => ({ owner: req.owner, repo: req.name }),
  });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => err instanceof DestinationArgsError,
  );
  assert.ok(
    !h.calls.some((c) => c.fn === "create"),
    "--create-sandbox is inert without --sandbox; the creator is never called",
  );
});

test("saved default 404 — non-interactive throws exit-2, interactive re-prompts", async () => {
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

test("non-primary exists-but-not-writable — write-permission message, non-interactive exit-2 / interactive re-prompt", async () => {
  // Non-interactive: exit-2 with write-permission message naming repo + capability.
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

test("primary not writable — write-permission message before clone, non-interactive exit-2 / interactive re-prompt", async () => {
  // Non-interactive (--primary): exit-2 with write-permission message, no clone/push.
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

// The resolver never clones/pushes (that is index.ts's job), so the earlier
// version of this test could never fail: `firstWrite` was always -1. We make it
// non-vacuous by driving the create-if-missing path — `create` IS a write the
// resolver performs — and asserting a verify is recorded strictly before it.
test("verify runs before the create write (non-vacuous call order)", async () => {
  let created = false;
  const h = makeHarness({
    flags: { sandbox: "me/new", createSandbox: true },
    // Pre-create: report missing so the resolver proceeds to create. Post-create
    // re-probe: report writable so the run succeeds (re-probe covered elsewhere).
    verify: () => (created ? { exists: true, canPush: true } : { exists: false, canPush: false }),
    create: (req) => {
      created = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  await resolveDestination(SOURCE, h.resolvers);
  const firstVerify = h.calls.findIndex((c) => c.fn === "verify");
  const firstCreate = h.calls.findIndex((c) => c.fn === "create");
  assert.ok(firstVerify >= 0, "a verify call was recorded");
  assert.ok(firstCreate >= 0, "a create write was recorded (assertion is live)");
  assert.ok(
    firstVerify < firstCreate,
    "verify must precede the create write",
  );
});

test("primary fails + saved writable sandbox known → names it; otherwise omitted", async () => {
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

test("destination ≠ source → source never an arg to verify/create/write", async () => {
  const h = makeHarness({
    flags: { sandbox: "me/sandbox" },
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.equal(result.isSandbox, true);
  assertSourceNeverWritten(h.calls);
});

// --- Create paths (supporting the create seam) ---
test("--sandbox X --create-sandbox creates missing X; missing X alone exits 2", async () => {
  // With --create-sandbox: missing → create + use (post-create re-probe writable).
  {
    let created = false;
    const h = makeHarness({
      flags: { sandbox: "me/new", createSandbox: true },
      verify: () => (created ? { exists: true, canPush: true } : { exists: false, canPush: false }),
      create: (req) => {
        created = true;
        return { owner: req.owner, repo: req.name };
      },
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

// --- Sandbox creation wrapper (makeSandboxCreator + createPrivateRepo) ---

/** An HTTP-status-bearing error shaped like an Octokit failure. */
function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** A recorded call against the fake Octokit's create surface. */
interface FakeOctokitCall {
  method:
    | "getAuthenticated"
    | "createForAuthenticatedUser"
    | "createInOrg";
  args: unknown;
}

/**
 * Build a fake Octokit exposing only the methods the creation wrapper uses.
 * Records each call. `authedLogin` is the login `users.getAuthenticated` reports;
 * `failStatus` (if set) makes the create call throw that HTTP status.
 */
function makeFakeOctokit(opts: {
  authedLogin: string;
  failStatus?: number;
}): { octokit: Octokit; calls: FakeOctokitCall[] } {
  const calls: FakeOctokitCall[] = [];
  const fake = {
    users: {
      getAuthenticated: async () => {
        calls.push({ method: "getAuthenticated", args: undefined });
        return { data: { login: opts.authedLogin } };
      },
    },
    repos: {
      createForAuthenticatedUser: async (args: unknown) => {
        calls.push({ method: "createForAuthenticatedUser", args });
        if (opts.failStatus !== undefined) throw httpError(opts.failStatus);
        const a = args as { name: string };
        return {
          data: { name: a.name, owner: { login: opts.authedLogin } },
        };
      },
      createInOrg: async (args: unknown) => {
        calls.push({ method: "createInOrg", args });
        if (opts.failStatus !== undefined) throw httpError(opts.failStatus);
        const a = args as { org: string; name: string };
        return { data: { name: a.name, owner: { login: a.org } } };
      },
    },
  };
  return { octokit: fake as unknown as Octokit, calls };
}

test("personal-account owner → createForAuthenticatedUser, private", async () => {
  const { octokit, calls } = makeFakeOctokit({ authedLogin: "me" });
  const create = makeSandboxCreator(octokit);
  const result = await create({ owner: "me", name: "pr-backtest-sandbox" });

  assert.deepEqual(result, { owner: "me", repo: "pr-backtest-sandbox" });
  // Authenticated-user create was used (NOT createInOrg).
  const createCall = calls.find(
    (c) => c.method === "createForAuthenticatedUser",
  );
  assert.ok(createCall, "createForAuthenticatedUser was called");
  assert.ok(
    !calls.some((c) => c.method === "createInOrg"),
    "createInOrg not called for a personal account",
  );
  // The recorded create-call args set private: true and a default branch.
  const args = createCall.args as { private: unknown; auto_init: unknown };
  assert.equal(args.private, true, "repo created private");
  assert.equal(args.auto_init, true, "repo auto-initialized");
});

test("org owner → createInOrg, private, owner defaults to source owner", async () => {
  // authed login differs from the requested (source) owner → org route.
  const { octokit, calls } = makeFakeOctokit({ authedLogin: "personal-me" });
  const create = makeSandboxCreator(octokit);
  // Owner is the SOURCE owner (acme) passed by the resolver.
  const result = await create({ owner: "acme", name: "backtest" });

  assert.deepEqual(result, { owner: "acme", repo: "backtest" });
  const createCall = calls.find((c) => c.method === "createInOrg");
  assert.ok(createCall, "createInOrg was called for an org owner");
  assert.ok(
    !calls.some((c) => c.method === "createForAuthenticatedUser"),
    "createForAuthenticatedUser not called for an org",
  );
  const args = createCall.args as {
    org: unknown;
    private: unknown;
    auto_init: unknown;
  };
  assert.equal(args.org, "acme", "created inside the source owner's org");
  assert.equal(args.private, true, "repo created private");
  assert.equal(args.auto_init, true, "repo auto-initialized");
});

test("403 from create → DestinationApiError naming owner + permission, never writes source", async () => {
  const { octokit, calls } = makeFakeOctokit({
    authedLogin: "personal-me",
    failStatus: 403,
  });
  const create = makeSandboxCreator(octokit);
  await assert.rejects(
    () => create({ owner: SOURCE.owner, name: "backtest" }),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /acme/); // names the owner
      assert.match(err.message, /permission/i); // names the missing permission
      return true;
    },
  );
  // The wrapper attempted to create under the org owner — it never targeted any
  // repo as a write fallback (only the org-create + getAuthenticated calls ran).
  assert.ok(
    calls.every(
      (c) =>
        c.method === "getAuthenticated" || c.method === "createInOrg",
    ),
    "no unexpected calls after a 403",
  );
});

test("403 — non-interactive exits 2; interactive re-prompts", async () => {
  const failingCreate = makeSandboxCreator(
    makeFakeOctokit({ authedLogin: "personal-me", failStatus: 403 }).octokit,
  );

  // Non-interactive: --sandbox acme/new --create-sandbox, missing → create 403 → exit 2.
  {
    const calls: RecordedCall[] = [];
    const resolvers: DestinationResolvers = {
      getFlags: () => ({ sandbox: "acme/new", createSandbox: true }),
      getDefaultDestination: () => undefined,
      getIsTTY: () => false,
      verifyDestination: async (owner, repo) => {
        calls.push({ fn: "verify", args: [owner, repo] });
        return { exists: false, canPush: false };
      },
      createSandbox: async (req) => {
        calls.push({ fn: "create", args: [req.owner, req.name] });
        return failingCreate(req);
      },
      prompt: async () => {
        throw new Error("prompt should not be called non-interactively");
      },
    };
    await assert.rejects(
      () => resolveDestination(SOURCE, resolvers),
      (err: unknown) => {
        assert.ok(err instanceof DestinationApiError);
        assert.match(err.message, /acme/);
        assert.match(err.message, /permission/i);
        return true;
      },
    );
    // Source never written: only acme/new was the create target, source acme/api never.
    assertSourceNeverWritten(calls);
  }

  // Interactive: create-sandbox 403 → re-present the menu, then pick primary (writable).
  {
    let promptCount = 0;
    const calls: RecordedCall[] = [];
    const resolvers: DestinationResolvers = {
      getFlags: () => ({}),
      getDefaultDestination: () => undefined,
      getIsTTY: () => true,
      verifyDestination: async (owner, repo) => {
        calls.push({ fn: "verify", args: [owner, repo] });
        return { exists: true, canPush: true };
      },
      createSandbox: async (req) => {
        calls.push({ fn: "create", args: [req.owner, req.name] });
        return failingCreate(req); // always 403
      },
      prompt: async (choices) => {
        calls.push({ fn: "prompt", args: [choices] });
        promptCount += 1;
        return promptCount === 1
          ? { kind: "org-sandbox", repo: { owner: SOURCE.owner, repo: "pr-backtest-sandbox" } }
          : { kind: "primary", repo: SOURCE };
      },
    };
    const result = await resolveDestination(SOURCE, resolvers);
    assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
    assert.ok(promptCount >= 2, "menu re-presented after create 403");
  }
});

test("creation wrapper receives octokit, never a token; no token in args", async () => {
  // makeSandboxCreator's parameter is an Octokit instance, not a string token.
  // We pass a fake octokit; the request carries only owner + name (no token).
  const { octokit, calls } = makeFakeOctokit({ authedLogin: "me" });
  const create = makeSandboxCreator(octokit);
  await create({ owner: "me", name: "sbx" });
  // No recorded call arg contains anything resembling a token; the create call
  // args are exactly { name, private, auto_init } — no auth/token field.
  const createCall = calls.find(
    (c) => c.method === "createForAuthenticatedUser",
  );
  assert.ok(createCall);
  const args = createCall.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), [
    "auto_init",
    "name",
    "private",
  ]);
});

// Interactive prompt — the real prompts impl.
// `prompts.inject([...])` feeds scripted answers, so these run with no TTY.

/** Point config at a fresh temp dir via XDG_CONFIG_HOME and return it. */
function useTempConfigHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prbt-dest-"));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

/** Choice set the resolver builds when a default IS saved. */
const SAVED_CHOICES: DestinationChoice[] = [
  { kind: "primary", repo: { owner: "acme", repo: "api" } },
  { kind: "saved-sandbox", repo: { owner: "me", repo: "sandbox" } },
  { kind: "org-sandbox", repo: { owner: "acme", repo: "pr-backtest-sandbox" } },
  { kind: "personal-sandbox", repo: { owner: "me", repo: "pr-backtest-sandbox" } },
  { kind: "different-repo" },
];

/** Choice set the resolver builds when NO default is saved. */
const NO_SAVED_CHOICES: DestinationChoice[] = [
  { kind: "primary", repo: { owner: "acme", repo: "api" } },
  { kind: "org-sandbox", repo: { owner: "acme", repo: "pr-backtest-sandbox" } },
  { kind: "personal-sandbox", repo: { owner: "me", repo: "pr-backtest-sandbox" } },
  { kind: "different-repo" },
];

/** A prompt that never touches real config or a real TTY. */
function makeTestPrompt(saved?: { saved: SavedDestination[] }) {
  return makeInteractivePrompt({
    isTTY: () => true,
    saveDefault: (dest) => saved?.saved.push(dest),
  });
}

test("saved-default menu — picking saved-sandbox returns that kind + repo", async () => {
  prompts.inject(["saved-sandbox"]);
  const prompt = makeTestPrompt();
  const sel = await prompt(SAVED_CHOICES);
  assert.equal(sel.kind, "saved-sandbox");
  assert.deepEqual(sel.repo, { owner: "me", repo: "sandbox" });
  // saved-sandbox is already the default: no remember prompt fired (no extra inject consumed).
});

test("no-default menu — picking org-sandbox returns org-sandbox kind, owner fixed to source", async () => {
  // select org-sandbox; then ONLY a name sub-prompt (accept default via "").
  prompts.inject(["org-sandbox", ""]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.equal(sel.kind, "org-sandbox");
  // Owner is FIXED to the source owner (not prompted); name defaults.
  assert.deepEqual(sel.repo, { owner: "acme", repo: "pr-backtest-sandbox" });
});

test("no-default menu — picking personal-sandbox returns personal-sandbox kind, owner fixed to login", async () => {
  // select personal-sandbox; then ONLY a name sub-prompt (accept default via "").
  prompts.inject(["personal-sandbox", ""]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.equal(sel.kind, "personal-sandbox");
  // Owner is FIXED to the authenticated login carried on the choice; name defaults.
  assert.deepEqual(sel.repo, { owner: "me", repo: "pr-backtest-sandbox" });
});

test("interactive: picking primary returns primary kind + the source repo", async () => {
  prompts.inject(["primary"]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.deepEqual(sel, { kind: "primary", repo: { owner: "acme", repo: "api" } });
});

// --- different-repo collects + parses a slug ---
test("different-repo prompts for a slug, parses it, returns it in repo", async () => {
  // select different-repo; enter slug; decline remember.
  prompts.inject(["different-repo", "you/other", false]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.equal(sel.kind, "different-repo");
  assert.deepEqual(sel.repo, { owner: "you", repo: "other" });
});

// --- bad slug re-prompts ---
test("different-repo re-prompts on an unparseable slug", async () => {
  // first slug is invalid (no slash), second is valid; decline remember.
  prompts.inject(["different-repo", "not-a-slug", "you/other", false]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.equal(sel.kind, "different-repo");
  assert.deepEqual(sel.repo, { owner: "you", repo: "other" });
});

// --- remember=yes persists via the merge writer ---
test("remember-yes triggers persistence via mergeConfig", async () => {
  useTempConfigHome();
  // Use the REAL saveDefault (mergeConfig) by not injecting one.
  prompts.inject(["different-repo", "you/other", true]);
  const prompt = makeInteractivePrompt({ isTTY: () => true });
  await prompt(NO_SAVED_CHOICES);
  // mergeConfig wrote the default destination; read it back.
  const cfg = readConfig();
  assert.deepEqual(cfg?.defaultDestination, { owner: "you", repo: "other" });
});

// --- choosing the already-saved default does NOT re-offer remember ---
test("different-repo equal to the saved default skips the remember prompt", async () => {
  const saved = { saved: [] as SavedDestination[] };
  // Only the select + slug are injected; if a remember prompt fired it would
  // consume a non-existent injection and abort.
  prompts.inject(["different-repo", "me/sandbox"]);
  const prompt = makeTestPrompt(saved);
  const sel = await prompt(SAVED_CHOICES);
  assert.equal(sel.kind, "different-repo");
  assert.deepEqual(sel.repo, { owner: "me", repo: "sandbox" });
  assert.equal(saved.saved.length, 0, "no persistence for an already-default repo");
});

// --- sandbox creation: the user edits ONLY the name; the owner is FIXED ---
test("interactive: org-sandbox lets the user edit only the name, owner stays fixed", async () => {
  prompts.inject(["org-sandbox", "custom-name"]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.equal(sel.kind, "org-sandbox");
  // Owner is NOT prompted — it stays the fixed source owner from the choice.
  assert.deepEqual(sel.repo, { owner: "acme", repo: "custom-name" });
});

test("interactive: personal-sandbox lets the user edit only the name, owner stays the login", async () => {
  prompts.inject(["personal-sandbox", "custom-name"]);
  const prompt = makeTestPrompt();
  const sel = await prompt(NO_SAVED_CHOICES);
  assert.equal(sel.kind, "personal-sandbox");
  assert.deepEqual(sel.repo, { owner: "me", repo: "custom-name" });
});

// --- sandbox creation: aborting the name prompt cancels ---
test("interactive: aborting the sandbox name prompt throws bad-args", async () => {
  // select org-sandbox, then Ctrl-C (undefined) at the name prompt.
  prompts.inject(["org-sandbox", undefined]);
  const prompt = makeTestPrompt();
  await assert.rejects(
    () => prompt(NO_SAVED_CHOICES),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

// --- sandbox creation: a create kind with no fixed owner is a builder bug ---
test("interactive: org-sandbox with no fixed owner on the choice throws bad-args", async () => {
  // A choice whose org-sandbox carries no repo → no fixed owner.
  const choices: DestinationChoice[] = [
    { kind: "primary", repo: { owner: "acme", repo: "api" } },
    { kind: "org-sandbox" },
    { kind: "different-repo" },
  ];
  // The select picks org-sandbox; no name prompt is reached.
  prompts.inject(["org-sandbox"]);
  const prompt = makeTestPrompt();
  await assert.rejects(
    () => prompt(choices),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

// --- non-TTY guard ---
test("interactive: throws a clear bad-args error when stdin is not a TTY", async () => {
  const prompt = makeInteractivePrompt({ isTTY: () => false });
  await assert.rejects(
    () => prompt(NO_SAVED_CHOICES),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

// --- abort (Ctrl-C at the select) ---
test("interactive: aborting the menu throws a bad-args error", async () => {
  // Injecting `undefined` simulates an aborted prompt.
  prompts.inject([undefined]);
  const prompt = makeInteractivePrompt({ isTTY: () => true });
  await assert.rejects(
    () => prompt(NO_SAVED_CHOICES),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

// =====================================================================
// menu-and-create-routing — VAL-MENU / VAL-CREATE / VAL-PROBE coverage
// =====================================================================

/** Capture the choice kinds (in order) the resolver hands the prompt seam. */
function capturedKinds(calls: RecordedCall[]): DestinationChoiceKind[] {
  const promptCall = calls.find((c) => c.fn === "prompt");
  assert.ok(promptCall, "the prompt seam was invoked");
  const choices = promptCall.args[0] as DestinationChoice[];
  return choices.map((c) => c.kind);
}

// --- VAL-MENU-001: exact ordered kind set with NO saved default ---
test("VAL-MENU-001: no saved default → primary, org-sandbox, personal-sandbox, different-repo in order", async () => {
  const h = makeHarness({
    isTTY: true,
    login: "me",
    verify: () => ({ exists: true, canPush: true }),
    // Pick primary so the resolver returns; we only assert the menu it built.
    prompt: () => ({ kind: "primary", repo: SOURCE }),
  });
  await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(capturedKinds(h.calls), [
    "primary",
    "org-sandbox",
    "personal-sandbox",
    "different-repo",
  ]);
  // org-sandbox owner is the source owner; personal-sandbox owner is the login.
  const choices = h.calls.find((c) => c.fn === "prompt")!.args[0] as DestinationChoice[];
  assert.equal(choices.find((c) => c.kind === "org-sandbox")?.repo?.owner, "acme");
  assert.equal(
    choices.find((c) => c.kind === "personal-sandbox")?.repo?.owner,
    "me",
  );
});

// --- VAL-MENU-002: saved default adds a saved-sandbox row below primary ---
test("VAL-MENU-002: saved default → saved-sandbox row immediately below primary; others remain", async () => {
  const h = makeHarness({
    isTTY: true,
    login: "me",
    saved: { owner: "me", repo: "sandbox" },
    verify: () => ({ exists: true, canPush: true }),
    prompt: () => ({ kind: "primary", repo: SOURCE }),
  });
  await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(capturedKinds(h.calls), [
    "primary",
    "saved-sandbox",
    "org-sandbox",
    "personal-sandbox",
    "different-repo",
  ]);
});

// --- graceful degradation: no login seam (or it throws) omits personal-sandbox ---
test("personal-sandbox row omitted when getAuthenticatedLogin is absent", async () => {
  const h = makeHarness({
    isTTY: true,
    // no `login` → seam undefined
    verify: () => ({ exists: true, canPush: true }),
    prompt: () => ({ kind: "primary", repo: SOURCE }),
  });
  await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(capturedKinds(h.calls), [
    "primary",
    "org-sandbox",
    "different-repo",
  ]);
});

test("personal-sandbox row omitted when getAuthenticatedLogin throws (degrade gracefully)", async () => {
  const h = makeHarness({
    isTTY: true,
    login: "throw",
    verify: () => ({ exists: true, canPush: true }),
    prompt: () => ({ kind: "primary", repo: SOURCE }),
  });
  await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(capturedKinds(h.calls), [
    "primary",
    "org-sandbox",
    "different-repo",
  ]);
});

// --- VAL-MENU-003 + VAL-CREATE-001 (org): owner is the SOURCE owner, classified per sameRepo ---
test("VAL-MENU-003 / VAL-CREATE-001: org-sandbox resolves+creates under the SOURCE owner", async () => {
  const h = makeHarness({
    isTTY: true,
    login: "me",
    // create reports back what it was asked to create; post-create probe is writable.
    create: (req) => ({ owner: req.owner, repo: req.name }),
    verify: () => ({ exists: true, canPush: true }),
    prompt: () => ({
      kind: "org-sandbox",
      repo: { owner: SOURCE.owner, repo: "pr-backtest-sandbox" },
    }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  // Owner is the source owner; repo name differs → classified isSandbox: true.
  assert.deepEqual(result, {
    owner: "acme",
    repo: "pr-backtest-sandbox",
    isSandbox: true,
  });
  // The create-call owner is the SOURCE owner (VAL-CREATE-001).
  const createCall = h.calls.find((c) => c.fn === "create");
  assert.deepEqual(createCall?.args, ["acme", "pr-backtest-sandbox"]);
});

// --- VAL-MENU-004 + VAL-CREATE-001 (personal): owner is the AUTHENTICATED LOGIN ---
test("VAL-MENU-004 / VAL-CREATE-001: personal-sandbox resolves+creates under the LOGIN, cross-owner", async () => {
  const h = makeHarness({
    isTTY: true,
    login: "me",
    create: (req) => ({ owner: req.owner, repo: req.name }),
    verify: () => ({ exists: true, canPush: true }),
    prompt: () => ({
      kind: "personal-sandbox",
      repo: { owner: "me", repo: "pr-backtest-sandbox" },
    }),
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  // Owner is the login (me), differs from the source owner (acme) → cross-owner sandbox.
  assert.deepEqual(result, {
    owner: "me",
    repo: "pr-backtest-sandbox",
    isSandbox: true,
  });
  // The create-call owner is the AUTHENTICATED LOGIN, never the source/primary owner.
  const createCall = h.calls.find((c) => c.fn === "create");
  assert.deepEqual(createCall?.args, ["me", "pr-backtest-sandbox"]);
  assertSourceNeverWritten(h.calls);
});

// --- VAL-PROBE-002: existing-repo write probe reads permissions.push (canPush) ---
test("VAL-PROBE-002: existing repo's write probe reads permissions.push (canPush=false blocks)", async () => {
  // The injected verify reports canPush:false for the existing repo → not writable.
  const h = makeHarness({
    flags: { sandbox: "me/exists" },
    verify: () => ({ exists: true, canPush: false }),
  });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /me\/exists/);
      assert.match(err.message, /Contents:write \+ Pull requests:write/);
      return true;
    },
  );
});

// --- VAL-PROBE-003 (non-interactive): post-create re-probe of --sandbox X --create-sandbox ---
test("VAL-PROBE-003: --sandbox X --create-sandbox re-probes after create; not-writable → exit 2, no fall-through", async () => {
  let createdYet = false;
  const h = makeHarness({
    flags: { sandbox: "me/new", createSandbox: true },
    // First verify (pre-create) reports missing; the post-create re-probe reports
    // exists-but-not-writable. Drive that off whether create has happened.
    verify: () =>
      createdYet
        ? { exists: true, canPush: false }
        : { exists: false, canPush: false },
    create: (req) => {
      createdYet = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  await assert.rejects(
    () => resolveDestination(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /me\/new/);
      assert.match(err.message, /Contents:write \+ Pull requests:write/);
      return true;
    },
  );
  // Create happened, then a SECOND verify (the re-probe) ran AFTER it.
  const idxCreate = h.calls.findIndex((c) => c.fn === "create");
  const verifyIdxs = h.calls
    .map((c, i) => (c.fn === "verify" ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(idxCreate >= 0, "create ran");
  assert.ok(
    verifyIdxs.some((i) => i > idxCreate),
    "a write re-probe (verify) ran AFTER the create",
  );
  assertSourceNeverWritten(h.calls);
});

test("VAL-PROBE-003: --sandbox X --create-sandbox proceeds when the post-create re-probe is writable", async () => {
  let createdYet = false;
  const h = makeHarness({
    flags: { sandbox: "me/new", createSandbox: true },
    verify: () =>
      createdYet
        ? { exists: true, canPush: true }
        : { exists: false, canPush: false },
    create: (req) => {
      createdYet = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  const result = await resolveDestination(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "me", repo: "new", isSandbox: true });
});

// --- VAL-PROBE-003 (interactive): post-create re-probe of a create kind ---
test("VAL-PROBE-003: interactive create not-writable post-create → re-present menu, never push the source", async () => {
  let promptCount = 0;
  let createdYet = false;
  const calls: RecordedCall[] = [];
  const resolvers: DestinationResolvers = {
    getFlags: () => ({}),
    getDefaultDestination: () => undefined,
    getIsTTY: () => true,
    getAuthenticatedLogin: async () => "me",
    verifyDestination: async (owner, repo) => {
      calls.push({ fn: "verify", args: [owner, repo] });
      // The created personal sandbox re-probes not-writable; the primary (acme) is writable.
      if (owner === "me") {
        return createdYet
          ? { exists: true, canPush: false }
          : { exists: false, canPush: false };
      }
      return { exists: true, canPush: true };
    },
    createSandbox: async (req) => {
      calls.push({ fn: "create", args: [req.owner, req.name] });
      createdYet = true;
      return { owner: req.owner, repo: req.name };
    },
    prompt: async (choices) => {
      calls.push({ fn: "prompt", args: [choices] });
      promptCount += 1;
      return promptCount === 1
        ? { kind: "personal-sandbox", repo: { owner: "me", repo: "pr-backtest-sandbox" } }
        : { kind: "primary", repo: SOURCE };
    },
  };
  const result = await resolveDestination(SOURCE, resolvers);
  // Fell back to NOTHING automatically — the user re-picked primary on the re-presented menu.
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(promptCount >= 2, "menu re-presented after a non-writable post-create re-probe");
  // The create→re-probe order held: create, then a verify on me/* after it.
  const idxCreate = calls.findIndex((c) => c.fn === "create");
  const reprobe = calls.findIndex(
    (c, i) => i > idxCreate && c.fn === "verify" && c.args[0] === "me",
  );
  assert.ok(reprobe > idxCreate, "re-probe ran after create");
  // The source was never a CREATE target (a verify of primary is legitimate once
  // the user re-picks it; INV-READONLY is about create/push, not the primary probe).
  assert.ok(
    !calls.some((c) => c.fn === "create" && c.args[0] === SOURCE.owner && c.args[1] === SOURCE.repo),
    "source was never a create target",
  );
});

// --- VAL-CREATE-002: both create paths request a private repo (via createPrivateRepo) ---
test("VAL-CREATE-002: org and personal creation both go through createPrivateRepo (private:true)", async () => {
  // org sandbox: owner != authed login → createInOrg, private true.
  {
    const { octokit, calls } = makeFakeOctokit({ authedLogin: "me" });
    const create = makeSandboxCreator(octokit);
    await create({ owner: "acme", name: "pr-backtest-sandbox" });
    const c = calls.find((x) => x.method === "createInOrg");
    assert.ok(c, "org path used createInOrg");
    assert.equal((c.args as { private: unknown }).private, true);
  }
  // personal sandbox: owner == authed login → createForAuthenticatedUser, private true.
  {
    const { octokit, calls } = makeFakeOctokit({ authedLogin: "me" });
    const create = makeSandboxCreator(octokit);
    await create({ owner: "me", name: "pr-backtest-sandbox" });
    const c = calls.find((x) => x.method === "createForAuthenticatedUser");
    assert.ok(c, "personal path used createForAuthenticatedUser");
    assert.equal((c.args as { private: unknown }).private, true);
  }
});

// --- VAL-CREATE-004: interactive create 403 re-prompts; never writes source ---
test("VAL-CREATE-004: interactive personal-sandbox create 403 re-presents the menu, never writes source", async () => {
  const failingCreate = makeSandboxCreator(
    makeFakeOctokit({ authedLogin: "me", failStatus: 403 }).octokit,
  );
  let promptCount = 0;
  const calls: RecordedCall[] = [];
  const resolvers: DestinationResolvers = {
    getFlags: () => ({}),
    getDefaultDestination: () => undefined,
    getIsTTY: () => true,
    getAuthenticatedLogin: async () => "me",
    verifyDestination: async (owner, repo) => {
      calls.push({ fn: "verify", args: [owner, repo] });
      return { exists: true, canPush: true };
    },
    createSandbox: async (req) => {
      calls.push({ fn: "create", args: [req.owner, req.name] });
      return failingCreate(req); // 403
    },
    prompt: async (choices) => {
      calls.push({ fn: "prompt", args: [choices] });
      promptCount += 1;
      return promptCount === 1
        ? { kind: "personal-sandbox", repo: { owner: "me", repo: "pr-backtest-sandbox" } }
        : { kind: "primary", repo: SOURCE };
    },
  };
  const result = await resolveDestination(SOURCE, resolvers);
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
  assert.ok(promptCount >= 2, "menu re-presented after a create 403");
  // The source was never a CREATE target (the only create attempt was me/*).
  assert.ok(
    !calls.some((c) => c.fn === "create" && c.args[0] === SOURCE.owner && c.args[1] === SOURCE.repo),
    "source was never a create target",
  );
});
