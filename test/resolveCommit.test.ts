import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveHead,
  resolveAsOpened,
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

test("resolveHead: exact full SHA match returns that commit's sha", () => {
  assert.equal(resolveHead(A, commits), A);
  assert.equal(resolveHead(B, commits), B);
});

test("resolveHead: abbreviated (>=7 char) prefix matches the full sha", () => {
  assert.equal(resolveHead(B.slice(0, 8), commits), B);
});

test("resolveHead: case-insensitive matching", () => {
  assert.equal(resolveHead(A.toUpperCase(), commits), A);
});

test("resolveHead: malformed values throw /Invalid --commit value/", () => {
  // not hex at all
  assert.throws(() => resolveHead("xyz", commits), /Invalid --commit value/);
  // too short to be a usable abbreviation
  assert.throws(() => resolveHead("abc", commits), /Invalid --commit value/);
  // hex but too short (< 7 chars)
  assert.throws(() => resolveHead("abc12", commits), /Invalid --commit value/);
  // 7+ chars but contains non-hex characters
  assert.throws(() => resolveHead("zzzzzzz", commits), /Invalid --commit value/);
  // a revision expression, not a SHA
  assert.throws(() => resolveHead("HEAD~1", commits), /Invalid --commit value/);
});

test("resolveHead: a well-formed SHA matching no PR commit throws /does not match any commit/", () => {
  assert.throws(
    () => resolveHead("deadbeef", commits),
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
    () => resolveHead(PREFIX, ambiguous),
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

// --- VAL-SCOPE: the "PR as opened" picker (resolveAsOpened) -----------------

// A stable creation instant used as the cutoff T in the as-opened cases below.
const T = "2026-01-01T12:00:00Z";
const BEFORE_1 = "2025-12-31T00:00:00Z";
const BEFORE_2 = "2025-12-31T12:00:00Z";
const AFTER_1 = "2026-01-01T12:00:01Z";
const AFTER_2 = "2026-01-02T00:00:00Z";

/** Three SHAs for the as-opened fixtures (distinct from A/B/C above). */
const C0 = "0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const C1 = "1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C2 = "2222222cccccccccccccccccccccccccccccccccc";
const C3 = "3333333dddddddddddddddddddddddddddddddddd";

test("VAL-SCOPE-001: STRADDLE (c0,c1 <= T; c2 > T) → head c1, count 2, narrowed", () => {
  const straddle: PrCommit[] = [
    { sha: C0, parents: [], committedDate: BEFORE_1 },
    { sha: C1, parents: [{ sha: C0 }], committedDate: BEFORE_2 },
    { sha: C2, parents: [{ sha: C1 }], committedDate: AFTER_1 },
  ];
  const r = resolveAsOpened(straddle, T, C2);
  assert.equal(r.headSha, C1, "as-opened head is the last commit <= T");
  assert.equal(r.count, 2, "count is k (2 of 3)");
  assert.equal(r.narrowed, true);
  assert.equal(r.indeterminate, false);
});

test("VAL-SCOPE-001: a commit dated EXACTLY == T is INCLUDED (boundary inclusive)", () => {
  // c1 is committed exactly at T; it must stay in the as-opened set, and c2
  // (after T) is the first excluded commit → head c1.
  const commitsAtBoundary: PrCommit[] = [
    { sha: C0, parents: [], committedDate: BEFORE_1 },
    { sha: C1, parents: [{ sha: C0 }], committedDate: T },
    { sha: C2, parents: [{ sha: C1 }], committedDate: AFTER_1 },
  ];
  const r = resolveAsOpened(commitsAtBoundary, T, C2);
  assert.equal(r.headSha, C1, "a commit dated == T is in the as-opened set");
  assert.equal(r.count, 2);
  assert.equal(r.narrowed, true);
});

test("VAL-SCOPE-001: a non-monotonic chain stops at the FIRST commit > T (later <T excluded)", () => {
  // c0,c1 <= T; c2 > T (first after); c3 < T but it comes AFTER the first >T, so
  // it must NOT re-enter the set → head c1, count 2, c3 excluded.
  const nonMonotonic: PrCommit[] = [
    { sha: C0, parents: [], committedDate: BEFORE_1 },
    { sha: C1, parents: [{ sha: C0 }], committedDate: BEFORE_2 },
    { sha: C2, parents: [{ sha: C1 }], committedDate: AFTER_2 },
    { sha: C3, parents: [{ sha: C2 }], committedDate: BEFORE_1 },
  ];
  const r = resolveAsOpened(nonMonotonic, T, C3);
  assert.equal(r.headSha, C1, "the scan stops at the first commit > T");
  assert.equal(r.count, 2, "the stray later <T commit does not re-enter the set");
  assert.equal(r.narrowed, true);
});

test('VAL-SCOPE-001: only c0 <= T → head c0, count 1', () => {
  const onlyFirst: PrCommit[] = [
    { sha: C0, parents: [], committedDate: BEFORE_1 },
    { sha: C1, parents: [{ sha: C0 }], committedDate: AFTER_1 },
    { sha: C2, parents: [{ sha: C1 }], committedDate: AFTER_2 },
  ];
  const r = resolveAsOpened(onlyFirst, T, C2);
  assert.equal(r.headSha, C0);
  assert.equal(r.count, 1);
  assert.equal(r.narrowed, true);
});

test("VAL-SCOPE-002: ALL_BEFORE (every commit <= T) → PR head, full count, narrowed=false", () => {
  const allBefore: PrCommit[] = [
    { sha: C0, parents: [], committedDate: BEFORE_1 },
    { sha: C1, parents: [{ sha: C0 }], committedDate: BEFORE_2 },
    { sha: C2, parents: [{ sha: C1 }], committedDate: BEFORE_2 },
  ];
  const r = resolveAsOpened(allBefore, T, C2);
  assert.equal(r.headSha, C2, "as-opened head is the PR head (all commits)");
  assert.equal(r.count, 3);
  assert.equal(r.narrowed, false);
  assert.equal(r.indeterminate, false);
});

test("VAL-SCOPE-006: ALL_AFTER (k==0, even the first commit > T) → indeterminate, falls back to PR head", () => {
  const allAfter: PrCommit[] = [
    { sha: C0, parents: [], committedDate: AFTER_1 },
    { sha: C1, parents: [{ sha: C0 }], committedDate: AFTER_2 },
  ];
  const r = resolveAsOpened(allAfter, T, C1);
  assert.equal(r.indeterminate, true, "k==0 is indeterminate (likely rebased)");
  assert.equal(r.headSha, C1, "falls back to the PR head");
  assert.equal(r.count, 2);
  assert.equal(r.narrowed, false);
});

test("resolveAsOpened: a commit with no committer date is treated as <= T (kept)", () => {
  const noDates: PrCommit[] = [
    { sha: C0, parents: [] },
    { sha: C1, parents: [{ sha: C0 }] },
  ];
  const r = resolveAsOpened(noDates, T, C1);
  assert.equal(r.headSha, C1, "missing dates → kept → full PR");
  assert.equal(r.count, 2);
  assert.equal(r.narrowed, false);
  assert.equal(r.indeterminate, false);
});

test("resolveAsOpened: an empty commit list returns the PR head, not narrowed", () => {
  const r = resolveAsOpened([], T, C2);
  assert.equal(r.headSha, C2);
  assert.equal(r.count, 0);
  assert.equal(r.narrowed, false);
  assert.equal(r.indeterminate, false);
});
