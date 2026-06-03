import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderPlan,
  confirmPlan,
  headScopeLabel,
  type PlanInput,
} from "../src/plan.js";

const input: PlanInput = {
  ownerRepo: "acme/api",
  prNumber: 123,
  prTitle: "Add retry logic to webhook handler",
  prAuthor: "stevem",
  headSha: "a1b2c3d4e5f6071829",
  headLabel: "PR head — 3 commits",
  baseSha: "f0e9d8c7b6a5040312",
  baseLabel: "merge-base with main",
  headBranch: "backtest-pr123-head",
  baseBranch: "backtest-pr123-base",
};

test("renderPlan includes the PR identity line", () => {
  const out = renderPlan(input);
  assert.match(
    out,
    /acme\/api#123 "Add retry logic to webhook handler" by @stevem/,
  );
});

test("renderPlan uses short (7-char) SHAs", () => {
  const out = renderPlan(input);
  assert.match(out, /a1b2c3d/);
  assert.match(out, /f0e9d8c/);
  // full SHAs must not leak into the rendered plan
  assert.ok(!out.includes("a1b2c3d4e5f6071829"));
  assert.ok(!out.includes("f0e9d8c7b6a5040312"));
});

test("renderPlan labels Head and Base lines (not Target)", () => {
  const out = renderPlan(input);
  assert.match(out, /Head:\s+a1b2c3d \(PR head — 3 commits\)/);
  assert.match(out, /Base:\s+f0e9d8c \(merge-base with main\)/);
  // The old "Target:" label and hardcoded "(parent of target)" are gone.
  assert.doesNotMatch(out, /Target:/);
  assert.doesNotMatch(out, /parent of target/);
});

test("renderPlan has a Plan: header and numbered steps", () => {
  const out = renderPlan(input);
  assert.match(out, /Plan:/);
  for (const n of [1, 2, 3, 4, 5]) {
    assert.match(out, new RegExp(`\\b${n}\\.`));
  }
  assert.match(out, /backtest-pr123-head/);
  assert.match(out, /backtest-pr123-base/);
});

// --- VAL-SCOPE-007: the four Head: scope labels (exact strings) -------------

test("VAL-SCOPE-007: headScopeLabel renders the exact scope strings", () => {
  // Default, narrowed: "k of M".
  assert.equal(headScopeLabel("as-opened", 2, 3), "as opened — 2 of 3 commits");
  // Default, nothing after open: "all N" (total is ignored for this form).
  assert.equal(headScopeLabel("as-opened-all", 3, 3), "as opened — all 3 commits");
  assert.equal(headScopeLabel("as-opened-all", 1, 1), "as opened — all 1 commit");
  // Default, indeterminate (branch rebased after open): falls back to the full PR
  // but says so, so the plan/body show it was a fallback.
  assert.equal(
    headScopeLabel("as-opened-fallback", 3, 3),
    "as opened unavailable — full PR — 3 commits",
  );
  // --full.
  assert.equal(headScopeLabel("full", 3, 3), "full PR — 3 commits");
  assert.equal(headScopeLabel("full", 1, 1), "full PR — 1 commit");
  // --commit cutoff (unchanged wording; total is ignored for this form).
  assert.equal(headScopeLabel("cutoff", 2, 3), "cutoff — 2 commits up to here");
  assert.equal(headScopeLabel("cutoff", 1, 3), "cutoff — 1 commit up to here");
});

test("VAL-SCOPE-007: the Head: line preserves its shape for every scope label", () => {
  // The `Head: <shortSha> (<label>)` shape must hold for each scope; only the
  // label text changes. The OLD default "PR head — <N> commits" must NOT appear.
  const cases: Array<[string, RegExp]> = [
    [headScopeLabel("as-opened", 2, 3), /Head:\s+a1b2c3d \(as opened — 2 of 3 commits\)/],
    [headScopeLabel("as-opened-all", 3, 3), /Head:\s+a1b2c3d \(as opened — all 3 commits\)/],
    [headScopeLabel("as-opened-fallback", 3, 3), /Head:\s+a1b2c3d \(as opened unavailable — full PR — 3 commits\)/],
    [headScopeLabel("full", 3, 3), /Head:\s+a1b2c3d \(full PR — 3 commits\)/],
    [headScopeLabel("cutoff", 2, 3), /Head:\s+a1b2c3d \(cutoff — 2 commits up to here\)/],
  ];
  for (const [label, re] of cases) {
    const out = renderPlan({ ...input, headLabel: label });
    assert.match(out, re);
    assert.doesNotMatch(out, /PR head — \d+ commits/, "the old default label must not render");
    // Base line shape stays intact alongside.
    assert.match(out, /Base:\s+f0e9d8c \(merge-base with main\)/);
  }
});

