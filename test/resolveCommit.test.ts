import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveHead,
  countCommitsUpToHead,
  type PrCommit,
} from "../src/resolveCommit.js";

// A small fixture PR, listed oldest-first: A -> B -> C.
const A = "a1b2c3d4e5f60708091a2b3c4d5e6f7081920304";
const B = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5";
const C = "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";

const commits: PrCommit[] = [
  { sha: A, parents: [{ sha: "f0e9d8c7b6a5040302010009080706050403020a" }] },
  { sha: B, parents: [{ sha: A }] },
  { sha: C, parents: [{ sha: B }] },
];

// The PR head is the last commit in the list.
const HEAD = C;

test("resolveHead(undefined): returns the PR head SHA (recreate the whole PR)", () => {
  // Even though HEAD is the last commit and not the first, the full-PR default
  // returns prHeadSha verbatim.
  assert.equal(resolveHead(undefined, commits, HEAD), HEAD);
});

test("resolveHead: exact full SHA match returns that commit's sha", () => {
  assert.equal(resolveHead(A, commits, HEAD), A);
  assert.equal(resolveHead(B, commits, HEAD), B);
});

test("resolveHead: abbreviated (>=7 char) prefix matches the full sha", () => {
  assert.equal(resolveHead(B.slice(0, 8), commits, HEAD), B);
});

test("resolveHead: case-insensitive matching", () => {
  assert.equal(resolveHead(A.toUpperCase(), commits, HEAD), A);
});

test("resolveHead: malformed values throw /Invalid --commit value/", () => {
  // not hex at all
  assert.throws(() => resolveHead("xyz", commits, HEAD), /Invalid --commit value/);
  // too short to be a usable abbreviation
  assert.throws(() => resolveHead("abc", commits, HEAD), /Invalid --commit value/);
  // hex but too short (< 7 chars)
  assert.throws(() => resolveHead("abc12", commits, HEAD), /Invalid --commit value/);
  // 7+ chars but contains non-hex characters
  assert.throws(() => resolveHead("zzzzzzz", commits, HEAD), /Invalid --commit value/);
  // a revision expression, not a SHA
  assert.throws(() => resolveHead("HEAD~1", commits, HEAD), /Invalid --commit value/);
});

test("resolveHead: a well-formed SHA matching no PR commit throws /does not match any commit/", () => {
  assert.throws(
    () => resolveHead("deadbeef", commits, HEAD),
    /does not match any commit/,
  );
});

test("resolveHead: an abbreviated prefix matching 2+ commits throws /ambiguous/", () => {
  // Two commits share a common 7-char hex prefix.
  const PREFIX = "abc1234";
  const dup1 = PREFIX + "00000000000000000000000000000000a";
  const dup2 = PREFIX + "11111111111111111111111111111111b";
  const ambiguous: PrCommit[] = [
    { sha: dup1, parents: [] },
    { sha: dup2, parents: [{ sha: dup1 }] },
  ];
  assert.throws(
    () => resolveHead(PREFIX, ambiguous, dup2),
    /ambiguous/,
  );
});

test("countCommitsUpToHead: full PR (head = last commit) returns commits.length", () => {
  assert.equal(countCommitsUpToHead(commits, C), commits.length);
  assert.equal(countCommitsUpToHead(commits, C), 3);
});

test("countCommitsUpToHead: a cutoff at the Nth commit returns N", () => {
  assert.equal(countCommitsUpToHead(commits, A), 1);
  assert.equal(countCommitsUpToHead(commits, B), 2);
});

test("countCommitsUpToHead: a head not present falls back to commits.length", () => {
  assert.equal(
    countCommitsUpToHead(commits, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    commits.length,
  );
});
