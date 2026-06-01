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

// --- VAL-DEST-003 (CLI level): both flags do not succeed, exit 1 ---

test("VAL-DEST-003: --primary --sandbox x/y <url> exits 1 (bad args), no network", () => {
  const { status, stdout } = runCli([
    "--primary",
    "--sandbox",
    "x/y",
    "https://github.com/acme/api/pull/123",
  ]);
  assert.equal(status, 1, "both-flags invocation exits with the bad-args code 1");
  // It must not have produced a success PR URL on stdout.
  assert.doesNotMatch(stdout, /https:\/\/github\.com\/.*\/pull\/\d+/);
});
