import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { SimpleGit } from "simple-git";

import {
  addRemoteDisplayCommand,
  addSourceRemote,
  buildUnfetchableMessage,
  cloneDisplayCommand,
  fetchCommit,
  fetchDisplayCommand,
  pushBranchFromSha,
  pushDisplayCommand,
  redactedRepoRef,
  repoHttpsUrl,
  UnfetchableCommitError,
} from "../src/git.js";
import { setTtyOverride, setVerbose } from "../src/log.js";

/**
 * Capture everything written to `process.stderr` for the duration of `run`,
 * restoring the original writer afterwards. Returns the concatenated output.
 */
async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return buffer;
}

beforeEach(() => {
  // Deterministic, non-TTY, non-verbose by default; tests opt in explicitly.
  setTtyOverride(false);
  setVerbose(false);
});

afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

test("buildUnfetchableMessage interpolates the SHA and PR number into both fallback lines", () => {
  const msg = buildUnfetchableMessage("abc1234", 42);
  assert.match(msg, /^Could not fetch commit abc1234 from origin\./);
  assert.match(msg, /git push origin abc1234:refs\/heads\/backtest-pr42-head/);
  assert.match(msg, /git push origin abc1234\^:refs\/heads\/backtest-pr42-base/);
});

test("UnfetchableCommitError.message equals buildUnfetchableMessage and carries fields", () => {
  const err = new UnfetchableCommitError("deadbeef", 7);
  assert.equal(err.message, buildUnfetchableMessage("deadbeef", 7));
  assert.equal(err.sha, "deadbeef");
  assert.equal(err.prNumber, 7);
});

test("the unfetchable message names origin by default and the source repo in fork mode", () => {
  assert.match(buildUnfetchableMessage("abc1234", 1), /from origin\./);
  assert.match(
    buildUnfetchableMessage("abc1234", 1, "source"),
    /from the source repository\./,
  );
  assert.equal(
    new UnfetchableCommitError("abc1234", 1, "source").message,
    buildUnfetchableMessage("abc1234", 1, "source"),
  );
});

test("repoHttpsUrl carries only the x-access-token username, never a secret", () => {
  const url = repoHttpsUrl("acme", "api");
  assert.equal(url, "https://x-access-token@github.com/acme/api.git");
  // The username is not a secret; there must be no ":password@" component.
  assert.doesNotMatch(url, /x-access-token:[^@]+@/);
});

test("redactedRepoRef is a token-free, log-safe reference", () => {
  assert.equal(redactedRepoRef("acme", "api"), "github.com/acme/api");
});

// --- VAL-GIT-001: constructed display commands match the real argv ---------

test("VAL-GIT-001: each op's display command equals the expected argv for known inputs", () => {
  assert.equal(
    cloneDisplayCommand("octocat", "repo", "/tmp/x/repo"),
    "git clone --no-checkout https://x-access-token@github.com/octocat/repo.git /tmp/x/repo",
  );
  assert.equal(
    addRemoteDisplayCommand("octocat", "repo"),
    "git remote add source https://x-access-token@github.com/octocat/repo.git",
  );
  assert.equal(
    fetchDisplayCommand("source", "9f3c1a2"),
    "git fetch source 9f3c1a2",
  );
  assert.equal(
    pushDisplayCommand("a1b2c3d", "backtest-pr123-head"),
    "git push origin a1b2c3d:refs/heads/backtest-pr123-head",
  );
});

// --- VAL-GIT-002: verbose git lines carry the real, token-free command -----

/**
 * A minimal fake `SimpleGit` whose four methods used by the trace path resolve
 * (or, in failure tests, reject with a stderr sentinel). Only the members the
 * tested ops touch are implemented; the cast is intentional and scoped.
 */
function fakeGit(
  overrides: Partial<{
    fetch: SimpleGit["fetch"];
    push: SimpleGit["push"];
    addRemote: SimpleGit["addRemote"];
  }>,
): SimpleGit {
  return {
    fetch: overrides.fetch ?? (async () => ({}) as never),
    push: overrides.push ?? (async () => ({}) as never),
    addRemote: overrides.addRemote ?? (async () => "" as never),
  } as unknown as SimpleGit;
}

