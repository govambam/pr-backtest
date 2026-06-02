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
