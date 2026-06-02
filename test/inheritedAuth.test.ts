import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  detectInheritedCredential,
  GIT_CREDENTIAL_FILL_STDIN,
  type ExecResult,
  type ExecSeam,
} from "../src/inheritedAuth.js";
import type { ResolverOctokit } from "../src/auth.js";
import { setVerbose, setTtyOverride, redact } from "../src/log.js";

// log.ts's trace surface is a module-level singleton; reset it around every test.
beforeEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});
afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

/** One recorded exec call: the command, its args, and the stdin fed to it. */
interface ExecCall {
  command: string;
  args: readonly string[];
  stdin: string | undefined;
}

/**
 * A recording exec seam driven by a per-command responder. Every call is pushed
 * to `calls` (in order), so a test can assert the EXACT command, args, stdin, and
 * call ORDER. Unmapped commands resolve as a failed exec (a missing binary).
 */
function makeExec(
  responders: Partial<Record<string, () => ExecResult>>,
): { exec: ExecSeam; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecSeam = async (command, args, stdin) => {
    calls.push({ command, args, stdin });
    const responder = responders[command];
    if (!responder) {
      return { stdout: "", failed: true };
    }
    return responder();
  };
  return { exec, calls };
}

/** An Octokit factory whose getAuthenticated returns a fixed login, recording the token. */
function loginFactory(
  login: string,
  seen?: string[],
): (token: string) => ResolverOctokit {
  return (token: string) =>
    ({
      repos: { get: async () => ({ data: {} }) },
      users: {
        getAuthenticated: async () => {
          seen?.push(token);
          return { data: { login } };
        },
      },
    }) as unknown as ResolverOctokit;
}

