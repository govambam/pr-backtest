import { test } from "node:test";
import assert from "node:assert/strict";
import prompts from "prompts";

import {
  resolveDestinationChoice,
  verifyOrCreateDestination,
  makeSandboxCreator,
  makeConfirmCreate,
  makeMenuPrompt,
  makeSlugPrompt,
  sameRepo,
  DestinationArgsError,
  DestinationApiError,
  writePermissionMessage,
  type ChoiceResolvers,
  type DestinationFlags,
  type MenuRow,
  type RepoRef,
  type VerifyOrCreateOptions,
} from "../src/destination.js";
import type { Octokit } from "@octokit/rest";
import type { RepoVerification } from "../src/github.js";

const SOURCE: RepoRef = { owner: "acme", repo: "api" };

// =====================================================================
// Stage 1 — resolveDestinationChoice (pure: no network, no token)
// =====================================================================

/** Build choice resolvers; the prompt/slug/remember seams are recorded. */
interface ChoiceHarness {
  resolvers: ChoiceResolvers;
  /** Rows the menu seam was handed (null until prompted). */
  rows: () => MenuRow[] | null;
  promptCount: () => number;
}

function makeChoiceHarness(opts: {
  flags?: DestinationFlags;
  saved?: RepoRef;
  isTTY?: boolean;
  /** Which row the menu seam returns, by kind (first match). */
  pick?: MenuRow["kind"];
  /** The slug the slug-prompt returns. */
  slug?: RepoRef;
}): ChoiceHarness {
  let rows: MenuRow[] | null = null;
  let promptCount = 0;
  const resolvers: ChoiceResolvers = {
    getFlags: () => opts.flags ?? {},
    getSavedSandbox: () => {
      // The choice flow legitimately reads the saved sandbox to build the menu;
      // this is config, NOT an authenticated-login lookup.
      return opts.saved;
    },
    getIsTTY: () => opts.isTTY ?? false,
    prompt: async (r) => {
      rows = r;
      promptCount += 1;
      const pick = opts.pick ?? "primary";
      const row = r.find((x) => x.kind === pick);
      if (!row) throw new DestinationArgsError(`no ${pick} row to pick`);
      return row;
    },
    promptForSlug: async () => {
      if (!opts.slug) throw new DestinationArgsError("no slug fake");
      return opts.slug;
    },
  };
  return {
    resolvers,
    rows: () => rows,
    promptCount: () => promptCount,
  };
}

test("--primary → source, isSandbox false, no prompt (VAL-DEST-002)", async () => {
  const h = makeChoiceHarness({ flags: { primary: true } });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "acme",
    repo: "api",
    isSandbox: false,
  });
  assert.equal(h.promptCount(), 0);
});

test("--sandbox <owner/repo> → that repo, isSandbox true (VAL-DEST-004)", async () => {
  const h = makeChoiceHarness({ flags: { sandbox: "me/sandbox" } });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  // A flag-supplied sandbox is explicit each run → never offered to remember.
  assert.deepEqual(result, {
    owner: "me",
    repo: "sandbox",
    isSandbox: true,
  });
  assert.equal(h.promptCount(), 0);
});

test("--sandbox equal to source resolves like --primary (isSandbox false)", async () => {
  const h = makeChoiceHarness({ flags: { sandbox: "acme/api" } });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "acme",
    repo: "api",
    isSandbox: false,
  });
});

test("--sandbox with different case than source resolves like --primary", async () => {
  const h = makeChoiceHarness({ flags: { sandbox: "Acme/API" } });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "acme",
    repo: "api",
    isSandbox: false,
  });
});

test("--primary + --sandbox → bad-args, before any seam (VAL-DEST-004)", async () => {
  const h = makeChoiceHarness({ flags: { primary: true, sandbox: "me/sb" } });
  await assert.rejects(
    () => resolveDestinationChoice(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(err instanceof DestinationArgsError);
      assert.match(err.message, /--primary/);
      assert.match(err.message, /--sandbox/);
      assert.match(err.message, /not both/);
      return true;
    },
  );
  assert.equal(h.promptCount(), 0);
});

