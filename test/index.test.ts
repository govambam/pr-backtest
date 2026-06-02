/**
 * Full-flow tests for `runBacktest` (`src/index.ts`), driving the real
 * orchestration through an injected `deps` fake so no network or git runs.
 *
 * The new orchestration order (spec §4): destination FIRST (a local choice, no
 * network), then the WRITE token (verifying/creating the destination), then the
 * READ token (single-PAT reuse / env / saved / paste). No owner logic, no
 * source-visibility probe, no anonymous-source read path.
 *
 * Coverage (the assertions this feature owns):
 *  - VAL-DEST-004 (both flags → exit 1 pre-network)
 *  - VAL-TOKEN-002/005/006/008 (quarantine completes; missing read/write tokens
 *    → exit 1 naming the right env var before any write; read token never reaches
 *    a write op)
 *  - VAL-BRANCH-001/002/003/004 (SHA branch names; two commits → two PRs; open PR
 *    → exit 4 + stdout URL + stderr message, closed does NOT block; 422 backstop)
 *  - VAL-ROUTE-001/002/003 (read vs write Octokit; two-token never crosses;
 *    sandbox never writes the source; no anonymous path)
 *  - VAL-EXIT-001/002 (success + declined → 0; git failure → 3)
 *  - VAL-FLOW-001 (end-to-end sandbox quarantine)
 *
 * `process.exit` is stubbed to throw a tagged error so the test can assert the
 * code without killing the test process.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { Octokit } from "@octokit/rest";
import type { SimpleGit } from "simple-git";

import {
  runBacktest,
  type RunBacktestDeps,
  type RunBacktestOptions,
} from "../src/index.js";
import { UnfetchableCommitError } from "../src/git.js";
import {
  NoSourceTokenNonInteractiveError,
  NoTokenNonInteractiveError,
  resolveReadToken,
  resolveWriteToken,
  type ResolverOctokit,
} from "../src/auth.js";
import { DestinationApiError } from "../src/destination.js";
import { resolveAuthFirstChoice } from "../src/authFirst.js";
import type { InheritedCredential } from "../src/inheritedAuth.js";
import type { RepoRef } from "../src/config.js";
import { redact, setTtyOverride, setVerbose } from "../src/log.js";

/** An `Error` tagged with the exit code a stubbed `process.exit` was given. */
class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
    this.code = code;
  }
}

/** Capture stdout AND stderr separately for the duration of `run`. */
async function capture(
  run: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout, stderr };
}

const PR_URL = "https://github.com/acme/api/pull/123";
const CREATED_URL = "https://github.com/acme/api/pull/451";

const SOURCE_OWNER = "acme";
const SOURCE_REPO = "api";
const SANDBOX_OWNER = "octocat";
const SANDBOX_REPO = "pr-backtest-sandbox";

/** The single token used by single-token runs (write covers read). */
const ONE_TOKEN = "ghp_one_token_value_covers_read_and_write_01";
const READ_TOKEN = "ghp_READ_token_value_must_route_to_source_reads";
const WRITE_TOKEN = "ghp_WRITE_token_value_must_route_to_dest_writes";

/** A fake `Octokit` — the deps never touch it, so an empty object is enough. */
const fakeOctokit = {} as unknown as Octokit;
/** A fake `SimpleGit` — likewise inert; the git deps are stubbed. */
const fakeGit = {} as unknown as SimpleGit;

/**
 * Build a complete `deps` fake plus a shared `order` log. Each git/API
 * collaborator records a stable label so the test can assert the exact
 * orchestration sequence. `overrides` lets a single test swap one collaborator.
 *
 * Defaults model a PRIMARY single-token run: the destination resolves to the
 * source, the write token (`ONE_TOKEN`) both writes the destination and reads
 * the source (single-PAT), so `twoToken` is false.
 */
function makeDeps(
  overrides: Partial<RunBacktestDeps> = {},
  tokenOpts: { writeToken?: string; readToken?: string } = {},
): {
  deps: Partial<RunBacktestDeps>;
  order: string[];
} {
  const writeToken = tokenOpts.writeToken ?? ONE_TOKEN;
  const readToken = tokenOpts.readToken ?? writeToken;
  const order: string[] = [];
  const base: RunBacktestDeps = {
    makeOctokit: () => fakeOctokit,
    resolveDestinationChoice: async (source) => ({
      owner: source.owner,
      repo: source.repo,
      isSandbox: false,
    }),
    verifyOrCreateDestination: async (dest) => {
      order.push("verify-destination");
      return dest;
    },
    resolveWriteToken: async (opts) => {
      // Drive the accept predicate so verifyOrCreateDestination actually runs
      // (it records "verify-destination" in `order`).
      await opts.accept(fakeOctokit, writeToken);
      return { token: writeToken, source: "classic", login: "octocat", fromPaste: false };
    },
    resolveReadToken: async () => ({
      token: readToken,
      source: "classic",
      login: "octocat",
      fromPaste: false,
    }),
    verifyRepo: async () => ({ exists: true, canPush: true }),
    makeSandboxCreator: () => async () => ({ owner: "x", repo: "y" }),
    makeMenuPrompt: () => async (rows) => rows[0]!,
    makeSlugPrompt: () => async () => ({ owner: SANDBOX_OWNER, repo: SANDBOX_REPO }),
    makeRememberPrompt: () => async () => false,
    makeConfirmCreate: () => async () => false,
    readConfig: () => null,
    getPullRequest: async () => {
      order.push("read-pr");
      return { title: "Add retry to fetch", user: "octocat" };
    },
    listPullRequestCommits: async () => [
      {
        sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        parents: [{ sha: "9f3c1a29f3c1a29f3c1a29f3c1a29f3c1a29f3c1" }],
      },
    ],
    getCommitParentSha: async () => "",
    findExistingPr: async () => null,
    createPullRequest: async () => {
      order.push("open-pr");
      return CREATED_URL;
    },
    confirmPlan: async () => true,
    makeTempDir: () => "/tmp/pr-backtest-fake",
    registerCleanup: () => {},
    cleanup: () => {},
    cloneRepo: async () => {
      order.push("clone");
      return fakeGit;
    },
    addSourceRemote: async () => {
      order.push("add-source-remote");
    },
    fetchCommit: async (_git, sha) => {
      order.push(`fetch:${sha.slice(0, 4)}`);
    },
    pushBranchFromSha: async (_git, _sha, branch) => {
      order.push(`push:${branch}`);
    },
  };
  return { deps: { ...base, ...overrides }, order };
}

/** Drive `runBacktest`, translating the stubbed `process.exit` into an ExitError. */
async function run(
  opts: Omit<RunBacktestOptions, "prUrl" | "commit" | "yes"> &
    Partial<Pick<RunBacktestOptions, "prUrl" | "commit" | "yes">>,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const realExit = process.exit;
  (process as { exit: unknown }).exit = (code?: number): never => {
    throw new ExitError(code ?? 0);
  };
  let exit = -1;
  let captured: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  try {
    captured = await capture(async () => {
      try {
        await runBacktest({
          prUrl: PR_URL,
          commit: "initial",
          yes: true,
          ...opts,
        });
      } catch (err) {
        if (err instanceof ExitError) {
          exit = err.code;
          return;
        }
        throw err;
      }
    });
  } finally {
    process.exit = realExit;
  }
  return { ...captured, exit };
}

beforeEach(() => {
  setVerbose(false);
  setTtyOverride(false);
});

afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

// --- VAL-EXIT-001: success + ordering ---------------------------------------

test("on success stdout is exactly the PR URL + newline; trace is on stderr", async () => {
  const { deps } = makeDeps();
  const { stdout, stderr, exit } = await run({ deps });

  assert.equal(exit, 0, "a clean success exits 0");
  assert.equal(stdout, CREATED_URL + "\n", "stdout is exactly the PR URL + \\n");
  assert.ok(!stdout.includes("✓"), "no completion marker on stdout");
  assert.ok(!stdout.includes("Read PR"), "no narration on stdout");
  assert.match(stderr, /Read PR/);
  assert.match(stderr, /✓/);
});

