import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRepoName, parseRepoSlug } from "../src/parseUrl.js";

test("parses a plain owner/repo slug", () => {
  assert.deepEqual(parseRepoSlug("myuser/myfork"), {
    owner: "myuser",
    repo: "myfork",
  });
});

test("tolerates a github.com URL, a .git suffix, and a trailing slash", () => {
  assert.deepEqual(parseRepoSlug("https://github.com/me/fork"), {
    owner: "me",
    repo: "fork",
  });
  assert.deepEqual(parseRepoSlug("me/fork.git"), { owner: "me", repo: "fork" });
  assert.deepEqual(parseRepoSlug("me/fork/"), { owner: "me", repo: "fork" });
});

test("allows dots, hyphens, and underscores in names", () => {
  assert.deepEqual(parseRepoSlug("my-org/my_repo.js"), {
    owner: "my-org",
    repo: "my_repo.js",
  });
});

test("rejects empty, single-segment, three-segment, and dot-only-segment input", () => {
  for (const bad of ["", "   ", "noslash", "a/b/c", "/", "owner/", "../x", "a/..", "./x"]) {
    assert.throws(() => parseRepoSlug(bad), /Invalid repository/);
  }
});

test("parseRepoName accepts a valid bare name (same rule as the repo segment)", () => {
  assert.equal(parseRepoName("my-sandbox"), "my-sandbox");
  assert.equal(parseRepoName("  api_backtest.js  "), "api_backtest.js");
});

test("parseRepoName rejects empty, dot-only, slashed, and bad-char names", () => {
  for (const bad of ["", "   ", ".", "..", "owner/name", "bad name", "x!y"]) {
    assert.throws(() => parseRepoName(bad), /Invalid repository name/);
  }
});