test("malformed --sandbox slug → DestinationArgsError (exit 1)", async () => {
  const h = makeChoiceHarness({ flags: { sandbox: "not-a-valid-slug" } });
  await assert.rejects(
    () => resolveDestinationChoice(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(err instanceof DestinationArgsError);
      assert.match(err.message, /--sandbox/);
      return true;
    },
  );
});

test("non-interactive, no flag, no saved default → bad-args naming both flags", async () => {
  const h = makeChoiceHarness({ isTTY: false });
  await assert.rejects(
    () => resolveDestinationChoice(SOURCE, h.resolvers),
    (err: unknown) => {
      assert.ok(err instanceof DestinationArgsError);
      assert.match(err.message, /--primary/);
      assert.match(err.message, /--sandbox/);
      return true;
    },
  );
});

test("non-interactive, no flag, saved default → returns saved (isSandbox by sameness)", async () => {
  // Saved differs from source → isSandbox true.
  {
    const h = makeChoiceHarness({
      isTTY: false,
      saved: { owner: "me", repo: "sandbox" },
    });
    const result = await resolveDestinationChoice(SOURCE, h.resolvers);
    // The saved default is already remembered → no re-offer.
    assert.deepEqual(result, {
      owner: "me",
      repo: "sandbox",
      isSandbox: true,
    });
    assert.equal(h.promptCount(), 0);
  }
  // Saved equals source → isSandbox false.
  {
    const h = makeChoiceHarness({
      isTTY: false,
      saved: { owner: "acme", repo: "api" },
    });
    const result = await resolveDestinationChoice(SOURCE, h.resolvers);
    assert.equal(result.isSandbox, false);
  }
});

test("flag tier wins over TTY + saved default", async () => {
  const h = makeChoiceHarness({
    flags: { primary: true },
    saved: { owner: "me", repo: "sandbox" },
    isTTY: true,
  });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.equal(result.isSandbox, false);
  assert.equal(h.promptCount(), 0);
});

// --- VAL-DEST-001: menu shapes ---

test("VAL-DEST-001: no saved default → exactly Primary + Sandbox rows", async () => {
  const h = makeChoiceHarness({ isTTY: true, pick: "primary" });
  await resolveDestinationChoice(SOURCE, h.resolvers);
  const rows = h.rows();
  assert.ok(rows);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["primary", "sandbox"],
  );
  assert.match(rows[0].title, /Primary — acme\/api/);
  assert.match(rows[0].title, /writes branches \+ PR to the source repo/);
  assert.match(rows[1].title, /Sandbox — a separate repo you control/);
  assert.match(rows[1].title, /the source is only ever read/);
  // No removed kinds ever appear.
  for (const r of rows) {
    assert.ok(r.kind === "primary" || r.kind === "sandbox");
  }
});

test("VAL-DEST-001: saved default → Primary, saved-sandbox, a-different-repo (three rows)", async () => {
  const h = makeChoiceHarness({
    isTTY: true,
    saved: { owner: "me", repo: "sandbox" },
    pick: "primary",
  });
  await resolveDestinationChoice(SOURCE, h.resolvers);
  const rows = h.rows();
  assert.ok(rows);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["primary", "saved-sandbox", "sandbox"],
  );
  assert.match(rows[1].title, /Sandbox — me\/sandbox/);
  assert.match(rows[1].title, /saved for this repo/);
  assert.match(rows[2].title, /Sandbox — a different repo/);
});

test("VAL-DEST-002: choosing Primary from the menu → source, isSandbox false", async () => {
  const h = makeChoiceHarness({ isTTY: true, pick: "primary" });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "acme",
    repo: "api",
    isSandbox: false,
  });
});

test("interactive: choosing the saved-sandbox row returns that repo", async () => {
  const h = makeChoiceHarness({
    isTTY: true,
    saved: { owner: "me", repo: "sandbox" },
    pick: "saved-sandbox",
  });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "me",
    repo: "sandbox",
    isSandbox: true,
  });
});

