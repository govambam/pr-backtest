import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SimpleGit } from "simple-git";

import {
  addRemoteDisplayCommand,
  addSourceRemote,
  buildUnfetchableMessage,
  cleanup,
  cloneDisplayCommand,
  fetchCommit,
  fetchDisplayCommand,
  gitEnv,
  makeTempDir,
  pushBranchFromSha,
  pushDisplayCommand,
  redactedRepoRef,
  repoHttpsUrl,
  TOKEN_ENV,
  UnfetchableCommitError,
  writeAskpassHelper,
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

// --- constructed display commands match the real argv ---------

test("each op's display command equals the expected argv for known inputs", () => {
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

// --- verbose git lines carry the real, token-free command -----

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

test("verbose fetch line is the real `$ git fetch …` command", async () => {
  setVerbose(true);
  const git = fakeGit({});
  const out = await captureStderr(async () => {
    await fetchCommit(git, "9f3c1a2", 123, "source");
  });
  assert.match(out, /\$ git fetch source 9f3c1a2/);
  assert.match(out, /\d+ms/);
});

test("verbose push line is the real `$ git push …` command", async () => {
  setVerbose(true);
  const git = fakeGit({});
  const out = await captureStderr(async () => {
    await pushBranchFromSha(git, "a1b2c3d", "backtest-pr123-head");
  });
  assert.match(out, /\$ git push origin a1b2c3d:refs\/heads\/backtest-pr123-head/);
});

test("verbose addRemote line shows the x-access-token URL with no token", async () => {
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

test("the clone display URL carries the x-access-token username only", () => {
  // cloneDisplayCommand reuses repoHttpsUrl, so the displayed URL never carries
  // a `:password@` form.
  const line = cloneDisplayCommand("octocat", "pr-backtest-sandbox", "/tmp/x/repo");
  assert.match(line, /https:\/\/x-access-token@github\.com\//);
  assert.doesNotMatch(line, /x-access-token:[^@]+@/);
});

// --- raw git stderr never reaches the user, incl. failures ----

const STDERR_SENTINEL = "RAW_GIT_STDERR_SENTINEL_must_never_leak";

test("a fetch failure surfaces only the domain error; the stderr sentinel never leaks", async () => {
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

test("a push failure surfaces only the generic error; the stderr sentinel never leaks", async () => {
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

// --- the token reaches git only via GIT_ASKPASS + env -----------

// A distinctive secret used throughout the token-placement tests. If any of the
// constructed commands/URLs/files contained it, the assertions below would catch
// it; only the child env is allowed to carry it.
const TOKEN = "ghp_SECRET_token_value_must_never_leak_0123456789";

test("the token lives only in the child env, never in the URL, argv, or display lines", () => {
  const askpassPath = "/tmp/pr-backtest-xyz/askpass.sh";
  const env = gitEnv(TOKEN, askpassPath);

  // Present only under PR_BACKTEST_GIT_TOKEN in the child env.
  assert.equal(env[TOKEN_ENV], TOKEN, "the token must be carried in the child env");
  for (const [key, value] of Object.entries(env)) {
    if (key === TOKEN_ENV) continue;
    assert.ok(
      typeof value !== "string" || !value.includes(TOKEN),
      `no other env value may carry the token (leaked via ${key})`,
    );
  }
  // The askpass helper path is not the token.
  assert.ok(!askpassPath.includes(TOKEN), "the askpass path is not the token");

  // Absent from the remote URL and every constructed display line.
  const url = repoHttpsUrl("acme", "api");
  assert.ok(!url.includes(TOKEN), "the token must not be in the remote URL");
  assert.match(url, /x-access-token@/, "the URL carries the x-access-token username");

  const displayLines = [
    cloneDisplayCommand("acme", "api", "/tmp/pr-backtest-xyz/repo"),
    addRemoteDisplayCommand("acme", "api"),
    fetchDisplayCommand("source", "9f3c1a2"),
    pushDisplayCommand("a1b2c3d", "backtest-pr123-head"),
  ];
  for (const line of displayLines) {
    assert.ok(!line.includes(TOKEN), `display line must not carry the token: ${line}`);
  }
});

test("repoHttpsUrl carries the x-access-token username and never the token", () => {
  const url = repoHttpsUrl("acme", "api");
  assert.match(url, /^https:\/\/x-access-token@github\.com\/acme\/api\.git$/);
  assert.ok(!url.includes(TOKEN), "the token must never appear in the remote URL");
});

test("a real clone driven through the askpass seam never writes the token into any file under .git", () => {
  // Build a local bare repo with one commit, then drive a real `git clone`
  // through the exported askpass + env seams (the same wiring cloneRepo uses)
  // and grep every file under the clone's .git/ for the token.
  const workDir = mkdtempSync(join(tmpdir(), "pr-backtest-clonetest-"));
  try {
    const sourceDir = join(workDir, "source");
    const bareDir = join(workDir, "origin.git");
    const cloneTarget = join(workDir, "clone");

    // A working repo with one commit.
    const run = (args: string[], cwd: string): void => {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    };
    execFileSync("git", ["init", "-q", sourceDir], { stdio: "ignore" });
    run(["config", "user.email", "test@example.com"], sourceDir);
    run(["config", "user.name", "Test"], sourceDir);
    execFileSync("git", ["-C", sourceDir, "commit", "--allow-empty", "-q", "-m", "init"], {
      stdio: "ignore",
    });
    // A bare clone to serve as the clone source.
    execFileSync("git", ["clone", "-q", "--bare", sourceDir, bareDir], { stdio: "ignore" });

    // Drive the clone with the askpass helper + env exactly as cloneRepo does.
    const askpassPath = writeAskpassHelper(workDir);
    const env = gitEnv(TOKEN, askpassPath) as Record<string, string>;
    // A local path source never prompts for credentials, but the env still
    // carries the token — the property under test is that it does NOT end up in
    // any cloned file (notably .git/config, which records the remote URL).
    execFileSync("git", ["clone", "--no-checkout", bareDir, cloneTarget], {
      env,
      stdio: "ignore",
    });

    // Recursively read every file under the clone's .git/ and assert the token
    // appears in none of them.
    const gitDir = join(cloneTarget, ".git");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          let contents = "";
          try {
            contents = readFileSync(full, "utf8");
          } catch {
            contents = "";
          }
          if (contents.includes(TOKEN)) offenders.push(full);
        }
      }
    };
    walk(gitDir);
    assert.deepEqual(offenders, [], "no file under .git/ may contain the token");

    // .git/config in particular records the remote URL — assert it explicitly.
    const config = readFileSync(join(gitDir, "config"), "utf8");
    assert.ok(!config.includes(TOKEN), ".git/config must not contain the token");
  } finally {
    cleanup(workDir);
  }
});

// --- the askpass helper: password-only, mode 0700, cleaned up ---

test("the askpass helper emits the token for a password prompt, empty for a username prompt", () => {
  const dir = makeTempDir();
  try {
    const helperPath = writeAskpassHelper(dir);
    const env = { ...process.env, [TOKEN_ENV]: TOKEN } as Record<string, string>;

    // git invokes the helper with the prompt string as argv[1]. The password
    // prompt yields the token; the username prompt yields nothing.
    const onPassword = execFileSync(helperPath, ["Password for 'https://x-access-token@github.com':"], {
      env,
      encoding: "utf8",
    });
    const onUsername = execFileSync(helperPath, ["Username for 'https://github.com':"], {
      env,
      encoding: "utf8",
    });
    assert.equal(onPassword, TOKEN, "the helper emits the token for a password prompt");
    assert.equal(onUsername, "", "the helper emits nothing for a username prompt");
  } finally {
    cleanup(dir);
  }
});

test("the askpass helper is written mode 0700", () => {
  const dir = makeTempDir();
  try {
    const helperPath = writeAskpassHelper(dir);
    assert.equal(statSync(helperPath).mode & 0o777, 0o700, "the helper must be mode 0700");
  } finally {
    cleanup(dir);
  }
});

test("cleanup removes the askpass helper file", () => {
  const dir = makeTempDir();
  const helperPath = writeAskpassHelper(dir);
  assert.ok(existsSync(helperPath), "the helper exists before cleanup");
  cleanup(dir);
  assert.ok(!existsSync(helperPath), "the helper no longer exists after cleanup");
});
