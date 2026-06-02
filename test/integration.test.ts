/**
 * Gated end-to-end integration test.
 *
 * WHAT THIS DOES
 * --------------
 * When `GITHUB_TOKEN` is set, this test drives the built CLI end-to-end against
 * a public fixture PR and asserts three properties:
 *   1. The created PR's diff matches the FULL PR diff (merge-base..head), since
 *      the tool recreates the whole PR by default.
 *   2. The pushed branches are named `backtest-pr<N>-<shortSha>-base` /
 *      `backtest-pr<N>-<shortSha>-head` (the PR head/tip short SHA).
 *   3. Cleanup happened — no leftover `/tmp/pr-backtest-*` directory remains.
 *
 * It shells out to `node dist/cli.js <fixture-pr> -y` (rather than importing
 * `runBacktest` directly) because `runBacktest` calls `process.exit`, which would
 * tear down the test runner. Shelling out also exercises the real binary path.
 *
 * GATING
 * ------
 * The whole test is SKIPPED unless `GITHUB_TOKEN` is set, so `npm test` stays
 * green for contributors with no token.
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
    // Sanity: GITHUB_TOKEN must be present for this branch.
    assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN must be set to run this test");

    const { owner, repo, number } = parseUrl(FIXTURE_PR);
    const octokit = new Octokit({ auth: token });

    // Pre-compute the expected head/base the way the tool does (no --commit ->
    // recreate the WHOLE PR), so we can compare the resulting PR against it.
    // Head is the PR tip (prData.head.sha); base is the PR's merge-base, the
    // commit GitHub diffs the PR against.
    const prData = await octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    const headSha = prData.data.head.sha;
    const compareBase = await octokit.repos.compareCommits({
      owner,
      repo,
      base: prData.data.base.sha,
      head: headSha,
    });
    const mergeBase = compareBase.data.merge_base_commit.sha;

    const beforeTemp = leftoverTempDirs();

    // Drive the real binary, non-interactive. stdout's final line is the PR URL.
    const stdout = execFileSync("node", [CLI, FIXTURE_PR, "-y"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: token },
    });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const prUrl = lines[lines.length - 1];
    assert.match(prUrl, /\/pull\/\d+$/, "final stdout line should be the created PR URL");

    // 2. Branch names follow the backtest-pr<N>-<shortSha>-{head,base} convention,
    //    where <shortSha> is the PR HEAD (tip) short SHA.
    const shortSha = headSha.slice(0, 7);
    const headBranch = `backtest-pr${number}-${shortSha}-head`;
    const baseBranch = `backtest-pr${number}-${shortSha}-base`;
    const createdNumber = Number(prUrl.split("/").pop());
    const created = await octokit.pulls.get({
      owner,
      repo,
      pull_number: createdNumber,
    });
    assert.equal(created.data.head.ref, headBranch, "head branch name");
    assert.equal(created.data.base.ref, baseBranch, "base branch name");
    // The default recreation spans the WHOLE PR: head at the PR tip, base at the
    // PR's merge-base.
    assert.equal(created.data.head.sha, headSha, "head is at the PR tip (full PR)");
    assert.equal(created.data.base.sha, mergeBase, "base is at the PR merge-base");

    // 1. The created PR's diff matches the FULL PR diff. Compare the set of
    //    changed files of the backtest PR against the file set of the original
    //    PR's full diff (merge-base..head).
    const prFiles = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: createdNumber,
      per_page: 100,
    });
    const fullDiff = await octokit.repos.compareCommits({
      owner,
      repo,
      base: mergeBase,
      head: headSha,
    });
    const prFileSet = new Set(prFiles.map((f) => f.filename).sort());
    const fullDiffFileSet = new Set((fullDiff.data.files ?? []).map((f) => f.filename).sort());
    assert.deepEqual(
      [...prFileSet],
      [...fullDiffFileSet],
      "changed-file set of the backtest PR matches the full PR diff",
    );

    // 3. Cleanup: the run must not leave a new /tmp/pr-backtest-* dir behind.
    const afterTemp = leftoverTempDirs();
    const leaked = afterTemp.filter((d) => !beforeTemp.includes(d));
    assert.deepEqual(leaked, [], "no leftover /tmp/pr-backtest-* dir after run");
  },
);