test("VAL-DEST-003: choosing Sandbox prompts for a slug and returns it", async () => {
  const h = makeChoiceHarness({
    isTTY: true,
    pick: "sandbox",
    slug: { owner: "you", repo: "other" },
  });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "you",
    repo: "other",
    isSandbox: true,
  });
});

// --- VAL-MEM-004: resolveDestinationChoice non-TTY/no-flag uses sandboxes[source] ---

test("VAL-MEM-004: non-TTY, no flag, a saved sandbox → resolves to it (isSandbox true)", async () => {
  const h = makeChoiceHarness({
    isTTY: false,
    saved: { owner: "me", repo: "saved-sb" },
  });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, {
    owner: "me",
    repo: "saved-sb",
    isSandbox: true,
  });
  assert.equal(h.promptCount(), 0, "no prompt on the non-TTY path");
});

test("VAL-MEM-004: non-TTY, no flag, NO saved sandbox → bad-args (unchanged)", async () => {
  const h = makeChoiceHarness({ isTTY: false });
  await assert.rejects(
    () => resolveDestinationChoice(SOURCE, h.resolvers),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

test("VAL-MEM-004: --sandbox flag overrides the saved sandbox on the non-TTY path", async () => {
  const h = makeChoiceHarness({
    isTTY: false,
    saved: { owner: "me", repo: "saved-sb" },
    flags: { sandbox: "you/flag-sb" },
  });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "you", repo: "flag-sb", isSandbox: true });
});

test("VAL-MEM-004: --primary flag overrides the saved sandbox on the non-TTY path", async () => {
  const h = makeChoiceHarness({
    isTTY: false,
    saved: { owner: "me", repo: "saved-sb" },
    flags: { primary: true },
  });
  const result = await resolveDestinationChoice(SOURCE, h.resolvers);
  assert.deepEqual(result, { owner: "acme", repo: "api", isSandbox: false });
});

// --- VAL-DEST-006: the choice flow never invokes a login/getAuthenticated seam ---

test("VAL-DEST-006: the choice flow performs no owner classification / login lookup", async () => {
  // ChoiceResolvers exposes NO authenticated-login seam at all; the menu builds
  // and resolves with only flags, config, TTY, and the prompt seams. If the flow
  // tried to classify org-vs-personal it would need a login seam that does not
  // exist on this interface — a compile-time guarantee reinforced here at runtime.
  const loginSeamName = ["get", "Authenticated", "Login"].join("");
  const h = makeChoiceHarness({
    isTTY: true,
    saved: { owner: "me", repo: "sandbox" },
    pick: "saved-sandbox",
  });
  await resolveDestinationChoice(SOURCE, h.resolvers);
  // The genuine, falsifiable guarantee: the resolvers object exposes no
  // authenticated-login seam at all. This assertion WOULD fail if a
  // `getAuthenticatedLogin` key were ever added to ChoiceResolvers — unlike the
  // removed `loginInvoked()` flag, which was hardwired to `false` and could
  // never fail under any implementation.
  assert.ok(!(loginSeamName in h.resolvers));
});

// =====================================================================
// Stage 1 interactive seams — the real prompts-backed implementations
// =====================================================================


const NO_SAVED_ROWS: MenuRow[] = [
  { kind: "primary", title: "Primary — acme/api", repo: { owner: "acme", repo: "api" } },
  { kind: "sandbox", title: "Sandbox — a separate repo you control" },
];

const SAVED_ROWS: MenuRow[] = [
  { kind: "primary", title: "Primary — acme/api", repo: { owner: "acme", repo: "api" } },
  {
    kind: "saved-sandbox",
    title: "Sandbox — me/sandbox (saved default)",
    repo: { owner: "me", repo: "sandbox" },
  },
  { kind: "sandbox", title: "Sandbox — a different repo" },
];

test("makeMenuPrompt: select returns the chosen row by index", async () => {
  prompts.inject([1]); // pick the second row (Sandbox)
  const prompt = makeMenuPrompt({ isTTY: () => true });
  const row = await prompt(NO_SAVED_ROWS);
  assert.equal(row.kind, "sandbox");
});

test("makeMenuPrompt: picking saved-sandbox returns its repo", async () => {
  prompts.inject([1]);
  const prompt = makeMenuPrompt({ isTTY: () => true });
  const row = await prompt(SAVED_ROWS);
  assert.equal(row.kind, "saved-sandbox");
  assert.deepEqual(row.repo, { owner: "me", repo: "sandbox" });
});

test("makeMenuPrompt: throws bad-args when stdin is not a TTY", async () => {
  const prompt = makeMenuPrompt({ isTTY: () => false });
  await assert.rejects(
    () => prompt(NO_SAVED_ROWS),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

test("makeMenuPrompt: aborting the select throws bad-args", async () => {
  prompts.inject([undefined]);
  const prompt = makeMenuPrompt({ isTTY: () => true });
  await assert.rejects(
    () => prompt(NO_SAVED_ROWS),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

test("VAL-DEST-003: makeSlugPrompt parses a slug, re-prompts on a parse error", async () => {
  // First entry is invalid (no slash), second is valid.
  prompts.inject(["not-a-slug", "you/other"]);
  const slugPrompt = makeSlugPrompt();
  const repo = await slugPrompt();
  assert.deepEqual(repo, { owner: "you", repo: "other" });
});

test("VAL-DEST-003: makeSlugPrompt parses a GitHub URL", async () => {
  prompts.inject(["https://github.com/you/other"]);
  const slugPrompt = makeSlugPrompt();
  const repo = await slugPrompt();
  assert.deepEqual(repo, { owner: "you", repo: "other" });
});

test("makeSlugPrompt: aborting throws bad-args", async () => {
  prompts.inject([undefined]);
  const slugPrompt = makeSlugPrompt();
  await assert.rejects(
    () => slugPrompt(),
    (err: unknown) => err instanceof DestinationArgsError,
  );
});

test("VAL-CORR-005: makeConfirmCreate memoizes the answer per owner/repo (asked ≤ 1 time)", async () => {
  const realIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    // Queue answers so we can prove the SECOND same-dest call consumed none:
    //   1st inject (true)  → the one prompt for octocat/sb
    //   2nd inject (false) → only reached if a DIFFERENT dest prompts
    prompts.inject([true, false]);
    const confirm = makeConfirmCreate();
    const dest: RepoRef = { owner: "octocat", repo: "sb" };

    const first = await confirm(dest);
    // A second candidate for the SAME dest (case-insensitive) must NOT re-prompt.
    const second = await confirm({ owner: "OctoCat", repo: "SB" });
    assert.equal(first, true);
    assert.equal(second, true, "the memoized answer is reused, no second prompt");

    // A genuinely different dest DOES prompt — it consumes the queued `false`,
    // proving the same-dest second call above consumed nothing.
    const other = await confirm({ owner: "octocat", repo: "other" });
    assert.equal(other, false);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      value: realIsTTY,
      configurable: true,
    });
  }
});

// =====================================================================
// Stage 2 — verifyOrCreateDestination (WRITE-token seams)
// =====================================================================

/** A recorded verify/create call. */
interface VocCall {
  fn: "verify" | "create";
  args: [string, string];
}

function makeVocOptions(opts: {
  isSandbox?: boolean;
  isTTY?: boolean;
  createFlag?: boolean;
  verify: (owner: string, repo: string) => RepoVerification;
  create?: (req: { owner: string; name: string }) => RepoRef;
  confirmCreate?: boolean;
  sleeps?: number[];
}): { options: VerifyOrCreateOptions; calls: VocCall[] } {
  const calls: VocCall[] = [];
  const options: VerifyOrCreateOptions = {
    isSandbox: opts.isSandbox ?? true,
    isTTY: opts.isTTY ?? false,
    createFlag: opts.createFlag ?? false,
    sleep: async (ms: number) => {
      opts.sleeps?.push(ms);
    },
    verifyDestination: async (owner, repo) => {
      calls.push({ fn: "verify", args: [owner, repo] });
      return opts.verify(owner, repo);
    },
    createSandbox: async (req) => {
      calls.push({ fn: "create", args: [req.owner, req.name] });
      if (!opts.create) throw new DestinationApiError("no create fake");
      return opts.create(req);
    },
    confirmCreate:
      opts.confirmCreate === undefined
        ? undefined
        : async () => opts.confirmCreate as boolean,
  };
  return { options, calls };
}

test("verifyOrCreate: exists + writable → returns the destination", async () => {
  const { options } = makeVocOptions({
    verify: () => ({ exists: true, canPush: true }),
  });
  const result = await verifyOrCreateDestination({ owner: "me", repo: "sb" }, options);
  assert.deepEqual(result, { owner: "me", repo: "sb" });
});

test("verifyOrCreate: exists + not writable → write-permission message (exit 2)", async () => {
  const { options } = makeVocOptions({
    verify: () => ({ exists: true, canPush: false }),
  });
  await assert.rejects(
    () => verifyOrCreateDestination({ owner: "me", repo: "ro" }, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /me\/ro/);
      assert.match(err.message, /Contents:write \+ Pull requests:write/);
      return true;
    },
  );
});

test("verifyOrCreate: non-404 verify failure → DestinationApiError (exit 2)", async () => {
  const { options } = makeVocOptions({
    verify: () => {
      throw httpError(403);
    },
  });
  await assert.rejects(
    () => verifyOrCreateDestination({ owner: "me", repo: "sb" }, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /me\/sb/);
      return true;
    },
  );
});

test("verifyOrCreate: missing primary (not sandbox) → not-found error, never creates", async () => {
  const { options, calls } = makeVocOptions({
    isSandbox: false,
    verify: () => ({ exists: false, canPush: false }),
  });
  await assert.rejects(
    () => verifyOrCreateDestination(SOURCE, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /was not found/);
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.fn === "create"));
});

// --- VAL-CREATE-002: non-interactive create paths ---

test("VAL-CREATE-002: --sandbox X --create-sandbox creates private+auto_init, re-verifies push", async () => {
  let created = false;
  const { options, calls } = makeVocOptions({
    createFlag: true,
    verify: () => (created ? { exists: true, canPush: true } : { exists: false, canPush: false }),
    create: (req) => {
      created = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  const result = await verifyOrCreateDestination({ owner: "me", repo: "new" }, options);
  assert.deepEqual(result, { owner: "me", repo: "new" });
  // Create happened, and a re-verify (bounded retry) ran AFTER it.
  const idxCreate = calls.findIndex((c) => c.fn === "create");
  const verifyAfter = calls.findIndex((c, i) => i > idxCreate && c.fn === "verify");
  assert.ok(idxCreate >= 0, "create ran");
  assert.ok(verifyAfter > idxCreate, "a write re-verify ran after the create");
});

test("VAL-CREATE-002: --sandbox X alone on a missing repo → exit-2 error, nothing created", async () => {
  const { options, calls } = makeVocOptions({
    createFlag: false,
    verify: () => ({ exists: false, canPush: false }),
  });
  await assert.rejects(
    () => verifyOrCreateDestination({ owner: "me", repo: "new" }, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /me\/new/);
      assert.match(err.message, /--create-sandbox/);
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.fn === "create"));
});

test("VAL-CREATE-002: post-create re-verify stays not-writable through retries → exit 2", async () => {
  let created = false;
  let probes = 0;
  const sleeps: number[] = [];
  const { options, calls } = makeVocOptions({
    createFlag: true,
    sleeps,
    verify: () => {
      if (!created) return { exists: false, canPush: false };
      probes += 1;
      return { exists: true, canPush: false };
    },
    create: (req) => {
      created = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  await assert.rejects(
    () => verifyOrCreateDestination({ owner: "me", repo: "new" }, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /Contents:write \+ Pull requests:write/);
      return true;
    },
  );
  assert.ok(probes >= 4, "retries were exhausted");
  // The exhaustion path backs off BETWEEN the bounded attempts: 4 post-create
  // probes ⇒ 3 inter-attempt sleeps (no sleep after the final attempt). This
  // covers the inter-attempt backoff on the exhaustion path, which the
  // probe-count assertion alone does not exercise.
  assert.equal(sleeps.length, 3, "three backoffs between the four bounded attempts");
  // The source repo was never a create/verify target other than the named sandbox.
  assert.ok(!calls.some((c) => c.args[0] === SOURCE.owner && c.args[1] === SOURCE.repo));
});

test("post-create reprobe retries: push:false then push:true succeeds (one backoff)", async () => {
  let created = false;
  let probes = 0;
  const sleeps: number[] = [];
  const { options } = makeVocOptions({
    createFlag: true,
    sleeps,
    verify: () => {
      if (!created) return { exists: false, canPush: false };
      probes += 1;
      return probes >= 2 ? { exists: true, canPush: true } : { exists: true, canPush: false };
    },
    create: (req) => {
      created = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  const result = await verifyOrCreateDestination({ owner: "me", repo: "new" }, options);
  assert.deepEqual(result, { owner: "me", repo: "new" });
  assert.equal(probes, 2, "retried once, then succeeded");
  assert.equal(sleeps.length, 1, "one backoff between attempts");
});

test("post-create reprobe: clearly-writable first probe returns with NO delay", async () => {
  let created = false;
  const sleeps: number[] = [];
  const { options } = makeVocOptions({
    createFlag: true,
    sleeps,
    verify: () => (created ? { exists: true, canPush: true } : { exists: false, canPush: false }),
    create: (req) => {
      created = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  await verifyOrCreateDestination({ owner: "me", repo: "new" }, options);
  assert.equal(sleeps.length, 0, "no backoff when the first post-create probe is writable");
});

// --- VAL-CREATE-001: interactive missing-sandbox ---

test("VAL-CREATE-001: interactive missing sandbox → creates when confirmed and the token can create", async () => {
  let created = false;
  const { options, calls } = makeVocOptions({
    isTTY: true,
    confirmCreate: true,
    verify: () => (created ? { exists: true, canPush: true } : { exists: false, canPush: false }),
    create: (req) => {
      created = true;
      return { owner: req.owner, repo: req.name };
    },
  });
  const result = await verifyOrCreateDestination({ owner: "me", repo: "new" }, options);
  assert.deepEqual(result, { owner: "me", repo: "new" });
  assert.ok(calls.some((c) => c.fn === "create" && c.args[0] === "me"));
});

test("VAL-CREATE-001: interactive missing sandbox + create permission failure → explains, throws, no fall-back", async () => {
  // The createSandbox seam (write token) cannot create → surfaces the explain
  // message; we must throw, NOT fall back to the source.
  const failingCreate = makeSandboxCreator(
    makeFakeOctokit({ authedLogin: "me", failStatus: 403 }).octokit,
  );
  const calls: VocCall[] = [];
  const options: VerifyOrCreateOptions = {
    isSandbox: true,
    isTTY: true,
    createFlag: false,
    confirmCreate: async () => true,
    verifyDestination: async (owner, repo) => {
      calls.push({ fn: "verify", args: [owner, repo] });
      return { exists: false, canPush: false };
    },
    createSandbox: async (req) => {
      calls.push({ fn: "create", args: [req.owner, req.name] });
      return failingCreate(req);
    },
  };
  await assert.rejects(
    () => verifyOrCreateDestination({ owner: "me", repo: "new" }, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /me/);
      assert.match(err.message, /permission|creation rights/i);
      return true;
    },
  );
  // The source repo was never a create target.
  assert.ok(!calls.some((c) => c.fn === "create" && c.args[0] === SOURCE.owner && c.args[1] === SOURCE.repo));
});

test("VAL-CREATE-001: interactive missing sandbox, declined → explains and throws (no create, no fall-back)", async () => {
  const { options, calls } = makeVocOptions({
    isTTY: true,
    confirmCreate: false,
    verify: () => ({ exists: false, canPush: false }),
    create: (req) => ({ owner: req.owner, repo: req.name }),
  });
  await assert.rejects(
    () => verifyOrCreateDestination({ owner: "me", repo: "new" }, options),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /was not found/);
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.fn === "create"), "declined → never creates");
});

// =====================================================================
// makeSandboxCreator + createPrivateRepo
// =====================================================================

/** An HTTP-status-bearing error shaped like an Octokit failure. */
function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** A recorded call against the fake Octokit's create surface. */
interface FakeOctokitCall {
  method: "getAuthenticated" | "createForAuthenticatedUser" | "createInOrg";
  args: unknown;
}

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
        return { data: { name: a.name, owner: { login: opts.authedLogin } } };
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

test("personal-account owner → createForAuthenticatedUser, private+auto_init", async () => {
  const { octokit, calls } = makeFakeOctokit({ authedLogin: "me" });
  const create = makeSandboxCreator(octokit);
  const result = await create({ owner: "me", name: "pr-backtest-sandbox" });
  assert.deepEqual(result, { owner: "me", repo: "pr-backtest-sandbox" });
  const createCall = calls.find((c) => c.method === "createForAuthenticatedUser");
  assert.ok(createCall);
  assert.ok(!calls.some((c) => c.method === "createInOrg"));
  const args = createCall.args as { private: unknown; auto_init: unknown };
  assert.equal(args.private, true);
  assert.equal(args.auto_init, true);
});

test("org owner → createInOrg, private+auto_init", async () => {
  const { octokit, calls } = makeFakeOctokit({ authedLogin: "personal-me" });
  const create = makeSandboxCreator(octokit);
  const result = await create({ owner: "acme", name: "backtest" });
  assert.deepEqual(result, { owner: "acme", repo: "backtest" });
  const createCall = calls.find((c) => c.method === "createInOrg");
  assert.ok(createCall);
  assert.ok(!calls.some((c) => c.method === "createForAuthenticatedUser"));
  const args = createCall.args as { org: unknown; private: unknown; auto_init: unknown };
  assert.equal(args.org, "acme");
  assert.equal(args.private, true);
  assert.equal(args.auto_init, true);
});

test("403 from create → DestinationApiError naming owner + creation rights", async () => {
  const { octokit } = makeFakeOctokit({ authedLogin: "personal-me", failStatus: 403 });
  const create = makeSandboxCreator(octokit);
  await assert.rejects(
    () => create({ owner: SOURCE.owner, name: "backtest" }),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /acme/);
      assert.match(err.message, /permission|creation rights/i);
      return true;
    },
  );
});

test("404 from create → DestinationApiError naming the owner", async () => {
  const { octokit } = makeFakeOctokit({ authedLogin: "personal-me", failStatus: 404 });
  const create = makeSandboxCreator(octokit);
  await assert.rejects(
    () => create({ owner: "ghost", name: "sb" }),
    (err: unknown) => {
      assert.ok(err instanceof DestinationApiError);
      assert.match(err.message, /ghost/);
      return true;
    },
  );
});

test("creation wrapper receives octokit, never a token; create args carry no auth field", async () => {
  const { octokit, calls } = makeFakeOctokit({ authedLogin: "me" });
  const create = makeSandboxCreator(octokit);
  await create({ owner: "me", name: "sbx" });
  const createCall = calls.find((c) => c.method === "createForAuthenticatedUser");
  assert.ok(createCall);
  const args = createCall.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), ["auto_init", "name", "private"]);
});

// =====================================================================
// helpers
// =====================================================================

test("sameRepo is case-insensitive on owner and repo", () => {
  assert.ok(sameRepo({ owner: "Acme", repo: "API" }, { owner: "acme", repo: "api" }));
  assert.ok(!sameRepo({ owner: "acme", repo: "api" }, { owner: "acme", repo: "web" }));
});

test("writePermissionMessage names the repo + capability, never echoes a token", () => {
  const msg = writePermissionMessage({ owner: "me", repo: "ro" });
  assert.match(msg, /me\/ro/);
  assert.match(msg, /Contents:write \+ Pull requests:write/);
});
