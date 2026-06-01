import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveBase, resolveTarget, type PrCommit } from "../src/resolveCommit.js";

test("resolveBase throws for a root commit (no listed parent, lookup returns empty)", () => {
  const root: PrCommit = { sha: "a".repeat(40), parents: [] };
  assert.throws(() => resolveBase(root, () => ""), /root commit/);
});

test("resolveBase falls back to the injected lookup when no listed parent exists", () => {
  const target: PrCommit = { sha: "a".repeat(40), parents: [] };
  assert.equal(resolveBase(target, () => "b".repeat(40)), "b".repeat(40));
});

test("an abbreviated SHA that matches multiple PR commits is rejected as ambiguous", () => {
  const parent = "f".repeat(40);
  const commits: PrCommit[] = [
    { sha: "abcdef1" + "0".repeat(33), parents: [{ sha: parent }] },
    { sha: "abcdef1" + "1".repeat(33), parents: [{ sha: parent }] },
  ];
  assert.throws(
    () => resolveTarget("abcdef1", commits),
    /ambiguous/,
  );
});
