/**
 * CLI surface tests (subprocess harness).
 *
 * These run the BUILT CLI (`node dist/cli.js …`) in a child process so they
 * exercise the real commander wiring and the real `index.ts` exit-code mapping
 * end to end, exactly as a user would invoke the tool.
 *
 * Hermetic by construction: every spawn runs with a piped (non-TTY) stdin and a
 * scrubbed environment — `GITHUB_TOKEN` is cleared and `XDG_CONFIG_HOME` points
 * at an empty temp dir — so no real GitHub call is ever made and no saved token
 * or default destination can leak in from the host machine.
 *
 * Coverage:
 *  - `--help` advertises the new flags and no longer mentions `--fork`.
 *  - `--primary --sandbox x/y <url>` does NOT succeed and exits with the bad-args
 *    code (1). The precise both-flags rejection (DestinationArgsError "not both")
 *    is unit-tested in `destination.test.ts`. Because token resolution precedes
 *    destination resolution in `runBacktest`, a hermetic subprocess with no token
 *    reaches the bad-args exit (1) at the auth-or-resolver stage without any
 *    network; we assert exit 1 rather than parsing which guard fired, keeping the
 *    harness fully offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Run the built CLI offline (non-TTY stdin, scrubbed token + config home). */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const tmpConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "pr-backtest-cli-"));
  try {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      // Piped stdin → not a TTY → no interactive prompts, no gh fallback.
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GITHUB_TOKEN: "",
        XDG_CONFIG_HOME: tmpConfigHome,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    fs.rmSync(tmpConfigHome, { recursive: true, force: true });
  }
}

// --- --help flag surface ---

test("--help advertises --primary, --sandbox, and --create-sandbox", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /--primary/);
  assert.match(stdout, /--sandbox <owner\/repo>/);
  assert.match(stdout, /--create-sandbox/);
});

test("--help no longer mentions the removed --fork flag", () => {
  const { stdout } = runCli(["--help"]);
  assert.doesNotMatch(stdout, /--fork/);
});

// --- VAL-SCOPE: --full flag surface + new default wording ---

test("VAL-SCOPE-007: --help advertises --full and the new as-opened default wording", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /--full/, "--full appears in help");
  // The description/help reflects the new default (the PR "as opened").
  assert.match(stdout, /as it was opened|as opened/, "help describes the as-opened default");
});

test("VAL-SCOPE-005: --full and --commit together exits 1 before any network", () => {
  const { status, stderr, stdout } = runCli([
    "--full",
    "--commit",
    "a1b2c3d",
    "https://github.com/acme/api/pull/123",
  ]);
  assert.equal(status, 1, "both --full and --commit is a bad-args exit 1");
  assert.match(stderr, /either --full .* or --commit/, "the message names both flags");
  // No token error and no success PR URL — the fast-fail fired before any work.
  assert.doesNotMatch(stderr, /token/i);
  assert.doesNotMatch(stdout, /https:\/\/github\.com\/.*\/pull\/\d+/);
});

// --- environment variable documentation (VAL-CLI-001) ---

test("--help documents GITHUB_TOKEN and GITHUB_SOURCE_TOKEN env vars", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /GITHUB_TOKEN/, "GITHUB_TOKEN is documented");
  assert.match(
    stdout,
    /GITHUB_SOURCE_TOKEN/,
    "GITHUB_SOURCE_TOKEN (read-only source token) is documented",
  );
});

test("--help includes a worked cross-owner Examples section", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /Examples:/, "an Examples heading is present");
  // The cross-owner sandbox invocation appears verbatim (both flags on one line).
  assert.match(
    stdout,
    /--sandbox myuser\/pr-backtest-sandbox --create-sandbox/,
    "the cross-owner --sandbox + --create-sandbox example is shown",
  );
});

test("--help adds NO new destination flag — the set is exactly --primary, --sandbox, --create-sandbox", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  // The owner in --sandbox <owner/repo> expresses org-vs-personal-vs-different;
  // there must be no separate destination flag (e.g. --org, --personal, --dest).
  const destinationFlags = (stdout.match(/--[a-z][a-z-]*/g) ?? []).filter((f) =>
    /^--(primary|sandbox|create-sandbox|org|organization|personal|dest|destination|target|owner|fork)$/.test(
      f,
    ),
  );
  assert.deepEqual(
    [...new Set(destinationFlags)].sort(),
    ["--create-sandbox", "--primary", "--sandbox"],
    "exactly the three documented destination flags, no new one",
  );
});

// --- --verbose flag surface ---

test("--help lists --verbose and does not reassign -v", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /--verbose/, "--verbose appears in help");
  // -v stays bound to --version, NOT --verbose (no collision).
  assert.match(stdout, /-v, --version/, "-v is still the --version alias");
});

test("-v / --version still prints the version (no collision with --verbose)", () => {
  const pkgVersion = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ).version as string;

  const short = runCli(["-v"]);
  assert.equal(short.status, 0, "-v exits 0");
  assert.equal(short.stdout.trim(), pkgVersion, "-v prints the version");

  const long = runCli(["--version"]);
  assert.equal(long.status, 0, "--version exits 0");
  assert.equal(long.stdout.trim(), pkgVersion, "--version prints the version");
});

test("omitting --verbose yields verbose off (no per-request trace lines on a failed offline run)", () => {
  // A hermetic run with no token exits before any work; the point here is that
  // WITHOUT --verbose the run never emits the dim `→ GET …` per-request trace
  // lines that only verbose mode prints. (Channel/printing is unit-tested in
  // trace.test.ts; this is the CLI-level default-off assertion.)
  const { stderr } = runCli(["https://github.com/acme/api/pull/123"]);
  assert.doesNotMatch(stderr, /→ (GET|POST)\s+\//, "no per-request trace line by default");
});

// --- both flags do not succeed, exit 1 ---

test("--primary and --sandbox together exits 1 with a conflict message, no token error", () => {
  const { status, stdout, stderr } = runCli([
    "--primary",
    "--sandbox",
    "x/y",
    "https://github.com/acme/api/pull/123",
  ]);
  assert.equal(status, 1, "both-flags invocation exits with the bad-args code 1");
  // The EARLY guard (index.ts step 1b) fires before token resolution, so the
  // message is the flag-conflict message — NOT a token error (which would be
  // exit 2). This proves bad args are validated before any network call.
  assert.match(stderr, /--primary or --sandbox, not both/);
  assert.doesNotMatch(stderr, /token/i);
  // It must not have produced a success PR URL on stdout.
  assert.doesNotMatch(stdout, /https:\/\/github\.com\/.*\/pull\/\d+/);
});
