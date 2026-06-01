import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRepoSlug } from "../src/parseUrl.js";

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

test("rejects empty, single-segment, and three-segment input", () => {
  for (const bad of ["", "   ", "noslash", "a/b/c", "/", "owner/"]) {
    assert.throws(() => parseRepoSlug(bad), /Invalid --fork value/);
  }
});
