import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveHead, type PrCommit } from "../src/resolveCommit.js";

const PR_HEAD = "e".repeat(40);

test("an abbreviated SHA that matches multiple PR commits is rejected as ambiguous", () => {
  const parent = "f".repeat(40);
  const commits: PrCommit[] = [
    { sha: "abcdef1" + "0".repeat(33), parents: [{ sha: parent }] },
    { sha: "abcdef1" + "1".repeat(33), parents: [{ sha: parent }] },
  ];
  assert.throws(
    () => resolveHead("abcdef1", commits, PR_HEAD),
    /ambiguous/,
  );
});

test("an uppercase, whitespace-padded SHA is normalized and still matches", () => {
  const full = "abc1234" + "0".repeat(33);
  const commits: PrCommit[] = [{ sha: full, parents: [] }];
  assert.equal(resolveHead("  ABC1234  ", commits, PR_HEAD), full);
});

test("a 6-char value is rejected as malformed", () => {
  const commits: PrCommit[] = [{ sha: "abcdef1" + "0".repeat(33), parents: [] }];
  assert.throws(
    () => resolveHead("abcdef", commits, PR_HEAD),
    /Invalid --commit value/,
  );
});

test("a 7-char value clears the malformed boundary (no-match, not malformed)", () => {
  const commits: PrCommit[] = [{ sha: "abcdef1" + "0".repeat(33), parents: [] }];
  assert.throws(() => resolveHead("9999999", commits, PR_HEAD), (err: Error) => {
    assert.match(err.message, /does not match any commit/);
    assert.doesNotMatch(err.message, /Invalid --commit value/);
    return true;
  });
});

test("a 7-char value that prefix-matches is accepted", () => {
  const full = "abcdef1" + "0".repeat(33);
  const commits: PrCommit[] = [{ sha: full, parents: [] }];
  assert.equal(resolveHead("abcdef1", commits, PR_HEAD), full);
});