const fillHit = (token: string): ExecResult => ({
  stdout: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n`,
  failed: false,
});

// ===========================================================================
// VAL-AUTH-001 — TTY detects (in order), captures @login, null when neither hits
// ===========================================================================

test("VAL-AUTH-001: git credential fill runs FIRST with the exact stdin, BEFORE any gh call", async () => {
  const { exec, calls } = makeExec({
    git: () => fillHit("ghp_inherited_token_value_123456"),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("octocat"),
  });

  assert.ok(cred, "a credential was detected");
  // The FIRST exec call is `git credential fill` with the exact required stdin.
  assert.equal(calls[0]!.command, "git");
  assert.deepEqual(calls[0]!.args, ["credential", "fill"]);
  assert.equal(calls[0]!.stdin, GIT_CREDENTIAL_FILL_STDIN);
  assert.equal(
    calls[0]!.stdin,
    "protocol=https\nhost=github.com\n\n",
    "the exact bytes fed to git credential fill",
  );
  // gh is NOT called at all when fill yields a password.
  assert.ok(
    !calls.some((c) => c.command === "gh"),
    "gh is never invoked once fill succeeds",
  );
});

test("VAL-AUTH-001: a fill hit captures the @login via getAuthenticated and infers source", async () => {
  const seen: string[] = [];
  const { exec } = makeExec({
    git: () => fillHit("github_pat_fine_grained_token_value_xyz"),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("alice", seen),
  });
  assert.ok(cred);
  assert.equal(cred!.token, "github_pat_fine_grained_token_value_xyz");
  assert.equal(cred!.login, "alice");
  assert.equal(cred!.source, "fine-grained");
  assert.deepEqual(seen, ["github_pat_fine_grained_token_value_xyz"]);
});

test("VAL-AUTH-001: gh fallback runs ONLY when fill returns no password=", async () => {
  // fill succeeds (exit 0) but emits no password line -> fall back to gh.
  const { exec, calls } = makeExec({
    git: () => ({ stdout: "protocol=https\nhost=github.com\n", failed: false }),
    gh: () => ({ stdout: "ghp_from_gh_auth_token_value_98765\n", failed: false }),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("bob"),
  });
  assert.ok(cred);
  assert.equal(cred!.token, "ghp_from_gh_auth_token_value_98765");
  assert.equal(cred!.source, "classic");
  // Order: git first, gh second. The gh fallback is host-pinned to github.com.
  assert.equal(calls[0]!.command, "git");
  assert.equal(calls[1]!.command, "gh");
  assert.deepEqual(calls[1]!.args, ["auth", "token", "--hostname", "github.com"]);
});

test("VAL-AUTH-001: returns null when NEITHER source yields a token", async () => {
  const { exec, calls } = makeExec({
    git: () => ({ stdout: "protocol=https\nhost=github.com\n", failed: false }),
    gh: () => ({ stdout: "\n", failed: false }),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("nobody"),
  });
  assert.equal(cred, null);
  // Both seams were consulted before giving up.
  assert.equal(calls[0]!.command, "git");
  assert.equal(calls[1]!.command, "gh");
});

// ===========================================================================
// VAL-AUTH-003 — off-TTY: zero exec-seam calls, no detection
// ===========================================================================

test("VAL-AUTH-003: off-TTY returns null WITHOUT calling the exec seam at all", async () => {
  const { exec, calls } = makeExec({
    git: () => fillHit("ghp_should_never_be_read_000000"),
    gh: () => ({ stdout: "ghp_should_never_be_read_111111\n", failed: false }),
  });
  let authCalled = false;
  const cred = await detectInheritedCredential({
    isTTY: () => false,
    exec,
    makeOctokit: () =>
      ({
        repos: { get: async () => ({ data: {} }) },
        users: {
          getAuthenticated: async () => {
            authCalled = true;
            return { data: { login: "x" } };
          },
        },
      }) as unknown as ResolverOctokit,
  });
  assert.equal(cred, null);
  assert.equal(calls.length, 0, "the exec seam is never called off-TTY");
  assert.equal(authCalled, false, "no network call off-TTY");
});

// ===========================================================================
// VAL-AUTH-005 — gh is optional: never shelled on fill success; absence non-fatal
// ===========================================================================

test("VAL-AUTH-005: fill success -> gh seam call-count is 0", async () => {
  const { exec, calls } = makeExec({
    git: () => fillHit("ghp_fill_wins_aaaaaaaaaaaaaaaa"),
    gh: () => {
      throw new Error("gh must NOT be invoked when fill succeeds");
    },
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("octo"),
  });
  assert.ok(cred);
  assert.equal(
    calls.filter((c) => c.command === "gh").length,
    0,
    "gh seam call-count is 0",
  );
});

test("VAL-AUTH-005: gh absent/errors + fill empty -> null, no throw", async () => {
  // git fill fails (e.g. no credential helper); gh errors (not installed).
  const { exec } = makeExec({
    git: () => ({ stdout: "", failed: true }),
    gh: () => ({ stdout: "", failed: true }),
  });
  let cred: unknown = "unset";
  await assert.doesNotReject(async () => {
    cred = await detectInheritedCredential({
      isTTY: () => true,
      exec,
      makeOctokit: loginFactory("never"),
    });
  });
  assert.equal(cred, null);
});

test("VAL-AUTH-005: the real defaultExec never rejects on a missing binary", async () => {
  // Drive the real exec seam (no injected exec) against a binary that does not
  // exist, proving a spawn error resolves as a clean miss rather than throwing.
  const { defaultExec } = await import("../src/inheritedAuth.js");
  const result = await defaultExec(
    "pr-backtest-no-such-binary-xyzzy",
    ["--nope"],
  );
  assert.equal(result.failed, true);
  assert.equal(result.stdout, "");
});

// ===========================================================================
// VAL-KEEP-003 — the inherited token is registered with the scrubber BEFORE its
// first use (here: before the getAuthenticated network call).
// ===========================================================================

test("VAL-KEEP-003: the inherited token is registered as a secret BEFORE the first network call", async () => {
  const TOKEN = "ghp_secret_inherited_value_deadbeef99";
  const { exec } = makeExec({ git: () => fillHit(TOKEN) });

  let redactedAtGetAuthenticated = "";
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: { get: async () => ({ data: {} }) },
      users: {
        getAuthenticated: async () => {
          // At the moment of the FIRST network call the token must already be
          // scrubbed: redact() of a string containing it returns ***.
          redactedAtGetAuthenticated = redact(`auth=${token}`);
          return { data: { login: "octocat" } };
        },
      },
    }) as unknown as ResolverOctokit;

  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: factory,
  });
  assert.ok(cred);
  assert.equal(
    redactedAtGetAuthenticated,
    "auth=***",
    "token was registered with the scrubber before getAuthenticated ran",
  );
  // And the resolved token itself, passed through redact, is scrubbed.
  assert.equal(redact(`token=${cred!.token}`), "token=***");
});

test("VAL-KEEP-003: a credential that cannot authenticate yields null (no throw)", async () => {
  const { exec } = makeExec({ git: () => fillHit("ghp_bad_token_value_0000000000") });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: () =>
      ({
        repos: { get: async () => ({ data: {} }) },
        users: {
          getAuthenticated: async () => {
            throw new Error("Bad credentials");
          },
        },
      }) as unknown as ResolverOctokit,
  });
  assert.equal(cred, null);
});

// ===========================================================================
// FIX 1 — defaultExec hardening: TTY-prompt env is wired, stdin EPIPE swallowed,
// the seam never rejects.
// ===========================================================================

test("FIX-1: the real defaultExec passes GIT_TERMINAL_PROMPT=0 + GCM_INTERACTIVE=never to the child", async () => {
  // Drive the REAL exec seam against a node child that prints the two hardening
  // env vars it inherited. This proves the no-TTY-prompt env is actually wired
  // through to git's environment (mirroring git.ts's gitEnv hardening), so a
  // locked keychain / credential helper cannot prompt and hang.
  const { defaultExec } = await import("../src/inheritedAuth.js");
  const result = await defaultExec(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({" +
      "t: process.env.GIT_TERMINAL_PROMPT, g: process.env.GCM_INTERACTIVE}))",
  ]);
  assert.equal(result.failed, false);
  const seen = JSON.parse(result.stdout) as { t: string; g: string };
  assert.equal(seen.t, "0", "GIT_TERMINAL_PROMPT=0 reaches the child");
  assert.equal(seen.g, "never", "GCM_INTERACTIVE=never reaches the child");
});

test("FIX-1: the timeout fires — a child that blocks past the bound resolves { failed: true }", async () => {
  // The whole point of the hang guard: a credential helper that never returns
  // (here, a node child that sleeps far past the bound) must NOT hang the tool.
  // Inject a tiny timeout so the kill fires fast; the seam must resolve a miss
  // (failed: true) well within a generous bound, proving the timeout is wired.
  const { defaultExec } = await import("../src/inheritedAuth.js");
  const start = Date.now();
  let result: ExecResult | undefined;
  await assert.doesNotReject(async () => {
    result = await defaultExec(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      undefined,
      50, // tiny injected hang-guard bound
    );
  });
  const elapsed = Date.now() - start;
  assert.ok(result, "the seam resolved");
  assert.equal(
    result!.failed,
    true,
    "a child that outlives the timeout is reported as a miss (failed: true)",
  );
  assert.ok(
    elapsed < 5000,
    `the timeout fired promptly (elapsed ${elapsed}ms ≪ the 60s child sleep)`,
  );
});

test("FIX-1: writing to a child that closes stdin immediately fires NO unhandled error (EPIPE swallowed)", async () => {
  // The stdin error listener (registered BEFORE end()) swallows the EPIPE from a
  // git child that exits before draining its stdin. Assert DETERMINISTICALLY:
  // register process-level unhandledRejection/uncaughtException spies and prove
  // they stay empty while writing a large stdin to a fast-exiting child. Removing
  // the `child.stdin.on("error", ...)` line would surface the EPIPE here.
  const { defaultExec } = await import("../src/inheritedAuth.js");
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const onException = (err: unknown): void => {
    unhandled.push(err);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  try {
    const big = "x".repeat(1024 * 256);
    let result: ExecResult | undefined;
    await assert.doesNotReject(async () => {
      result = await defaultExec(
        process.execPath,
        ["-e", "process.stdin.destroy(); process.exit(0)"],
        big,
      );
    });
    assert.ok(result, "the seam resolved");
    // Give any deferred stream 'error' event a tick to surface before we check.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      unhandled,
      [],
      "no unhandledRejection / uncaughtException fired while writing to a child that closed stdin",
    );
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
});

// ===========================================================================
// FIX 2 — host validation: fill's password is trusted ONLY when git echoes back
// host=github.com + protocol=https; gh fallback is host-pinned.
// ===========================================================================

test("FIX-2: a fill credential for a DIFFERENT host falls through to gh (host mismatch is a miss)", async () => {
  // git credential fill echoes back host=example.com — a helper with insteadOf /
  // enterprise config returning a wrong-host credential. The password must NOT be
  // trusted; detection falls through to the (host-pinned) gh fallback.
  const { exec, calls } = makeExec({
    git: () => ({
      stdout:
        "protocol=https\nhost=example.com\nusername=x-access-token\npassword=ghp_WRONG_HOST_token_00000\n",
      failed: false,
    }),
    gh: () => ({ stdout: "ghp_from_gh_after_host_mismatch_123\n", failed: false }),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("octocat"),
  });
  assert.ok(cred);
  assert.equal(
    cred!.token,
    "ghp_from_gh_after_host_mismatch_123",
    "the wrong-host fill password was rejected; the gh token won instead",
  );
  // gh WAS consulted (the host mismatch made fill a miss) and was host-pinned.
  const gh = calls.find((c) => c.command === "gh");
  assert.ok(gh, "gh was consulted after the host mismatch");
  assert.deepEqual(gh!.args, ["auth", "token", "--hostname", "github.com"]);
});

test("FIX-2: a fill credential for a GHE host (https) also falls through to gh", async () => {
  // protocol matches but host is an enterprise instance — still a mismatch.
  const { exec, calls } = makeExec({
    git: () => ({
      stdout:
        "protocol=https\nhost=ghe.corp.example\nusername=x-access-token\npassword=ghp_GHE_token_99999\n",
      failed: false,
    }),
    gh: () => ({ stdout: "ghp_github_com_token_after_ghe_77\n", failed: false }),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("octocat"),
  });
  assert.ok(cred);
  assert.equal(cred!.token, "ghp_github_com_token_after_ghe_77");
  assert.ok(calls.some((c) => c.command === "gh"), "gh consulted after GHE host");
});

test("FIX-2: host=github.com + protocol=https is ACCEPTED (gh never consulted)", async () => {
  // The exact host/protocol we asked for: the fill password is trusted directly.
  const { exec, calls } = makeExec({
    git: () => fillHit("ghp_correct_host_token_abcdef123456"),
    gh: () => {
      throw new Error("gh must NOT be consulted when fill host matches");
    },
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("octocat"),
  });
  assert.ok(cred);
  assert.equal(cred!.token, "ghp_correct_host_token_abcdef123456");
  assert.equal(
    calls.filter((c) => c.command === "gh").length,
    0,
    "gh is never consulted once a host-matching fill credential is accepted",
  );
});

test("FIX-2: an EMPTY password= value is a miss even with a matching host", async () => {
  // host/protocol match but password is empty → miss → fall through to gh.
  const { exec, calls } = makeExec({
    git: () => ({
      stdout: "protocol=https\nhost=github.com\nusername=x-access-token\npassword=\n",
      failed: false,
    }),
    gh: () => ({ stdout: "ghp_from_gh_after_empty_password_55\n", failed: false }),
  });
  const cred = await detectInheritedCredential({
    isTTY: () => true,
    exec,
    makeOctokit: loginFactory("octocat"),
  });
  assert.ok(cred);
  assert.equal(cred!.token, "ghp_from_gh_after_empty_password_55");
  assert.ok(calls.some((c) => c.command === "gh"), "empty password falls through to gh");
});
