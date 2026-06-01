import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTarget,
  resolveBase,
  type PrCommit,
  type GetParentSha,
} from "../src/resolveCommit.js";

// A small fixture PR: parent -> A -> B, with a leading merge commit M (2 parents).
const PARENT = "f0e9d8c7b6a5040302010009080706050403020a";
const A = "a1b2c3d4e5f60708091a2b3c4d5e6f7081920304";
const B = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5";
const M = "1234567890abcdef1234567890abcdef12345678";

const commits: PrCommit[] = [
  // merge commit first — must be skipped by `initial`
  { sha: M, parents: [{ sha: PARENT }, { sha: A }] },
  { sha: A, parents: [{ sha: PARENT }] },
  { sha: B, parents: [{ sha: A }] },
];

// getParentSha stub: should not be hit when commits carry their own parents.
const failParent: GetParentSha = (sha) => {
  throw new Error(`getParentSha should not have been called (sha=${sha})`);
};

/** Resolve the target + base in one step, the way index.ts wires them. */
function resolve(commitOption: string, getParentSha: GetParentSha) {
  const target = resolveTarget(commitOption, commits);
  return { targetSha: target.sha, baseSha: resolveBase(target, getParentSha) };
}

test("initial: selects the earliest non-merge commit, skipping a leading merge commit", () => {
  const result = resolve("initial", failParent);
  assert.equal(result.targetSha, A);
  assert.equal(result.baseSha, PARENT);
});

test("initial: throws a clear error when every commit is a merge commit", () => {
  const allMerges: PrCommit[] = [
    { sha: M, parents: [{ sha: PARENT }, { sha: A }] },
  ];
  assert.throws(
    () => resolveTarget("initial", allMerges),
    /no non-merge commits/,
  );
});

test("explicit full SHA: matched directly, base is its parent", () => {
  const result = resolve(B, failParent);
  assert.equal(result.targetSha, B);
  assert.equal(result.baseSha, A);
});

test("explicit abbreviation (>=7 chars): prefix-matches the full SHA", () => {
  const result = resolve(B.slice(0, 8), failParent);
  assert.equal(result.targetSha, B);
  assert.equal(result.baseSha, A);
});

test("explicit SHA: case-insensitive matching", () => {
  const result = resolve(A.toUpperCase(), failParent);
  assert.equal(result.targetSha, A);
  assert.equal(result.baseSha, PARENT);
});

test("non-member SHA is rejected with a clear error", () => {
  assert.throws(
    () => resolveTarget("deadbeef", commits),
    /does not match any commit/,
  );
});

test("invalid --commit input (not initial, not a >=7-char hex SHA) is rejected", () => {
  assert.throws(
    () => resolveTarget("HEAD~1", commits),
    /Invalid --commit value/,
  );
  // too short to be a usable abbreviation
  assert.throws(
    () => resolveTarget("abc12", commits),
    /Invalid --commit value/,
  );
  // non-hex characters
  assert.throws(
    () => resolveTarget("zzzzzzz", commits),
    /Invalid --commit value/,
  );
});

test("invalid input is rejected BEFORE any parent lookup", () => {
  let called = false;
  const trackingParent: GetParentSha = () => {
    called = true;
    return PARENT;
  };
  // resolveTarget validates and throws before a base (and thus any parent
  // lookup) is ever computed.
  assert.throws(() => resolve("nope", trackingParent));
  assert.equal(called, false);
});

test("base = target's first parent (resolveBase)", () => {
  const target: PrCommit = { sha: B, parents: [{ sha: A }, { sha: PARENT }] };
  assert.equal(resolveBase(target, failParent), A);
});

test("base falls back to injected getParentSha when listed commit has no parents", () => {
  const target: PrCommit = { sha: A, parents: [] };
  const result = resolveBase(target, (sha) => {
    assert.equal(sha, A);
    return PARENT;
  });
  assert.equal(result, PARENT);
});

test("resolveTarget returns the full PrCommit (for callers needing parents)", () => {
  const target = resolveTarget("initial", commits);
  assert.equal(target.sha, A);
  assert.equal(target.parents[0]?.sha, PARENT);
});
