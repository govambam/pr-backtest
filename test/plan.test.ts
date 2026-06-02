import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPlan, confirmPlan, type PlanInput } from "../src/plan.js";

const input: PlanInput = {
  ownerRepo: "acme/api",
  prNumber: 123,
  prTitle: "Add retry logic to webhook handler",
  prAuthor: "stevem",
  targetSha: "a1b2c3d4e5f6071829",
  targetLabel: "initial commit",
  baseSha: "f0e9d8c7b6a5040312",
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

test("renderPlan has a Plan: header and numbered steps", () => {
  const out = renderPlan(input);
  assert.match(out, /Plan:/);
  for (const n of [1, 2, 3, 4, 5]) {
    assert.match(out, new RegExp(`\\b${n}\\.`));
  }
  assert.match(out, /backtest-pr123-head/);
  assert.match(out, /backtest-pr123-base/);
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
