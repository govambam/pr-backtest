import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUrl } from "../src/parseUrl.js";

const expected = { owner: "acme", repo: "api", number: 123 };

test("parses a canonical PR URL into {owner, repo, number}", () => {
  const result = parseUrl("https://github.com/acme/api/pull/123");
  assert.deepEqual(result, expected);
  // number must be an integer, not a string
  assert.equal(typeof result.number, "number");
  assert.ok(Number.isInteger(result.number));
});

test("tolerates a trailing slash", () => {
  assert.deepEqual(parseUrl("https://github.com/acme/api/pull/123/"), expected);
});

test("tolerates a trailing /files segment", () => {
  assert.deepEqual(
    parseUrl("https://github.com/acme/api/pull/123/files"),
    expected,
  );
});

test("tolerates a trailing /commits segment", () => {
  assert.deepEqual(
    parseUrl("https://github.com/acme/api/pull/123/commits"),
    expected,
  );
});

test("tolerates a ?query=... suffix", () => {
  assert.deepEqual(
    parseUrl("https://github.com/acme/api/pull/123?diff=split"),
    expected,
  );
});

test("tolerates a #hash suffix", () => {
  assert.deepEqual(
    parseUrl("https://github.com/acme/api/pull/123#discussion_r1"),
    expected,
  );
});

test("trailing slash, /files, and ?query all yield the same object", () => {
  const a = parseUrl("https://github.com/acme/api/pull/123/");
  const b = parseUrl("https://github.com/acme/api/pull/123/files");
  const c = parseUrl("https://github.com/acme/api/pull/123?w=1");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.deepEqual(a, expected);
});

test("preserves dots, hyphens, and underscores in owner/repo", () => {
  assert.deepEqual(parseUrl("https://github.com/my-org/cool.repo_v2/pull/7"), {
    owner: "my-org",
    repo: "cool.repo_v2",
    number: 7,
  });
});

test("throws on a non-GitHub host", () => {
  assert.throws(
    () => parseUrl("https://gitlab.com/acme/api/pull/123"),
    /Invalid GitHub PR URL/,
  );
});

test("throws on a repo URL with no /pull/<n>", () => {
  assert.throws(
    () => parseUrl("https://github.com/acme/api"),
    /Invalid GitHub PR URL/,
  );
});

test("throws on a non-numeric PR number", () => {
  assert.throws(
    () => parseUrl("https://github.com/acme/api/pull/abc"),
    /Invalid GitHub PR URL/,
  );
});

test("throws on an issues URL (wrong path segment)", () => {
  assert.throws(
    () => parseUrl("https://github.com/acme/api/issues/123"),
    /Invalid GitHub PR URL/,
  );
});

test("throws on a malformed / garbage string", () => {
  assert.throws(() => parseUrl("not a url at all"), /Invalid GitHub PR URL/);
});

test("throws on an empty string", () => {
  assert.throws(() => parseUrl(""), /Invalid PR URL/);
});

test("throws on a whitespace-only string", () => {
  assert.throws(() => parseUrl("   "), /Invalid PR URL/);
});