test("VAL-GIT-002: verbose fetch line is the real `$ git fetch …` command", async () => {
  setVerbose(true);
  const git = fakeGit({});
  const out = await captureStderr(async () => {
    await fetchCommit(git, "9f3c1a2", 123, "source");
  });
  assert.match(out, /\$ git fetch source 9f3c1a2/);
  assert.match(out, /\d+ms/);
});

test("VAL-GIT-002: verbose push line is the real `$ git push …` command", async () => {
  setVerbose(true);
  const git = fakeGit({});
  const out = await captureStderr(async () => {
    await pushBranchFromSha(git, "a1b2c3d", "backtest-pr123-head");
  });
  assert.match(out, /\$ git push origin a1b2c3d:refs\/heads\/backtest-pr123-head/);
});

test("VAL-GIT-002: verbose addRemote line shows the x-access-token URL with no token", async () => {
  setVerbose(true);
  const git = fakeGit({});
  const out = await captureStderr(async () => {
    await addSourceRemote(git, "octocat", "repo");
  });
  // The displayed clone/remote URL is exactly the x-access-token username form —
  // no `:password@` / token component.
  assert.match(
    out,
    /\$ git remote add source https:\/\/x-access-token@github\.com\/octocat\/repo\.git/,
  );
  assert.doesNotMatch(out, /x-access-token:[^@]+@/);
});

test("VAL-GIT-002: the clone display URL carries the x-access-token username only", () => {
  // cloneDisplayCommand reuses repoHttpsUrl, so the displayed URL never carries
  // a `:password@` form.
  const line = cloneDisplayCommand("octocat", "pr-backtest-sandbox", "/tmp/x/repo");
  assert.match(line, /https:\/\/x-access-token@github\.com\//);
  assert.doesNotMatch(line, /x-access-token:[^@]+@/);
});

// --- VAL-SAFE-002: raw git stderr never reaches the user, incl. failures ----

const STDERR_SENTINEL = "RAW_GIT_STDERR_SENTINEL_must_never_leak";

test("VAL-SAFE-002: a fetch failure surfaces only the domain error; the stderr sentinel never leaks", async () => {
  setVerbose(true);
  const git = fakeGit({
    fetch: (async () => {
      throw new Error(`fatal: ${STDERR_SENTINEL}`);
    }) as unknown as SimpleGit["fetch"],
  });

  let thrown: unknown;
  const out = await captureStderr(async () => {
    try {
      await fetchCommit(git, "9f3c1a2", 123, "source");
    } catch (err) {
      thrown = err;
    }
  });

  // The thrown error is the token-free domain error, not the raw git error.
  assert.ok(thrown instanceof UnfetchableCommitError);
  assert.equal((thrown as UnfetchableCommitError).message, buildUnfetchableMessage("9f3c1a2", 123, "source"));
  assert.ok(
    !(thrown as Error).message.includes(STDERR_SENTINEL),
    "domain error must not carry raw git stderr",
  );
  // The ✗ completion marker printed, but the sentinel never appears anywhere.
  assert.match(out, /✗/);
  assert.ok(!out.includes(STDERR_SENTINEL), "raw git stderr must never reach stderr output");
});

test("VAL-SAFE-002: a push failure surfaces only the generic error; the stderr sentinel never leaks", async () => {
  setVerbose(true);
  const git = fakeGit({
    push: (async () => {
      throw new Error(`fatal: ${STDERR_SENTINEL}`);
    }) as unknown as SimpleGit["push"],
  });

  let thrown: unknown;
  const out = await captureStderr(async () => {
    try {
      await pushBranchFromSha(git, "a1b2c3d", "backtest-pr123-head");
    } catch (err) {
      thrown = err;
    }
  });

  assert.ok(thrown instanceof Error);
  assert.ok(
    !(thrown as Error).message.includes(STDERR_SENTINEL),
    "generic push error must not carry raw git stderr",
  );
  assert.ok(!out.includes(STDERR_SENTINEL), "raw git stderr must never reach stderr output");
});
