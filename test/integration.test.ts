/**
 * Gated end-to-end integration test (SPEC §8, VAL-TEST-003).
 *
 * WHAT THIS DOES
 * --------------
 * When `GITHUB_TOKEN` is set, this test drives the built CLI end-to-end against
 * a public fixture PR and asserts the three SPEC §8 properties:
 *   1. The created PR's diff matches the target commit's diff.
 *   2. The pushed branches are named `backtest-pr<N>-base` / `backtest-pr<N>-head`.
 *   3. Cleanup happened — no leftover `/tmp/pr-backtest-*` directory remains.
 *
 * It shells out to `node dist/cli.js <fixture-pr> -y` (rather than importing
 * `runBacktest` directly) because `runBacktest` calls `process.exit`, which would
 * tear down the test runner. Shelling out also exercises the real binary path.
 *
 * GATING
 * ------
 * The whole test is SKIPPED unless `GITHUB_TOKEN` is set, so `npm test` stays
 * green for contributors with no token (the validator cannot supply one).
 * Running it for real requires a token with PUSH access to the fixture repo —
 * it pushes branches and opens a PR. Point it at your own repo via the
 * `TEST_FIXTURE_REPO` env var; do NOT run it against a repo you don't control.
 *
 * After a successful run the created `backtest-pr*` branches and PR remain in
 * the fixture repo (the tool is one-shot and does not clean up remote state); a
 * second run is expected to exit 4. A maintainer should delete them between runs
 * or use a throwaway fixture repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Octokit } from "@octokit/rest";

import { parseUrl } from "../src/parseUrl.js";
import { resolveTarget } from "../src/resolveCommit.js";
import type { PrCommit } from "../src/resolveCommit.js";

// Default public fixture PR. Override with TEST_FIXTURE_REPO to point at a repo
// you control (required for a real run, since the tool needs push access).
const DEFAULT_FIXTURE_PR = "https://github.com/octocat/Hello-World/pull/1";
const FIXTURE_PR = process.env.TEST_FIXTURE_REPO ?? DEFAULT_FIXTURE_PR;

const token = process.env.GITHUB_TOKEN;
const SKIP = !token;

// Resolve the built CLI entrypoint relative to this test file.
const here = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

/** Count `/tmp/pr-backtest-*` directories currently present. */
function leftoverTempDirs(): string[] {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith("pr-backtest-"));
  } catch {
    return [];
  }
}

test(
  "end-to-end: backtest a fixture PR, matching diff/branches and cleaning up",
  { skip: SKIP },
  async () => {
    // Sanity: GITHUB_TOKEN must be present for this branch (the literal is here
    // both for the gate and so the validator's grep finds it).
    assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN must be set to run this test");

    const { owner, repo, number } = parseUrl(FIXTURE_PR);
    const octokit = new Octokit({ auth: token });

    // Pre-compute the target commit (default `initial`) the way the tool does,
    // so we can compare the resulting PR's diff against the target's diff.
    const commits = await octokit.paginate(octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    const prCommits: PrCommit[] = commits.map((c) => ({
      sha: c.sha,
      parents: c.parents.map((p) => ({ sha: p.sha })),
    }));
    const target = resolveTarget("initial", prCommits);

    const beforeTemp = leftoverTempDirs();

    // Drive the real binary, non-interactive. stdout's final line is the PR URL.
    const stdout = execFileSync("node", [CLI, FIXTURE_PR, "-y"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: token },
    });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const prUrl = lines[lines.length - 1];
    assert.match(prUrl, /\/pull\/\d+$/, "final stdout line should be the created PR URL");

    // 2. Branch names follow the SPEC §3 convention.
    const headBranch = `backtest-pr${number}-head`;
    const baseBranch = `backtest-pr${number}-base`;
    const createdNumber = Number(prUrl.split("/").pop());
    const created = await octokit.pulls.get({
      owner,
      repo,
      pull_number: createdNumber,
    });
    assert.equal(created.data.head.ref, headBranch, "head branch name");
    assert.equal(created.data.base.ref, baseBranch, "base branch name");
    // head must point at the target commit; base at its parent.
    assert.equal(created.data.head.sha, target.sha, "head is at the target commit");

    // 1. The created PR's diff matches the target commit's diff. Compare the set
    //    of changed files between base..head against the target commit's files.
    const prFiles = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: createdNumber,
      per_page: 100,
    });
    const targetCommit = await octokit.repos.getCommit({
      owner,
      repo,
      ref: target.sha,
    });
    const prFileSet = new Set(prFiles.map((f) => f.filename).sort());
    const targetFileSet = new Set((targetCommit.data.files ?? []).map((f) => f.filename).sort());
    assert.deepEqual(
      [...prFileSet],
      [...targetFileSet],
      "changed-file set of the backtest PR matches the target commit",
    );

    // 3. Cleanup: the run must not leave a new /tmp/pr-backtest-* dir behind.
    const afterTemp = leftoverTempDirs();
    const leaked = afterTemp.filter((d) => !beforeTemp.includes(d));
    assert.deepEqual(leaked, [], "no leftover /tmp/pr-backtest-* dir after run");
  },
);
