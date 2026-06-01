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
