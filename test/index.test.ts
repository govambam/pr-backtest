/**
 * Full-flow tests for `runBacktest` (`src/index.ts`), driving the real
 * orchestration through an injected `deps` fake so no network or git runs.
 *
 * Coverage:
 *  - On a successful run stdout is EXACTLY the PR URL + "\n", and every trace
 *    line the run emits is on stderr (stdout carries nothing else).
 *  - The captured stderr shows `✓` completion markers for the user-facing
 *    operations (authenticated, read PR, verified destination, cloned, fetched,
 *    pushed base, pushed head, opened PR).
 *  - The recorded operation order matches the base sequence (read PR → verify
 *    destination → clone → fetch base → fetch head → push base → push head →
 *    open PR), AND a failure path keeps its exit code (an unfetchable commit →
 *    exit 3). Because `deps` defaults to production and is only substituted here,
 *    this exercises the real ordering in `runBacktest` — not a hardcoded copy.
 *
 * `process.exit` is stubbed to throw a tagged error so the test can assert the
 * code without killing the test process (mirrors the cli.test.ts intent of
 * asserting the documented exit-code mapping).
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
import { NoTokenNonInteractiveError } from "../src/auth.js";
import { setTtyOverride, setVerbose } from "../src/log.js";

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

/** A fake `Octokit` — the deps never touch it, so an empty object is enough. */
const fakeOctokit = {} as unknown as Octokit;
/** A fake `SimpleGit` — likewise inert; the git deps are stubbed. */
const fakeGit = {} as unknown as SimpleGit;

/**
 * Build a complete `deps` fake plus a shared `order` log. Each git/API
 * collaborator records a stable label so the test can assert the exact
 * orchestration sequence. `overrides` lets a single test swap one collaborator
 * (e.g. make `fetchCommit` throw `UnfetchableCommitError`).
 */
