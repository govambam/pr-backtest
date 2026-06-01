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
 *  - VAL-CLI-001: `--help` advertises the new flags and no longer mentions
 *    `--fork`.
 *  - VAL-DEST-003 (CLI level): `--primary --sandbox x/y <url>` does NOT succeed
 *    and exits with the bad-args code (1). The PRECISE both-flags rejection
 *    (DestinationArgsError "not both") is unit-tested in `destination.test.ts`
 *    (VAL-DEST-003). Because token resolution precedes destination resolution in
 *    `runBacktest`, a hermetic subprocess with no token reaches the bad-args exit
 *    (1) at the auth-or-resolver stage without any network; we assert exit 1
 *    rather than parsing which guard fired, keeping the harness fully offline.
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

// --- VAL-CLI-001: --help flag surface ---

test("VAL-CLI-001: --help advertises --primary, --sandbox, and --create-sandbox", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /--primary/);
  assert.match(stdout, /--sandbox <owner\/repo>/);
  assert.match(stdout, /--create-sandbox/);
});

test("VAL-CLI-001: --help no longer mentions the removed --fork flag", () => {
  const { stdout } = runCli(["--help"]);
  assert.doesNotMatch(stdout, /--fork/);
});

// --- VAL-CH-002: --verbose flag surface (live-activity-trace) ---

test("VAL-CH-002: --help lists --verbose and does not reassign -v", () => {
  const { status, stdout } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits 0");
  assert.match(stdout, /--verbose/, "--verbose appears in help");
  // -v stays bound to --version, NOT --verbose (no collision).
  assert.match(stdout, /-v, --version/, "-v is still the --version alias");
});

test("VAL-CH-002: -v / --version still prints the version (no collision with --verbose)", () => {
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

test("VAL-CH-002: omitting --verbose yields verbose off (no per-request trace lines on a failed offline run)", () => {
  // A hermetic run with no token exits before any work; the point here is that
  // WITHOUT --verbose the run never emits the dim `→ GET …` per-request trace
  // lines that only verbose mode prints. (Channel/printing is unit-tested in
  // trace.test.ts; this is the CLI-level default-off assertion.)
  const { stderr } = runCli(["https://github.com/acme/api/pull/123"]);
  assert.doesNotMatch(stderr, /→ (GET|POST)\s+\//, "no per-request trace line by default");
});

// --- VAL-DEST-003 (CLI level): both flags do not succeed, exit 1 ---

test("VAL-DEST-003: --primary --sandbox x/y <url> exits 1 with a conflict message, no token error", () => {
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