test("confirmPlan resolves true without prompting when yes is set", async () => {
  const result = await confirmPlan(input, { yes: true });
  assert.equal(result, true);
});

// --- Destination read/write split ---

test("dest == source: source is NOT tagged read-only, one repo for read+write", () => {
  // No targetRepo and an explicit equal targetRepo both mean destination == source.
  for (const planInput of [input, { ...input, targetRepo: "acme/api" }]) {
    const out = renderPlan(planInput);
    assert.doesNotMatch(out, /read-only/);
    assert.doesNotMatch(out, /Into:/);
    assert.match(out, /from origin/);
    assert.match(out, /Clone acme\/api/);
    assert.match(out, /Open PR in acme\/api/);
  }
});

test("dest != source: source tagged read-only, destination is the distinct write target", () => {
  const out = renderPlan({ ...input, targetRepo: "myuser/sandbox" });
  // Source repo line carries the read-only safety tag.
  assert.match(out, /acme\/api#123 .* by @stevem\s+\(read-only/);
  // Destination named as the place branches and the PR are created.
  assert.match(out, /Into:\s+myuser\/sandbox \(sandbox/);
  assert.match(out, /Clone myuser\/sandbox/);
  assert.match(out, /from source \(acme\/api\)/);
  assert.match(out, /Push f0e9d8c → myuser\/sandbox:backtest-pr123-base/);
  assert.match(
    out,
    /Open PR in myuser\/sandbox: backtest-pr123-head → backtest-pr123-base/,
  );
});

// --- Two-token annotations (VAL-PLAN-001/002/003) ---

test("VAL-PLAN-001: two-token run annotates source read-only token + dest write token", () => {
  const out = renderPlan({
    ...input,
    targetRepo: "myuser/sandbox",
    twoToken: true,
  });
  // Source (reading) line names the read-only token.
  assert.match(out, /acme\/api#123 .* \(read-only — source is never written \(read-only token\)\)/);
  // Destination (creating) line names the write token.
  assert.match(out, /Into:\s+myuser\/sandbox \(sandbox — branches and PR are created here \(write token\)\)/);
});

test("VAL-PLAN-002: one-token plan is byte-identical with twoToken false vs omitted", () => {
  // The flag defaults to false; an explicit false must not change a single byte.
  const primary = renderPlan(input);
  assert.equal(renderPlan({ ...input, twoToken: false }), primary);
  // And no token annotation leaks into the one-token output.
  assert.doesNotMatch(primary, /read-only token/);
  assert.doesNotMatch(primary, /write token/);

  // Same for a one-token SANDBOX run (dest differs, but a single token covers it):
  // the read-only safety tag is present but NO token annotations are added.
  const sandbox = renderPlan({ ...input, targetRepo: "myuser/sandbox" });
  assert.equal(renderPlan({ ...input, targetRepo: "myuser/sandbox", twoToken: false }), sandbox);
  assert.doesNotMatch(sandbox, /read-only token/);
  assert.doesNotMatch(sandbox, /write token/);
});

test("VAL-PLAN-003: the plan never prints a token value", () => {
  // renderPlan takes no token argument — but assert directly that even when a
  // run is two-token, no token-shaped string can appear in the output. We render
  // every plan variant and scan for token-shaped substrings.
  const variants = [
    renderPlan(input),
    renderPlan({ ...input, targetRepo: "myuser/sandbox" }),
    renderPlan({ ...input, targetRepo: "myuser/sandbox", twoToken: true }),
  ];
  // GitHub token shapes: classic `ghp_…`, fine-grained `github_pat_…`,
  // and the git askpass username `x-access-token`.
  const tokenShaped = /ghp_[A-Za-z0-9]|github_pat_|gho_|ghs_|x-access-token/;
  for (const out of variants) {
    assert.doesNotMatch(out, tokenShaped);
  }
});
