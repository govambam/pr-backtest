import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPlan, type PlanInput } from "../src/plan.js";

const base: PlanInput = {
  ownerRepo: "acme/api",
  prNumber: 123,
  prTitle: "Add retry logic",
  prAuthor: "stevem",
  targetSha: "a1b2c3d4e5f6",
  targetLabel: "initial commit",
  baseSha: "f0e9d8c7b6a5",
  headBranch: "backtest-pr123-head",
  baseBranch: "backtest-pr123-base",
};

test("non-fork plan creates everything in the PR's own repo, fetched from origin", () => {
  const out = renderPlan(base);
  assert.doesNotMatch(out, /Into:/);
  assert.match(out, /from origin/);
  assert.match(out, /Clone acme\/api/);
  assert.match(out, /Open PR in acme\/api/);
});

test("fork plan clones the fork, fetches from source, and opens the PR in the fork", () => {
  const out = renderPlan({ ...base, targetRepo: "myuser/myfork" });
  assert.match(out, /Into:\s+myuser\/myfork \(fork/);
  assert.match(out, /Clone myuser\/myfork/);
  assert.match(out, /from source \(acme\/api\)/);
  assert.match(out, /Push f0e9d8c → myuser\/myfork:backtest-pr123-base/);
  assert.match(out, /Open PR in myuser\/myfork: backtest-pr123-head → backtest-pr123-base/);
});

test("targetRepo equal to ownerRepo behaves like a non-fork plan", () => {
  const out = renderPlan({ ...base, targetRepo: "acme/api" });
  assert.doesNotMatch(out, /Into:/);
  assert.match(out, /from origin/);
});
