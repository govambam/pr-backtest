import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUnfetchableMessage,
  redactedRepoRef,
  repoHttpsUrl,
  UnfetchableCommitError,
} from "../src/git.js";

test("buildUnfetchableMessage interpolates the SHA and PR number into both fallback lines", () => {
  const msg = buildUnfetchableMessage("abc1234", 42);
  assert.match(msg, /^Could not fetch commit abc1234 from origin\./);
  assert.match(msg, /git push origin abc1234:refs\/heads\/backtest-pr42-head/);
  assert.match(msg, /git push origin abc1234\^:refs\/heads\/backtest-pr42-base/);
});

test("UnfetchableCommitError.message equals buildUnfetchableMessage and carries fields", () => {
  const err = new UnfetchableCommitError("deadbeef", 7);
  assert.equal(err.message, buildUnfetchableMessage("deadbeef", 7));
  assert.equal(err.sha, "deadbeef");
  assert.equal(err.prNumber, 7);
});

test("repoHttpsUrl carries only the x-access-token username, never a secret", () => {
  const url = repoHttpsUrl("acme", "api");
  assert.equal(url, "https://x-access-token@github.com/acme/api.git");
  // The username is not a secret; there must be no ":password@" component.
  assert.doesNotMatch(url, /x-access-token:[^@]+@/);
});

test("redactedRepoRef is a token-free, log-safe reference", () => {
  assert.equal(redactedRepoRef("acme", "api"), "github.com/acme/api");
});