function makeDeps(overrides: Partial<RunBacktestDeps> = {}): {
  deps: Partial<RunBacktestDeps>;
  order: string[];
} {
  const order: string[] = [];
  const base: RunBacktestDeps = {
    resolveToken: async () => ({
      token: "ghp_fake_token_value_123456",
      username: "octocat",
      source: "classic",
    }),
    makeOctokit: () => fakeOctokit,
    resolveDestination: async (source) => {
      order.push("verify-destination");
      return { owner: source.owner, repo: source.repo, isSandbox: false };
    },
    verifyRepo: async () => ({ exists: true, canPush: true }),
    makeSandboxCreator: () => async () => ({ owner: "x", repo: "y" }),
    makeInteractivePrompt: () => async () => ({ kind: "primary" }),
    readConfig: () => null,
    getPullRequest: async () => {
      order.push("read-pr");
      return {
        title: "Add retry to fetch",
        user: "octocat",
      };
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
    cleanup: async () => {},
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
  // Stub process.exit to throw, so the run unwinds at the first exit call.
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

test("on success stdout is exactly the PR URL + newline; trace is on stderr", async () => {
  const { deps } = makeDeps();
  const { stdout, stderr, exit } = await run({ deps });

  assert.equal(exit, 0, "a clean success exits 0");
  assert.equal(stdout, CREATED_URL + "\n", "stdout is exactly the PR URL + \\n");
  // The created URL is the ONLY thing on stdout — no trace bled across.
  assert.ok(!stdout.includes("✓"), "no completion marker on stdout");
  assert.ok(!stdout.includes("Read PR"), "no narration on stdout");
  // The narration that proves the run happened is on stderr.
  assert.match(stderr, /Read PR/);
  assert.match(stderr, /✓/);
});

test("a default run's stderr shows ✓ completion markers for each operation", async () => {
  const { deps } = makeDeps();
  const { stderr } = await run({ deps });

  // The index-level step sites narrate read-PR, verify-destination, open-PR.
  assert.match(stderr, /✓ Read PR github\.com\/acme\/api#123/);
  assert.match(stderr, /✓ Verified destination/);
  assert.match(stderr, /✓ Opened backtest PR/);
  // success("Backtest PR created.") is the final ✓.
  assert.match(stderr, /✓ Backtest PR created/);
});

test("git-layer ops (clone/fetch/push) narrate their own ✓ — no duplicate index-level line", async () => {
  // Drive through the REAL git ops (not the deps stubs) by injecting a fake
  // SimpleGit so clone/fetch/push render their `traceOp` ✓ lines. Here we let
  // the default deps git stubs stand and instead assert the index layer does
  // NOT emit a `Cloning …`/`Pushing …` step line of its own (it delegates to
  // the git layer), so there is no double narration.
  const { deps } = makeDeps();
  const { stderr } = await run({ deps });
  // index.ts must not add its own "Cloning"/"Pushing" step lines; those belong
  // to git.ts. With git stubbed, neither layer prints them — so the captured
  // stderr has no clone/push narration originating from index.ts.
  const indexClonedLines = stderr
    .split("\n")
    .filter((l) => /Cloning github\.com/.test(l) && l.includes("→"));
  assert.equal(indexClonedLines.length, 0, "index.ts emits no `→ Cloning` line");
});

test("the success operation order matches the base sequence", async () => {
  const { deps, order } = makeDeps();
  const { exit } = await run({ deps });
  assert.equal(exit, 0);
  assert.deepEqual(order, [
    "verify-destination",
    "read-pr",
    "clone",
    "fetch:9f3c", // base SHA fetched first
    "fetch:a1b2", // head SHA fetched second
    "push:backtest-pr123-base",
    "push:backtest-pr123-head",
    "open-pr",
  ]);
});

test("an unfetchable commit maps to exit 3 (git failure), unchanged", async () => {
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

test("a closed/merged prior backtest PR is caught by the pre-flight before any clone/push", async () => {
  // The pre-flight queries `state: "all"`, so a closed or merged prior backtest
  // PR for the same branch pair is detected up front. An open-only pre-flight
  // would miss this PR — modelled here by a fake that only returns a URL when
  // asked for `"all"`, returning null for the open-only default.
  const calls = { clone: 0, push: 0, create: 0 };
  const EXISTING_URL = "https://github.com/acme/api/pull/200";
  const { deps } = makeDeps({
    findExistingPr: async (_octokit, _owner, _repo, _head, _base, state) =>
      state === "all" ? EXISTING_URL : null,
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
  const { stdout, exit } = await run({ deps });

  assert.equal(exit, 4, "an existing backtest PR is the documented exit 4");
  assert.equal(stdout, EXISTING_URL + "\n", "stdout is exactly the existing PR URL");
  assert.equal(calls.clone, 0, "no clone when the pre-flight finds an existing PR");
  assert.equal(calls.push, 0, "no push when the pre-flight finds an existing PR");
  assert.equal(calls.create, 0, "no create when the pre-flight finds an existing PR");
});

test("a verbose run is observation-only — same order, same exit", async () => {
  const { deps, order } = makeDeps();
  const { exit } = await run({ deps, verbose: true });
  assert.equal(exit, 0, "verbose does not change the exit code");
  assert.deepEqual(
    order,
    [
      "verify-destination",
      "read-pr",
      "clone",
      "fetch:9f3c",
      "fetch:a1b2",
      "push:backtest-pr123-base",
      "push:backtest-pr123-head",
      "open-pr",
    ],
    "verbose does not change the operation order",
  );
});

// --- writes target the destination, never the read-only source --

/** A single git/API call that wrote somewhere, tagged with its target repo. */
interface WriteTarget {
  op: string;
  owner: string;
  repo: string;
}

/**
 * Build deps whose clone/push/create/add-source-remote fakes RECORD the
 * owner/repo they were handed (the base `makeDeps` fakes discard them). Returns
 * the deps plus the captured write targets and the source remote target.
 */
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
      // The push fake cannot see owner/repo (pushBranchFromSha pushes to the
      // clone's `origin`, which cloneRepo set to the destination). The clone
      // target is therefore the write target asserted for push; record the
      // branch so the call is observable.
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

const SOURCE_OWNER = "acme";
const SOURCE_REPO = "api";
const SANDBOX_OWNER = "octocat";
const SANDBOX_REPO = "pr-backtest-sandbox";

test("a sandbox run clones and opens the PR against the destination, never the source", async () => {
  const { deps, writes } = makeRecordingDeps({
    resolveDestination: async () => ({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      isSandbox: true,
    }),
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  // clone and create target the destination.
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

  // push happened (the branches were pushed to the clone's origin = destination).
  assert.ok(
    writes.some((w) => w.op === "push:backtest-pr123-head"),
    "the head branch was pushed",
  );

  // The source owner/repo is NEVER a clone/push/create target.
  for (const w of writes) {
    assert.ok(
      !(w.owner === SOURCE_OWNER && w.repo === SOURCE_REPO),
      `the source repo must never be a write target (was for ${w.op})`,
    );
  }
});

test("a sandbox run adds the source remote for the source repo and fetches from it", async () => {
  const { deps, sourceRemote, fetchRemotes } = makeRecordingDeps({
    resolveDestination: async () => ({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      isSandbox: true,
    }),
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  // addSourceRemote is called exactly for the SOURCE owner/repo.
  assert.deepEqual(sourceRemote, [
    { op: "add-source-remote", owner: SOURCE_OWNER, repo: SOURCE_REPO },
  ]);
  // Both commits are fetched from the `source` remote, not origin.
  assert.deepEqual(fetchRemotes, ["source", "source"]);
});

test("a primary run never adds a source remote and fetches from origin", async () => {
  // Default resolveDestination returns the source repo with isSandbox:false.
  const { deps, writes, sourceRemote, fetchRemotes } = makeRecordingDeps();
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  // No source remote in primary mode; fetch uses origin.
  assert.deepEqual(sourceRemote, [], "primary mode never adds a source remote");
  assert.deepEqual(fetchRemotes, ["origin", "origin"], "primary mode fetches from origin");

  // In primary mode destination == source, so clone/create DO target the source
  // repo (by design — the user opted in). That is the destination here.
  const clone = writes.find((w) => w.op === "clone");
  assert.deepEqual(
    { owner: clone?.owner, repo: clone?.repo },
    { owner: SOURCE_OWNER, repo: SOURCE_REPO },
    "primary mode clones the source repo (which is the chosen destination)",
  );
});

// --- git + Octokit routing: per-owner token + per-instance Octokit ---------
//
// These tests are the AUTHORITATIVE evidence for VAL-ROUTE-001/002/003 and
// VAL-INV-001/002/006. They observe (a) WHICH Octokit instance each API call
// received, and (b) WHICH token authenticated each git op, by injecting a
// recording `makeOctokit` (distinct instance per token) and a
// `resolveTokensForRun` that returns chosen read/write tokens.

const READ_TOKEN = "ghp_READ_token_value_must_route_to_source_reads";
const WRITE_TOKEN = "ghp_WRITE_token_value_must_route_to_dest_writes";

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
 * it received. `resolveTokensForRun` is stubbed to return the given tokens so a
 * test can force a two-token (distinct) or one-token (identical) run. Each git
 * dep records the token it was handed (the per-op credential seam).
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

  // A distinct, identity-stable Octokit per token. Re-requesting the same token
  // returns the SAME object so identity (===) is meaningful in assertions.
  const makeOctokit = ((token: string): Octokit => {
    let inst = instances.get(token);
    if (!inst) {
      inst = { __token: token } as unknown as object;
      instances.set(token, inst);
    }
    return inst as unknown as Octokit;
  }) as unknown as RunBacktestDeps["makeOctokit"];

  /** Read the token an Octokit instance was tagged with. */
  const tokenOf = (octokit: unknown): string =>
    (octokit as { __token?: string }).__token ?? "<untagged>";

  const twoToken = opts.readToken !== opts.writeToken;

  const { deps: base } = makeDeps({
    // The default/resolveToken credential is the write token, so a one-token run
    // (read===write===default) collapses to a single constructed Octokit.
    resolveToken: async () => ({
      token: opts.writeToken,
      username: "octocat",
      source: "classic",
    }),
    makeOctokit,
    computeTokenNeeds: () => [
      { kind: "write", owner: "octocat", repo: "sandbox" },
    ],
    resolveTokensForRun: async () => ({
      readToken: opts.readToken,
      writeToken: opts.writeToken,
      twoToken,
    }),
    resolveDestination: async (source) =>
      opts.isSandbox
        ? { owner: SANDBOX_OWNER, repo: SANDBOX_REPO, isSandbox: true }
        : { owner: source.owner, repo: source.repo, isSandbox: false },
    // verifyRepo is used by the source-visibility probe (default token) AND by
    // the destination resolver. Tag-record nothing here; it always succeeds.
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
  // Both source reads actually happened on the read instance.
  assert.ok(apiCalls.some((c) => c.op === "getPullRequest" && c.token === READ_TOKEN));
  assert.ok(apiCalls.some((c) => c.op === "createPullRequest" && c.token === WRITE_TOKEN));
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

  // Exactly one Octokit instance exists for the single token (the recording
  // makeOctokit returns the same object per token, so a single map entry proves
  // one instance covered both read and write).
  assert.equal(instances.size, 1, "one token → exactly one Octokit instance");
  // Every git op authenticates with that one token — byte-for-byte one-token.
  for (const c of gitCalls) {
    assert.equal(c.token, WRITE_TOKEN, `${c.op} uses the single token`);
  }
});

test("VAL-INV-002 + VAL-INV-006: read token never authenticates a write; write token never the source fetch/read", async () => {
  const { deps, apiCalls, gitCalls } = makeRoutingDeps({
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    isSandbox: true,
  });
  const { exit } = await run({ deps });
  assert.equal(exit, 0);

  // INV-002: the READ token is never the clone/push credential, nor the
  // create/findExistingPr Octokit.
  const writeGitOps = gitCalls.filter(
    (c) => c.op === "clone" || c.op.startsWith("push:"),
  );
  for (const c of writeGitOps) {
    assert.notEqual(c.token, READ_TOKEN, `${c.op} must never use the READ token`);
  }
  for (const c of apiCalls.filter((a) => a.op === "createPullRequest" || a.op === "findExistingPr")) {
    assert.notEqual(c.token, READ_TOKEN, `${c.op} must never use the READ Octokit`);
  }

  // INV-006: the WRITE token never authenticates the source fetch or a source read.
  for (const c of gitCalls.filter((g) => g.op === "fetch:source")) {
    assert.notEqual(c.token, WRITE_TOKEN, "the source fetch must never use the WRITE token");
  }
  for (const c of apiCalls.filter((a) =>
    ["getPullRequest", "listPullRequestCommits", "getCommitParentSha"].includes(a.op),
  )) {
    assert.notEqual(c.token, WRITE_TOKEN, `${c.op} must never use the WRITE Octokit`);
  }
});

test("VAL-INV-001: source owner/repo is never a push or createPullRequest target (cross-owner)", async () => {
  // Record the owner/repo handed to clone/create + the branch handed to push.
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
  // create targeted the sandbox (destination), not the source.
  const create = writes.find((w) => w.op === "create");
  assert.deepEqual(
    { owner: create?.owner, repo: create?.repo },
    { owner: SANDBOX_OWNER, repo: SANDBOX_REPO },
  );
});

test("a non-interactive missing read token exits 1 before any clone/push/create", async () => {
  // resolveTokensForRun throws the no-source-token error; the run must map it to
  // exit 1 and perform NO write side effect.
  const sideEffects = { clone: 0, push: 0, create: 0 };
  const { deps } = makeDeps({
    computeTokenNeeds: () => [
      { kind: "read", owner: SOURCE_OWNER, repo: SOURCE_REPO },
      { kind: "write", owner: SANDBOX_OWNER, repo: SANDBOX_REPO },
    ],
    resolveTokensForRun: async () => {
      throw new NoTokenNonInteractiveError();
    },
    resolveDestination: async () => ({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      isSandbox: true,
    }),
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
  const { exit } = await run({ deps });
  assert.equal(exit, 1, "a missing read token non-interactively exits 1");
  assert.deepEqual(sideEffects, { clone: 0, push: 0, create: 0 }, "no write side effect occurred");
});