test("wires a confirmCreate seam into verifyOrCreateDestination (interactive create-offer reachability)", async () => {
  // Regression: index.ts must pass a confirmCreate seam, otherwise a TTY user
  // who picks a not-yet-existing sandbox is never offered to create it
  // (verifyOrCreateDestination's interactive branch defaults confirm=false).
  let capturedConfirmCreate: unknown;
  const { deps } = makeDeps({
    verifyOrCreateDestination: async (dest, opts) => {
      capturedConfirmCreate = opts.confirmCreate;
      return dest;
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.equal(
    typeof capturedConfirmCreate,
    "function",
    "verifyOrCreateDestination must receive a confirmCreate seam",
  );
});

test("a default run's stderr shows ✓ completion markers for each operation", async () => {
  const { deps } = makeDeps();
  const { stderr } = await run({ deps });

  assert.match(stderr, /✓ Read PR github\.com\/acme\/api#123/);
  assert.match(stderr, /✓ Verified destination/);
  assert.match(stderr, /✓ Opened backtest PR/);
  assert.match(stderr, /✓ Backtest PR created/);
});

test("the success operation order: destination FIRST, then read, then clone/fetch/push/open", async () => {
  const { deps, order } = makeDeps();
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.deepEqual(order, [
    "verify-destination",
    "read-pr",
    "clone",
    "fetch:9f3c", // base SHA fetched first
    "fetch:a1b2", // head SHA fetched second
    "push:backtest-pr123-a1b2c3d-base",
    "push:backtest-pr123-a1b2c3d-head",
    "open-pr",
  ]);
});

test("VAL-EXIT-001: a declined plan exits 0 with no writes", async () => {
  const writes = { clone: 0, push: 0, create: 0 };
  const { deps } = makeDeps({
    confirmPlan: async () => false,
    cloneRepo: async () => {
      writes.clone += 1;
      return fakeGit;
    },
    pushBranchFromSha: async () => {
      writes.push += 1;
    },
    createPullRequest: async () => {
      writes.create += 1;
      return CREATED_URL;
    },
  });
  const { stdout, stderr, exit } = await run({ deps });
  assert.equal(exit, 0, "a declined plan is a clean exit 0");
  assert.equal(stdout, "", "no PR URL on stdout for a declined run");
  assert.match(stderr, /Aborted: no changes were made\./);
  assert.deepEqual(writes, { clone: 0, push: 0, create: 0 }, "no writes after decline");
});

test("a verbose run is observation-only — same order, same exit", async () => {
  const { deps, order } = makeDeps();
  const { exit } = await run({ deps, verbose: true });
  assert.equal(exit, 0);
  assert.deepEqual(order, [
    "verify-destination",
    "read-pr",
    "clone",
    "fetch:9f3c",
    "fetch:a1b2",
    "push:backtest-pr123-a1b2c3d-base",
    "push:backtest-pr123-a1b2c3d-head",
    "open-pr",
  ]);
});

// --- VAL-EXIT-002: git failure → exit 3 -------------------------------------

test("VAL-EXIT-002: an unfetchable commit maps to exit 3 (git failure)", async () => {
  const { deps } = makeDeps({
    fetchCommit: async (_git, sha, prNumber, remote) => {
      throw new UnfetchableCommitError(sha, prNumber, remote);
    },
  });
  const { stdout, stderr, exit } = await run({ deps });
  assert.equal(exit, 3, "an unfetchable commit is the documented git-failure exit 3");
  assert.equal(stdout, "", "no PR URL on stdout for a failed run");
  assert.match(stderr, /Could not fetch commit/);
});

test("VAL-HONEST-009: index threads the run's real branch names into fetchCommit", async () => {
  // index.ts step 9 names branches backtest-pr<N>-<shortSha>-{head,base} (target
  // short SHA = a1b2c3d). The same names must be threaded into fetchCommit so the
  // unfetchable recovery hint reconnects to the tool's own scheme.
  let captured: { head: string; base: string } | undefined;
  const { deps } = makeDeps({
    fetchCommit: async (_git, _sha, _prNumber, _remote, _token, branches) => {
      if (branches) captured = branches;
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.deepEqual(captured, {
    head: "backtest-pr123-a1b2c3d-head",
    base: "backtest-pr123-a1b2c3d-base",
  });
  // And the message the user would see embeds exactly those names.
  const { buildUnfetchableMessage } = await import("../src/git.js");
  const msg = buildUnfetchableMessage("a1b2c3d", 123, "source", captured!);
  assert.match(msg, /refs\/heads\/backtest-pr123-a1b2c3d-head/);
  assert.match(msg, /refs\/heads\/backtest-pr123-a1b2c3d-base/);
});

test("VAL-EXIT-002: a clone failure maps to exit 3", async () => {
  const { deps } = makeDeps({
    cloneRepo: async () => {
      throw new Error("Failed to clone github.com/acme/api.");
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 3, "a clone failure is exit 3");
});

// --- VAL-DEST-004: both flags → exit 1 BEFORE any network -------------------

test("VAL-DEST-004: --primary AND --sandbox exits 1 before any network call", async () => {
  let networkTouched = false;
  const { deps } = makeDeps({
    resolveDestinationChoice: async () => {
      networkTouched = true;
      return { owner: SOURCE_OWNER, repo: SOURCE_REPO, isSandbox: false };
    },
    resolveWriteToken: async () => {
      networkTouched = true;
      return { token: ONE_TOKEN, source: "classic", login: "x", fromPaste: false };
    },
  });
  const { stderr, exit } = await run({
    deps,
    primary: true,
    sandbox: "octocat/sandbox",
  });
  assert.equal(exit, 1, "both flags is a bad-args exit 1");
  assert.match(stderr, /Pass either --primary or --sandbox, not both\./);
  assert.equal(networkTouched, false, "no token/destination work before the fast-fail");
});

// --- VAL-BRANCH-001/002: SHA-named branches; distinct commits → distinct PRs -

test("VAL-BRANCH-001: branch names embed the short SHA of the target commit", async () => {
  const pushed: string[] = [];
  const { deps } = makeDeps({
    pushBranchFromSha: async (_git, _sha, branch) => {
      pushed.push(branch);
    },
    createPullRequest: async (_octokit, _owner, _repo, head, base) => {
      pushed.push(`head:${head}`, `base:${base}`);
      return CREATED_URL;
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  // target SHA short = a1b2c3d.
  assert.deepEqual(pushed, [
    "backtest-pr123-a1b2c3d-base",
    "backtest-pr123-a1b2c3d-head",
    "head:backtest-pr123-a1b2c3d-head",
    "base:backtest-pr123-a1b2c3d-base",
  ]);
});

test("VAL-BRANCH-002: the same PR at two different commits yields two distinct branch sets", async () => {
  // Two commits in the PR; selecting each (via --commit) yields distinct
  // SHA-named branches, so two backtests never collide.
  const COMMIT_A = "aaaaaaa1111111111111111111111111111111aa";
  const COMMIT_B = "bbbbbbb2222222222222222222222222222222bb";
  const branchSets: string[][] = [];
  for (const sel of [COMMIT_A, COMMIT_B]) {
    const pushed: string[] = [];
    const { deps } = makeDeps({
      listPullRequestCommits: async () => [
        { sha: COMMIT_A, parents: [{ sha: "9f3c1a29f3c1a29f3c1a29f3c1a29f3c1a29f3c1" }] },
        { sha: COMMIT_B, parents: [{ sha: COMMIT_A }] },
      ],
      pushBranchFromSha: async (_git, _s, branch) => {
        pushed.push(branch);
      },
    });
    const { exit } = await run({ deps, commit: sel });
    assert.equal(exit, 0);
    branchSets.push(pushed);
  }
  assert.deepEqual(branchSets[0], [
    "backtest-pr123-aaaaaaa-base",
    "backtest-pr123-aaaaaaa-head",
  ]);
  assert.deepEqual(branchSets[1], [
    "backtest-pr123-bbbbbbb-base",
    "backtest-pr123-bbbbbbb-head",
  ]);
  assert.notDeepEqual(branchSets[0], branchSets[1], "two commits → two distinct branch sets");
});

// --- VAL-BRANCH-003: open dedup → exit 4; closed does NOT block -------------

test("VAL-BRANCH-003: an OPEN backtest PR yields exit 4, URL on stdout, message on stderr", async () => {
  const EXISTING_URL = "https://github.com/acme/api/pull/200";
  const calls = { clone: 0, push: 0, create: 0 };
  const states: Array<"open" | "all"> = [];
  const { deps } = makeDeps({
    findExistingPr: async (_o, _ow, _r, _h, _b, state = "open") => {
      states.push(state);
      return EXISTING_URL;
    },
    cloneRepo: async () => {
      calls.clone += 1;
      return fakeGit;
    },
    pushBranchFromSha: async () => {
      calls.push += 1;
    },
    createPullRequest: async () => {
      calls.create += 1;
      return CREATED_URL;
    },
  });
  const { stdout, stderr, exit } = await run({ deps });

  assert.equal(exit, 4, "an OPEN backtest PR is the documented exit 4");
  assert.equal(stdout, EXISTING_URL + "\n", "the bare URL is the only thing on stdout");
  assert.deepEqual(states, ["open"], "the pre-flight queries OPEN PRs only");
  assert.match(
    stderr,
    /A backtest for acme\/api#123 at commit a1b2c3d already exists: https:\/\/github\.com\/acme\/api\/pull\/200/,
  );
  assert.match(stderr, /To recreate it, close that PR and re-run \(the branch names include the commit SHA\)\./);
  assert.deepEqual(calls, { clone: 0, push: 0, create: 0 }, "no writes when an open PR blocks");
});

test("VAL-BRANCH-003: a CLOSED prior backtest PR does NOT block — the run proceeds", async () => {
  // The pre-flight queries `state: "open"` only, so a closed prior PR returns
  // null and the run proceeds to create a fresh one.
  const { deps, order } = makeDeps({
    findExistingPr: async (_o, _ow, _r, _h, _b, state = "open") =>
      // Model a closed-only prior PR: open → null (does not block).
      state === "open" ? null : "https://github.com/acme/api/pull/200",
  });
  const { stdout, exit } = await run({ deps });
  assert.equal(exit, 0, "a closed prior PR does not block a re-run");
  assert.equal(stdout, CREATED_URL + "\n", "a fresh PR is created");
  assert.ok(order.includes("open-pr"), "the run reached create");
});

// --- VAL-CORR-001: remember-as-default only after a successful run ----------

const REMEMBER_SANDBOX = { owner: SANDBOX_OWNER, repo: SANDBOX_REPO };

/**
 * Build deps for a non-default interactive Sandbox run that flags
 * `offerRemember`, recording every remember-prompt invocation. The recorded
 * array is empty unless the orchestrator actually offers remember.
 */
function makeRememberDeps(
  overrides: Partial<RunBacktestDeps> = {},
): { deps: Partial<RunBacktestDeps>; remembered: RepoRef[] } {
  const remembered: RepoRef[] = [];
  const { deps } = makeDeps(
    {
      resolveDestinationChoice: async () => ({
        owner: SANDBOX_OWNER,
        repo: SANDBOX_REPO,
        isSandbox: true,
        offerRemember: true,
      }),
      // In sandbox mode the source fetch needs a read remote; keep it inert.
      addSourceRemote: async () => {},
      makeRememberPrompt:
        () =>
        async (dest: RepoRef): Promise<void> => {
          remembered.push(dest);
        },
      ...overrides,
    },
    { writeToken: WRITE_TOKEN, readToken: READ_TOKEN },
  );
  return { deps, remembered };
}

test("VAL-CORR-001: a successful non-default Sandbox run offers remember after success", async () => {
  const { deps, remembered } = makeRememberDeps();
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.deepEqual(
    remembered,
    [REMEMBER_SANDBOX],
    "remember is offered exactly once, on the success path",
  );
});

test("VAL-CORR-001: a Sandbox run that fails verify/create never offers remember", async () => {
  const { deps, remembered } = makeRememberDeps({
    // The write resolver's accept rejects every candidate → terminal exit 2,
    // never reaching the success path.
    resolveWriteToken: async () => {
      throw new DestinationApiError("sandbox not writable / cannot create");
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 2, "an unverifiable destination is exit 2");
  assert.deepEqual(
    remembered,
    [],
    "no remember/persist on a non-success exit path",
  );
});

test("VAL-CORR-001: a declined plan never offers remember", async () => {
  const { deps, remembered } = makeRememberDeps({
    confirmPlan: async () => false,
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0, "a decline is a clean exit 0");
  assert.deepEqual(remembered, [], "a decline does not persist a default");
});

test("VAL-CORR-001: a git failure never offers remember", async () => {
  const { deps, remembered } = makeRememberDeps({
    pushBranchFromSha: async () => {
      throw new Error("push failed");
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 3, "a git failure is exit 3");
  assert.deepEqual(remembered, [], "a git failure does not persist a default");
});

// --- VAL-BRANCH-004: 422 backstop -------------------------------------------

test("VAL-BRANCH-004: a 422 with a matching OPEN PR re-queries and exits 4", async () => {
  const EXISTING_URL = "https://github.com/acme/api/pull/200";
  let preflightDone = false;
  const { deps } = makeDeps({
    findExistingPr: async () => {
      // First call is the pre-flight (returns null → proceed); the second is the
      // post-422 re-query (returns the raced URL).
      if (!preflightDone) {
        preflightDone = true;
        return null;
      }
      return EXISTING_URL;
    },
    createPullRequest: async () => {
      const err = new Error("Validation Failed") as Error & { status: number };
      err.status = 422;
      throw err;
    },
  });
  const { stdout, stderr, exit } = await run({ deps });
  assert.equal(exit, 4, "a 422 with a matching PR is exit 4");
  assert.equal(stdout, EXISTING_URL + "\n", "the raced PR URL is on stdout");
  assert.match(stderr, /already exists/);
});

test("VAL-BRANCH-004: a 422 with NO matching PR exits 2 (no-diff message)", async () => {
  const { deps } = makeDeps({
    findExistingPr: async () => null,
    createPullRequest: async () => {
      const err = new Error("Validation Failed") as Error & { status: number };
      err.status = 422;
      throw err;
    },
  });
  const { stderr, exit } = await run({ deps });
  assert.equal(exit, 2, "a 422 with no matching PR is exit 2");
  assert.match(stderr, /no difference between the target commit and its parent/);
});

test("VAL-HONEST-006: a 422 whose re-query REJECTS does not misreport a no-diff", async () => {
  // The pre-flight resolves to null (proceed); createPullRequest 422s; the
  // post-422 re-query itself REJECTS (network/5xx). A failed re-query must NOT be
  // coerced to "no match" → the user must not see the no-diff message.
  let preflightDone = false;
  const { deps } = makeDeps({
    findExistingPr: async () => {
      if (!preflightDone) {
        preflightDone = true;
        return null; // pre-flight: proceed.
      }
      throw new Error("GitHub list PRs failed (502)"); // post-422 re-query rejects.
    },
    createPullRequest: async () => {
      const err = new Error("Validation Failed") as Error & { status: number };
      err.status = 422;
      throw err;
    },
  });
  const { stdout, stderr, exit } = await run({ deps });
  assert.equal(exit, 2, "a failed re-query is still an API error exit 2");
  assert.equal(stdout, "", "no PR URL on stdout for a failed run");
  assert.doesNotMatch(
    stderr,
    /no difference between the target commit and its parent/,
    "a failed re-query must NOT be reported as a no-diff condition",
  );
  assert.match(
    stderr,
    /follow-up check for an existing backtest PR could not complete/,
    "the message says the existence check could not complete",
  );
});

// --- Sandbox write-target invariants (VAL-ROUTE-003) ------------------------

/** A single git/API call that wrote somewhere, tagged with its target repo. */
interface WriteTarget {
  op: string;
  owner: string;
  repo: string;
}

function makeRecordingDeps(overrides: Partial<RunBacktestDeps> = {}): {
  deps: Partial<RunBacktestDeps>;
  writes: WriteTarget[];
  sourceRemote: WriteTarget[];
  fetchRemotes: string[];
} {
  const writes: WriteTarget[] = [];
  const sourceRemote: WriteTarget[] = [];
  const fetchRemotes: string[] = [];
  const { deps: base } = makeDeps({
    cloneRepo: async (owner, repo) => {
      writes.push({ op: "clone", owner, repo });
      return fakeGit;
    },
    addSourceRemote: async (_git, owner, repo) => {
      sourceRemote.push({ op: "add-source-remote", owner, repo });
    },
    fetchCommit: async (_git, _sha, _prNumber, remote = "origin") => {
      fetchRemotes.push(remote);
    },
    pushBranchFromSha: async (_git, _sha, branch) => {
      writes.push({ op: `push:${branch}`, owner: "", repo: "" });
    },
    createPullRequest: async (_octokit, owner, repo) => {
      writes.push({ op: "create", owner, repo });
      return CREATED_URL;
    },
    ...overrides,
  });
  return { deps: base, writes, sourceRemote, fetchRemotes };
}

test("VAL-ROUTE-003: a sandbox run clones + opens against the destination, never the source", async () => {
  const { deps, writes } = makeRecordingDeps({
    resolveDestinationChoice: async () => ({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      isSandbox: true,
    }),
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  const clone = writes.find((w) => w.op === "clone");
  const create = writes.find((w) => w.op === "create");
  assert.deepEqual(
    { owner: clone?.owner, repo: clone?.repo },
    { owner: SANDBOX_OWNER, repo: SANDBOX_REPO },
    "clone targets the destination",
  );
  assert.deepEqual(
    { owner: create?.owner, repo: create?.repo },
    { owner: SANDBOX_OWNER, repo: SANDBOX_REPO },
    "createPullRequest targets the destination",
  );
  assert.ok(
    writes.some((w) => w.op === "push:backtest-pr123-a1b2c3d-head"),
    "the head branch was pushed",
  );
  for (const w of writes) {
    assert.ok(
      !(w.owner === SOURCE_OWNER && w.repo === SOURCE_REPO),
      `the source repo must never be a write target (was for ${w.op})`,
    );
  }
});

test("a sandbox run adds the source remote for the source repo and fetches from it", async () => {
  const { deps, sourceRemote, fetchRemotes } = makeRecordingDeps({
    resolveDestinationChoice: async () => ({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      isSandbox: true,
    }),
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.deepEqual(sourceRemote, [
    { op: "add-source-remote", owner: SOURCE_OWNER, repo: SOURCE_REPO },
  ]);
  assert.deepEqual(fetchRemotes, ["source", "source"]);
});

test("a primary run never adds a source remote and fetches from origin", async () => {
  const { deps, writes, sourceRemote, fetchRemotes } = makeRecordingDeps();
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.deepEqual(sourceRemote, [], "primary mode never adds a source remote");
  assert.deepEqual(fetchRemotes, ["origin", "origin"], "primary mode fetches from origin");
  const clone = writes.find((w) => w.op === "clone");
  assert.deepEqual(
    { owner: clone?.owner, repo: clone?.repo },
    { owner: SOURCE_OWNER, repo: SOURCE_REPO },
    "primary mode clones the source repo (which is the chosen destination)",
  );
});

// --- Per-op token routing: read vs write Octokit + git credential -----------

/** A recorded API call: the op label + the token whose Octokit was passed. */
interface ApiCall {
  op: string;
  token: string;
}
/** A recorded git op: the op label + the token used to authenticate it. */
interface GitCall {
  op: string;
  token: string | undefined;
}

/**
 * Build routing-aware recording deps. `makeOctokit(token)` returns a tagged
 * instance carrying its token so each API dep can record WHICH token's instance
 * it received. `resolveWriteToken` / `resolveReadToken` are stubbed to return the
 * given tokens so a test can force a two-token (distinct) or one-token (identical)
 * run. Each git dep records the token it was handed (the per-op credential seam).
 */
function makeRoutingDeps(opts: {
  readToken: string;
  writeToken: string;
  isSandbox: boolean;
  overrides?: Partial<RunBacktestDeps>;
}): {
  deps: Partial<RunBacktestDeps>;
  apiCalls: ApiCall[];
  gitCalls: GitCall[];
  instances: Map<string, object>;
} {
  const apiCalls: ApiCall[] = [];
  const gitCalls: GitCall[] = [];
  const instances = new Map<string, object>();

  const makeOctokit = ((token: string): Octokit => {
    let inst = instances.get(token);
    if (!inst) {
      inst = { __token: token } as unknown as object;
      instances.set(token, inst);
    }
    return inst as unknown as Octokit;
  }) as unknown as RunBacktestDeps["makeOctokit"];

  const tokenOf = (octokit: unknown): string =>
    (octokit as { __token?: string }).__token ?? "<untagged>";

  const { deps: base } = makeDeps({
    makeOctokit,
    resolveDestinationChoice: async (source) =>
      opts.isSandbox
        ? { owner: SANDBOX_OWNER, repo: SANDBOX_REPO, isSandbox: true }
        : { owner: source.owner, repo: source.repo, isSandbox: false },
    resolveWriteToken: async (o) => {
      // Exercise the accept predicate on the WRITE Octokit (verifies dest).
      await o.accept(makeOctokit(opts.writeToken), opts.writeToken);
      return {
        token: opts.writeToken,
        source: "classic",
        login: "octocat",
        fromPaste: false,
      };
    },
    resolveReadToken: async () => ({
      token: opts.readToken,
      source: "classic",
      login: "octocat",
      fromPaste: false,
    }),
    verifyRepo: async () => ({ exists: true, canPush: true }),
    getPullRequest: async (octokit) => {
      apiCalls.push({ op: "getPullRequest", token: tokenOf(octokit) });
      return { title: "Add retry to fetch", user: "octocat" };
    },
    listPullRequestCommits: async (octokit) => {
      apiCalls.push({ op: "listPullRequestCommits", token: tokenOf(octokit) });
      return [
        {
          sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          parents: [{ sha: "9f3c1a29f3c1a29f3c1a29f3c1a29f3c1a29f3c1" }],
        },
      ];
    },
    getCommitParentSha: async (octokit) => {
      apiCalls.push({ op: "getCommitParentSha", token: tokenOf(octokit) });
      return "";
    },
    findExistingPr: async (octokit) => {
      apiCalls.push({ op: "findExistingPr", token: tokenOf(octokit) });
      return null;
    },
    createPullRequest: async (octokit) => {
      apiCalls.push({ op: "createPullRequest", token: tokenOf(octokit) });
      return CREATED_URL;
    },
    cloneRepo: async (_owner, _repo, token) => {
      gitCalls.push({ op: "clone", token });
      return fakeGit;
    },
    addSourceRemote: async () => {},
    fetchCommit: async (_git, _sha, _prNumber, remote, token) => {
      gitCalls.push({ op: `fetch:${remote}`, token });
    },
    pushBranchFromSha: async (_git, _sha, branch, token) => {
      gitCalls.push({ op: `push:${branch}`, token });
    },
    ...opts.overrides,
  });
  return { deps: base, apiCalls, gitCalls, instances };
}

test("VAL-ROUTE-001: two-token run routes source reads to READ Octokit, dest calls to WRITE Octokit", async () => {
  const { deps, apiCalls } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  const sourceReads = ["getPullRequest", "listPullRequestCommits", "getCommitParentSha"];
  const destCalls = ["findExistingPr", "createPullRequest"];

  for (const call of apiCalls) {
    if (sourceReads.includes(call.op)) {
      assert.equal(call.token, READ_TOKEN, `${call.op} must use the READ Octokit`);
    }
    if (destCalls.includes(call.op)) {
      assert.equal(call.token, WRITE_TOKEN, `${call.op} must use the WRITE Octokit`);
    }
  }
  assert.ok(apiCalls.some((c) => c.op === "getPullRequest" && c.token === READ_TOKEN));
  assert.ok(apiCalls.some((c) => c.op === "createPullRequest" && c.token === WRITE_TOKEN));
});

test("VAL-TEST-017: the getCommitParentSha prefetch fires for a parentless commit and uses the READ Octokit", async () => {
  // Every other fixture sets parents[0], so index.ts's `if (!target.parents[0])`
  // prefetch never runs and the routing assertions filter an empty set. Here the
  // target commit carries NO parent, forcing runBacktest to call
  // getCommitParentSha. We assert it (a) actually fires and (b) is issued via the
  // READ Octokit, never the WRITE one. Routing the prefetch to the write token in
  // src/index.ts (a source read on the write credential — exactly what the suite
  // forbids) makes this test go red.
  const PARENT_SHA = "9f3c1a29f3c1a29f3c1a29f3c1a29f3c1a29f3c1";
  const { deps, apiCalls } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
    overrides: {
      listPullRequestCommits: async (octokit) => {
        apiCalls.push({
          op: "listPullRequestCommits",
          token: (octokit as { __token?: string }).__token ?? "<untagged>",
        });
        return [
          {
            sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            parents: [], // no parent → resolveBase must prefetch via getCommitParentSha
          },
        ];
      },
      getCommitParentSha: async (octokit) => {
        apiCalls.push({
          op: "getCommitParentSha",
          token: (octokit as { __token?: string }).__token ?? "<untagged>",
        });
        return PARENT_SHA; // non-empty so resolveBase succeeds and the run completes
      },
    },
  });
  // Select the parentless commit explicitly: `--commit initial` only matches a
  // commit with exactly one parent, so it would never select a root commit.
  const { exit } = await run({ deps, commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" });
  assert.equal(exit, 0, "the run completes once the parent is prefetched");

  const prefetch = apiCalls.filter((c) => c.op === "getCommitParentSha");
  assert.equal(prefetch.length, 1, "the prefetch fired exactly once");
  assert.equal(
    prefetch[0]!.token,
    READ_TOKEN,
    "the parent prefetch must use the READ Octokit",
  );
  assert.ok(
    !apiCalls.some((c) => c.op === "getCommitParentSha" && c.token === WRITE_TOKEN),
    "the parent prefetch must NEVER use the WRITE Octokit",
  );
});

test("VAL-ROUTE-002: source-remote fetch uses READ token; clone + push use WRITE token", async () => {
  const { deps, gitCalls } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  const clone = gitCalls.find((c) => c.op === "clone");
  assert.equal(clone?.token, WRITE_TOKEN, "clone authenticates with the WRITE token");
  for (const c of gitCalls.filter((g) => g.op === "fetch:source")) {
    assert.equal(c.token, READ_TOKEN, "the source fetch authenticates with the READ token");
  }
  for (const c of gitCalls.filter((g) => g.op.startsWith("push:"))) {
    assert.equal(c.token, WRITE_TOKEN, "every push authenticates with the WRITE token");
  }
  assert.ok(gitCalls.some((c) => c.op === "fetch:source"), "the source fetch happened");
});

test("VAL-ROUTE-003: identical tokens construct exactly one Octokit and one git credential", async () => {
  const { deps, gitCalls, instances } = makeRoutingDeps({
    readToken: WRITE_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.equal(instances.size, 1, "one token → exactly one Octokit instance");
  for (const c of gitCalls) {
    assert.equal(c.token, WRITE_TOKEN, `${c.op} uses the single token`);
  }
});

test("VAL-TOKEN-008 + VAL-ROUTE-002: read token never authenticates a write; write token never the source fetch/read", async () => {
  const { deps, apiCalls, gitCalls } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  // The READ token is never the clone/push credential, nor the create/find Octokit.
  for (const c of gitCalls.filter((g) => g.op === "clone" || g.op.startsWith("push:"))) {
    assert.notEqual(c.token, READ_TOKEN, `${c.op} must never use the READ token`);
  }
  for (const c of apiCalls.filter((a) => a.op === "createPullRequest" || a.op === "findExistingPr")) {
    assert.notEqual(c.token, READ_TOKEN, `${c.op} must never use the READ Octokit`);
  }
  // The WRITE token never authenticates the source fetch or a source read.
  for (const c of gitCalls.filter((g) => g.op === "fetch:source")) {
    assert.notEqual(c.token, WRITE_TOKEN, "the source fetch must never use the WRITE token");
  }
  for (const c of apiCalls.filter((a) =>
    ["getPullRequest", "listPullRequestCommits", "getCommitParentSha"].includes(a.op),
  )) {
    assert.notEqual(c.token, WRITE_TOKEN, `${c.op} must never use the WRITE Octokit`);
  }
});

test("VAL-ROUTE-003: source owner/repo is never a push or createPullRequest target (cross-owner)", async () => {
  const writes: WriteTarget[] = [];
  const { deps } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
    overrides: {
      cloneRepo: async (owner, repo) => {
        writes.push({ op: "clone", owner, repo });
        return fakeGit;
      },
      pushBranchFromSha: async (_git, _sha, branch) => {
        writes.push({ op: `push:${branch}`, owner: "", repo: "" });
      },
      createPullRequest: async (_octokit, owner, repo) => {
        writes.push({ op: "create", owner, repo });
        return CREATED_URL;
      },
    },
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  for (const w of writes) {
    assert.ok(
      !(w.owner === SOURCE_OWNER && w.repo === SOURCE_REPO),
      `the source repo must never be a push/create target (was for ${w.op})`,
    );
  }
  const create = writes.find((w) => w.op === "create");
  assert.deepEqual(
    { owner: create?.owner, repo: create?.repo },
    { owner: SANDBOX_OWNER, repo: SANDBOX_REPO },
  );
});

// --- VAL-TOKEN-002: quarantine completes ------------------------------------

test("VAL-TOKEN-002 / VAL-FLOW-001: a sandbox run with a read-only source token + write dest token completes", async () => {
  // The read token (READ_TOKEN) only reads the source; the write token
  // (WRITE_TOKEN) writes the destination. End-to-end: destination chosen first,
  // SHA-named branches, source only ever read.
  const { deps, gitCalls, apiCalls } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
  });
  const { stdout, exit } = await run({ deps });
  assert.equal(exit, 0, "the quarantine run completes");
  assert.equal(stdout, CREATED_URL + "\n");

  // The read-only token authenticates ONLY the source reads + the source fetch.
  for (const c of gitCalls.filter((g) => g.token === READ_TOKEN)) {
    assert.equal(c.op, "fetch:source", "the READ token only authenticates the source fetch");
  }
  for (const c of apiCalls.filter((a) => a.token === READ_TOKEN)) {
    assert.ok(
      ["getPullRequest", "listPullRequestCommits", "getCommitParentSha"].includes(c.op),
      `the READ token only authenticates source reads (was ${c.op})`,
    );
  }
});

// --- VAL-TOKEN-005/006: missing tokens → exit 1 before any write ------------

test("VAL-TOKEN-006: a missing WRITE token non-interactively exits 1 naming GITHUB_TOKEN, before any write", async () => {
  const sideEffects = { clone: 0, push: 0, create: 0, readPr: 0 };
  const { deps } = makeDeps({
    resolveWriteToken: async () => {
      throw new NoTokenNonInteractiveError();
    },
    getPullRequest: async () => {
      sideEffects.readPr += 1;
      return { title: "x", user: "y" };
    },
    cloneRepo: async () => {
      sideEffects.clone += 1;
      return fakeGit;
    },
    pushBranchFromSha: async () => {
      sideEffects.push += 1;
    },
    createPullRequest: async () => {
      sideEffects.create += 1;
      return CREATED_URL;
    },
  });
  const { stderr, exit } = await run({ deps });
  assert.equal(exit, 1, "a missing write token non-interactively exits 1");
  assert.match(stderr, /GITHUB_TOKEN/, "the message names GITHUB_TOKEN");
  assert.deepEqual(
    sideEffects,
    { clone: 0, push: 0, create: 0, readPr: 0 },
    "no write side effect (and no source read) occurred",
  );
});

test("VAL-TOKEN-005: a missing READ token non-interactively exits 1 naming GITHUB_SOURCE_TOKEN, before any write", async () => {
  const sideEffects = { clone: 0, push: 0, create: 0 };
  const { deps } = makeDeps({
    resolveDestinationChoice: async () => ({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      isSandbox: true,
    }),
    resolveReadToken: async () => {
      throw new NoSourceTokenNonInteractiveError(SOURCE_OWNER, SOURCE_REPO);
    },
    cloneRepo: async () => {
      sideEffects.clone += 1;
      return fakeGit;
    },
    pushBranchFromSha: async () => {
      sideEffects.push += 1;
    },
    createPullRequest: async () => {
      sideEffects.create += 1;
      return CREATED_URL;
    },
  });
  const { stderr, exit } = await run({ deps });
  assert.equal(exit, 1, "a missing read token non-interactively exits 1");
  assert.match(stderr, /GITHUB_SOURCE_TOKEN/, "the message names GITHUB_SOURCE_TOKEN");
  assert.deepEqual(sideEffects, { clone: 0, push: 0, create: 0 }, "no write side effect occurred");
});

// --- Destination API errors map to exit 2 -----------------------------------

test("a terminal not-writable destination (DestinationApiError) maps to exit 2", async () => {
  const { DestinationApiError } = await import("../src/destination.js");
  const { deps } = makeDeps({
    resolveWriteToken: async () => {
      throw new DestinationApiError("no write access");
    },
  });
  const { stderr, exit } = await run({ deps });
  assert.equal(exit, 2, "a terminal destination API error is exit 2");
  assert.match(stderr, /no write access/);
});

// --- A PR read API error maps to exit 2 -------------------------------------

test("a PR-read API error maps to exit 2", async () => {
  const { deps } = makeDeps({
    getPullRequest: async () => {
      throw new Error("Pull request acme/api#123 was not found");
    },
  });
  const { stderr, exit } = await run({ deps });
  assert.equal(exit, 2, "a PR-not-found is exit 2");
  assert.match(stderr, /was not found/);
});

// ===========================================================================
// Auth-first interactive onboarding (spec §3) — guided-setup-flow feature.
//
// These drive the INTERACTIVE (TTY, no-flag) path. `runBacktest` reads
// `process.stdin.isTTY` directly to decide the interactive fork, so each test
// forces it true for the duration of the run.
// ===========================================================================

/** An HTTP-status-bearing error shaped like an Octokit failure. */
function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** Force `process.stdin.isTTY` true for `fn`, restoring it after. */
async function withTty<T>(fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (real) {
      Object.defineProperty(process.stdin, "isTTY", real);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }
}

const INHERITED_TOKEN = "ghp_inherited_credential_value_authfirst_xx";
const INHERITED_CRED: InheritedCredential = {
  token: INHERITED_TOKEN,
  login: "octocat",
  source: "classic",
};

/**
 * Build deps for an INTERACTIVE auth-first run using the REAL
 * `resolveAuthFirstChoice` driven by injected leaf seams. The seams append to a
 * shared `order` log so a test can prove the auth offer precedes the destination
 * prompt. Token resolution + git/API default to the inert `makeDeps` fakes.
 */
function makeAuthFirstDeps(opts: {
  detected?: InheritedCredential | null;
  useInherited?: boolean;
  landing?: "primary" | "sandbox";
  landInSource?: boolean;
  slug?: RepoRef;
  overrides?: Partial<RunBacktestDeps>;
  tokenOpts?: { writeToken?: string; readToken?: string };
}): { deps: Partial<RunBacktestDeps>; order: string[] } {
  const order: string[] = [];
  const { deps } = makeDeps(
    {
      resolveAuthFirstChoice,
      detectInheritedCredential: async () => {
        order.push("detect");
        return opts.detected === undefined ? INHERITED_CRED : opts.detected;
      },
      makeAuthOfferPrompt: () => async (login: string) => {
        order.push(`offer:${login}`);
        return opts.useInherited ?? true;
      },
      makeLandingChoicePrompt: () => async () => {
        order.push("landing");
        return opts.landing ?? "primary";
      },
      makeLandInSourcePrompt: () => async () => {
        order.push("land-in-source");
        return opts.landInSource ?? true;
      },
      makeSlugPrompt: () => async () => {
        order.push("slug");
        if (!opts.slug) throw new Error("no slug fake");
        return opts.slug;
      },
      // Sandbox runs need an inert source remote.
      addSourceRemote: async () => {},
      ...opts.overrides,
    },
    opts.tokenOpts,
  );
  return { deps, order };
}

// --- VAL-FLOW-001: auth offer precedes the destination prompt (both forks) ---

test("VAL-FLOW-001: end-to-end, the auth offer fires BEFORE the destination prompt (ACCEPT path)", async () => {
  const { deps, order } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "primary",
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  const offerIdx = order.indexOf("offer:octocat");
  const landingIdx = order.indexOf("landing");
  assert.ok(offerIdx >= 0, "the auth offer was rendered");
  assert.ok(landingIdx >= 0, "the destination prompt was rendered");
  assert.ok(offerIdx < landingIdx, "the auth offer precedes the destination prompt (YES fork)");
});

test("VAL-FLOW-001: end-to-end, the auth offer fires BEFORE the destination prompt (DECLINE path)", async () => {
  const { deps, order } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: false, // decline → scoped fork
    landInSource: true,
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  const offerIdx = order.indexOf("offer:octocat");
  const landIdx = order.indexOf("land-in-source");
  assert.ok(offerIdx >= 0 && landIdx >= 0);
  assert.ok(offerIdx < landIdx, "the auth offer precedes the destination prompt (NO fork)");
});

test("VAL-FLOW-001: no credential detected → NO offer rendered, straight into the scoped fork", async () => {
  const { deps, order } = makeAuthFirstDeps({
    detected: null,
    landInSource: true,
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  assert.ok(!order.some((o) => o.startsWith("offer:")), "no offer when nothing is detected");
  assert.ok(order.includes("land-in-source"), "the scoped fork was entered directly");
});

test("VAL-AUTH-001: the rendered offer string contains @<login>", async () => {
  // The exact offer copy lives in the greppable `authOfferMessage` helper that
  // makeAuthOfferPrompt renders; assert it names the literal @<login>.
  const { authOfferMessage } = await import("../src/authFirst.js");
  assert.match(authOfferMessage("octocat"), /@octocat/);
  assert.match(authOfferMessage("octocat"), /Detected a GitHub login as @octocat/);

  // And in the real flow the offer seam receives that login (proven end-to-end:
  // the ACCEPT-path test above records `offer:octocat`).
  const { deps, order } = makeAuthFirstDeps({
    detected: { ...INHERITED_CRED, login: "alice" },
    useInherited: true,
    landing: "primary",
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  assert.ok(order.includes("offer:alice"), "the offer seam received the detected @login");
});

// --- VAL-FLOW-002: inherited fork routing -----------------------------------

test("VAL-FLOW-002: inherited + Original → Primary (isSandbox false, dest === source)", async () => {
  let verifyArgs: { dest: RepoRef; isSandbox: boolean } | undefined;
  const { deps } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "primary",
    overrides: {
      verifyOrCreateDestination: async (dest, vopts) => {
        verifyArgs = { dest, isSandbox: vopts.isSandbox };
        return dest;
      },
    },
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  assert.equal(verifyArgs?.isSandbox, false, "Original repo → Primary (isSandbox false)");
  assert.deepEqual(verifyArgs?.dest, { owner: SOURCE_OWNER, repo: SOURCE_REPO }, "dest === source");
});

test("VAL-FLOW-002: inherited + new sandbox → <src-owner>/<src-repo>-backtest, isSandbox true, create engaged", async () => {
  let verifyArgs: { dest: RepoRef; isSandbox: boolean } | undefined;
  const { deps } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "sandbox",
    tokenOpts: { writeToken: WRITE_TOKEN, readToken: READ_TOKEN },
    overrides: {
      verifyOrCreateDestination: async (dest, vopts) => {
        verifyArgs = { dest, isSandbox: vopts.isSandbox };
        return dest;
      },
    },
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  assert.equal(verifyArgs?.isSandbox, true, "new sandbox → isSandbox true");
  assert.deepEqual(
    verifyArgs?.dest,
    { owner: SOURCE_OWNER, repo: `${SOURCE_REPO}-backtest` },
    "dest is <src-owner>/<src-repo>-backtest, routed into the existing create path",
  );
});

// --- VAL-FLOW-003: scoped fork routing --------------------------------------

test("VAL-FLOW-003: scoped + yes → Primary, exactly one primary paste, no inherited credential", async () => {
  // Drive the REAL resolveWriteToken so the paste getter wiring is genuine. No
  // env, no saved, no inherited (scoped fork) → the single primary paste resolves.
  const pasteCalls: string[] = [];
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: { get: async () => ({ data: { permissions: { push: true } } }) },
      users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
    }) as unknown as ResolverOctokit;
  const { deps } = makeAuthFirstDeps({
    detected: null, // nothing detected → scoped fork
    landInSource: true,
    overrides: {
      resolveWriteToken: (wopts) =>
        resolveWriteToken({
          ...wopts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async (_dest, isPrimary) => {
            pasteCalls.push(isPrimary ? "primary" : "sandbox-write");
            return WRITE_TOKEN;
          },
        }),
      resolveReadToken: (ropts) =>
        resolveReadToken({
          ...ropts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async () => READ_TOKEN,
        }),
    },
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  assert.deepEqual(pasteCalls, ["primary"], "exactly one primary paste prompt");
});

test("VAL-FLOW-003: scoped + no → guidance, slug re-prompt (bad→good), read paste, write paste in order", async () => {
  // The REAL makeSlugPrompt loops on a parse error, so feeding one BAD slug then
  // one GOOD slug must cause two prompt iterations before advancing. The guidance
  // line is emitted before the slug prompt. Then the scoped Sandbox fork collects
  // the READ-only source paste FIRST, then the READ+WRITE destination paste — the
  // §3b user-facing order — via the injectable sandboxReadPaste/sandboxWritePaste
  // seams. The orchestrator replays those into the resolvers, so a single
  // distinct-token run completes.
  const events: string[] = [];
  const prompts = (await import("prompts")).default;
  // makeSlugPrompt uses prompts.text; inject a bad value then a good one.
  prompts.inject(["not-a-valid-slug", "you/sandbox"]);

  // The write token writes the dest but CANNOT read the source; the read token
  // reads the source. This forces a genuine two-token run (no single-PAT reuse),
  // so BOTH the read and write pastes are consulted.
  const factory = (token: string) =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
          const isSource = args.owner === SOURCE_OWNER && args.repo === SOURCE_REPO;
          // Source readable only by READ_TOKEN; dest writable only by WRITE_TOKEN.
          if (isSource) {
            if (token !== READ_TOKEN) throw httpError(404);
            return { data: {} };
          }
          return { data: { permissions: { push: token === WRITE_TOKEN } } };
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
    }) as unknown as ResolverOctokit;

  const { makeSlugPrompt } = await import("../src/destination.js");

  const { deps } = makeDeps(
    {
      resolveAuthFirstChoice,
      detectInheritedCredential: async () => null, // scoped fork
      makeAuthOfferPrompt: () => async () => false,
      makeLandingChoicePrompt: () => async () => "primary",
      makeLandInSourcePrompt: () => async () => {
        events.push("land-in-source");
        return false; // → scoped sandbox
      },
      makeSlugPrompt, // REAL: re-prompts on parse error
      // The scoped pastes, collected by the fork in §3b order. The seams record
      // their invocation order: read BEFORE write.
      sandboxReadPaste: async () => {
        events.push("paste:read");
        return READ_TOKEN;
      },
      sandboxWritePaste: async () => {
        events.push("paste:write");
        return WRITE_TOKEN;
      },
      addSourceRemote: async () => {},
      verifyRepo: async (octokit, owner, repo) => {
        const { data } = await (octokit as unknown as ResolverOctokit).repos.get({
          owner,
          repo,
        });
        return { exists: true, canPush: data.permissions?.push === true };
      },
      resolveWriteToken: (wopts) =>
        resolveWriteToken({
          ...wopts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
        }),
      resolveReadToken: (ropts) =>
        resolveReadToken({
          ...ropts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
        }),
    },
    { writeToken: WRITE_TOKEN, readToken: READ_TOKEN },
  );

  const { stderr, exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  // The guidance line is emitted (before the slug prompt advances).
  assert.match(stderr, /Create a private repo to hold the backtests/);
  // The slug re-prompt warned on the bad slug (makeSlugPrompt warns then loops).
  assert.match(stderr, /Invalid|owner\/repo/i);
  // §3b USER-FACING order: read paste then write paste, both AFTER the
  // land-in-source question. The slug prompt is the REAL prompts-backed one (two
  // injected answers), so its looping is proven by the run completing with the
  // GOOD slug "you/sandbox" as the destination.
  assert.deepEqual(events, ["land-in-source", "paste:read", "paste:write"]);
});

// --- VAL-AUTH-002: accepting a both-capability inherited credential ----------

test("VAL-AUTH-002: inherited both-cap → no paste, no saveConfig, single-PAT (twoToken false), reaches clone+push", async () => {
  const pasteCalls: string[] = [];
  const saveCalls: number[] = [];
  const reached: string[] = [];
  // The inherited token reads the source AND writes the destination → single PAT.
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: { get: async () => ({ data: { permissions: { push: true } } }) },
      users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
    }) as unknown as ResolverOctokit;

  const { deps } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "primary",
    overrides: {
      resolveWriteToken: (wopts) =>
        resolveWriteToken({
          ...wopts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {
            saveCalls.push(1);
          },
          getPaste: async () => {
            pasteCalls.push("write");
            return null;
          },
        }),
      resolveReadToken: (ropts) =>
        resolveReadToken({
          ...ropts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {
            saveCalls.push(1);
          },
          getPaste: async () => {
            pasteCalls.push("read");
            return null;
          },
        }),
      cloneRepo: async (_o, _r, token) => {
        reached.push(`clone:${token}`);
        return fakeGit;
      },
      pushBranchFromSha: async (_g, _s, branch, token) => {
        reached.push(`push:${token}`);
      },
    },
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0, "the inherited both-capability run completes");
  assert.deepEqual(pasteCalls, [], "no paste getter was ever invoked");
  assert.deepEqual(saveCalls, [], "saveConfig/mergeConfig was never called for the inherited token");
  // Single-PAT collapse: the run reached clone + push with the inherited token.
  assert.ok(
    reached.some((r) => r === `clone:${INHERITED_TOKEN}`),
    "clone used the inherited token (reached the write path)",
  );
  assert.ok(
    reached.some((r) => r === `push:${INHERITED_TOKEN}`),
    "push used the inherited token (reached the push path)",
  );
});

test("VAL-AUTH-002: inherited both-cap collapses to one Octokit instance (twoToken false)", async () => {
  // makeOctokit is called per token value; identical read+write tokens → one
  // instance. With the inherited token covering both, the read and write Octokit
  // are the SAME instance.
  const instances = new Map<string, object>();
  const octFactory = (token: string): ResolverOctokit => {
    let inst = instances.get(token);
    if (!inst) {
      inst = {
        repos: { get: async () => ({ data: { permissions: { push: true } } }) },
        users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
      };
      instances.set(token, inst);
    }
    return inst as ResolverOctokit;
  };
  const builtTokens: string[] = [];
  const { deps } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "primary",
    overrides: {
      makeOctokit: ((token: string) => {
        builtTokens.push(token);
        return octFactory(token) as unknown as Octokit;
      }) as RunBacktestDeps["makeOctokit"],
      resolveWriteToken: (wopts) =>
        resolveWriteToken({
          ...wopts,
          makeOctokit: octFactory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async () => null,
        }),
      resolveReadToken: (ropts) =>
        resolveReadToken({
          ...ropts,
          makeOctokit: octFactory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async () => null,
        }),
    },
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  // The orchestrator builds exactly ONE Octokit (read === write) for the single
  // inherited token → twoToken false.
  assert.deepEqual(
    [...new Set(builtTokens)],
    [INHERITED_TOKEN],
    "only the inherited token's Octokit is built (single-PAT, twoToken false)",
  );
  assert.equal(builtTokens.length, 1, "exactly one Octokit instance is constructed");
});

// --- VAL-AUTH-004: inherited write-miss for Primary → drop to scoped paste ----

test("VAL-AUTH-004: inherited can't write Primary → primary paste invoked, run proceeds, explanation, no token leak, no non-zero exit", async () => {
  const pasteCalls: string[] = [];
  // The inherited token CANNOT write (push:false); a pasted token CAN.
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async () => ({
          data: { permissions: { push: token !== INHERITED_TOKEN } },
        }),
      },
      users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
    }) as unknown as ResolverOctokit;

  const { deps } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "primary",
    overrides: {
      // The destination verify reflects the candidate token's push capability via
      // its octokit, throwing the write-permission error when it can't push — so
      // the inherited token (push:false) is rejected by the write `accept`.
      verifyOrCreateDestination: async (dest, vopts) => {
        const ver = await vopts.verifyDestination(dest.owner, dest.repo);
        if (!ver.canPush) throw new DestinationApiError("no write access");
        return dest;
      },
      verifyRepo: async (octokit, owner, repo) => {
        const { data } = await (octokit as unknown as ResolverOctokit).repos.get({
          owner,
          repo,
        });
        return { exists: true, canPush: data.permissions?.push === true };
      },
      // Real write resolver: env→saved→inherited(reject)→paste. The paste token
      // writes, so the run proceeds.
      resolveWriteToken: (wopts) =>
        resolveWriteToken({
          ...wopts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async (_dest, isPrimary) => {
            pasteCalls.push(isPrimary ? "primary" : "write");
            return WRITE_TOKEN;
          },
        }),
      resolveReadToken: (ropts) =>
        resolveReadToken({
          ...ropts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async () => READ_TOKEN,
        }),
    },
  });
  const { stdout, stderr, exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0, "no non-zero exit on the inherited write-miss alone");
  assert.deepEqual(pasteCalls, ["primary"], "the primary paste getter was invoked after the inherited miss");
  // The run proceeded (a PR URL is the final stdout line).
  assert.equal(stdout, CREATED_URL + "\n", "the run proceeded on the good paste");
  // A clear, token-free explanation of the inherited write-miss is emitted.
  assert.match(stderr, /cannot write/, "an explanation of the inherited write-miss is emitted");
  // The inherited token never appears anywhere — redact scrubs it.
  assert.equal(redact(stderr), stderr, "no inherited token substring in stderr (already redacted)");
  assert.ok(!stderr.includes(INHERITED_TOKEN), "the inherited token never leaks to stderr");
  assert.ok(!stdout.includes(INHERITED_TOKEN), "the inherited token never leaks to stdout");
});

// --- VAL-KEEP-001: source is never written under a broad inherited token -----

test("VAL-KEEP-001: inherited broad token, new sandbox → push/PR get the DESTINATION token + owner only", async () => {
  // The inherited token can write everything (broad). In a sandbox run the source
  // must STILL never be written: clone/push/PR target the destination with the
  // destination (write) token; the source remote fetch uses the read token.
  const factory = (): ResolverOctokit =>
    ({
      repos: { get: async () => ({ data: { permissions: { push: true } } }) },
      users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
    }) as unknown as ResolverOctokit;

  const pushes: Array<{ token: string | undefined }> = [];
  const prs: Array<{ owner: string; repo: string }> = [];
  const fetches: Array<{ remote: string; token: string | undefined }> = [];
  let cloneTarget: { owner: string; repo: string } | undefined;

  const { deps } = makeAuthFirstDeps({
    detected: INHERITED_CRED,
    useInherited: true,
    landing: "sandbox",
    overrides: {
      // Inherited covers write; for the source READ in a cross/same-owner sandbox
      // the inherited token reads too — but to PROVE routing we make the write
      // resolver return the inherited token and the read resolver also the
      // inherited token (single broad PAT). The routing invariant must hold by
      // OWNER/remote, independent of token scope.
      resolveWriteToken: (wopts) =>
        resolveWriteToken({
          ...wopts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async () => null,
        }),
      resolveReadToken: (ropts) =>
        resolveReadToken({
          ...ropts,
          makeOctokit: factory,
          getEnvToken: () => undefined,
          getConfig: () => null,
          saveConfig: () => {},
          getPaste: async () => null,
        }),
      cloneRepo: async (owner, repo, _token) => {
        cloneTarget = { owner, repo };
        return fakeGit;
      },
      addSourceRemote: async () => {},
      fetchCommit: async (_g, _s, _n, remote, token) => {
        fetches.push({ remote, token });
      },
      pushBranchFromSha: async (_g, _s, _branch, token) => {
        pushes.push({ token });
      },
      createPullRequest: async (_o, owner, repo) => {
        prs.push({ owner, repo });
        return CREATED_URL;
      },
    },
  });
  const { exit } = await withTty(() => run({ deps }));
  assert.equal(exit, 0);
  // Clone targets the destination sandbox, never the source.
  assert.deepEqual(cloneTarget, { owner: SOURCE_OWNER, repo: `${SOURCE_REPO}-backtest` });
  // Every push uses the inherited (= destination/write) token VALUE.
  for (const p of pushes) {
    assert.equal(p.token, INHERITED_TOKEN, "push uses the destination/write token value");
  }
  // The PR opens only against the destination sandbox.
  for (const pr of prs) {
    assert.ok(
      !(pr.owner === SOURCE_OWNER && pr.repo === SOURCE_REPO),
      "the PR never targets the source repo",
    );
    assert.deepEqual(pr, { owner: SOURCE_OWNER, repo: `${SOURCE_REPO}-backtest` });
  }
  // The source remote fetch is the only thing that touches the source.
  for (const f of fetches) {
    assert.equal(f.remote, "source", "commits are fetched from the source remote only");
  }
});
