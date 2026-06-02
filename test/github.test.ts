/**
 * Unit tests for the Octokit wrappers in `src/github.ts` that need direct
 * coverage. Today: `verifyRepo`, the destination pre-flight check that drives
 * the read-only / write-permission guarantees. We inject a fake Octokit whose
 * `repos.get` returns or throws what each case needs — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getMergeBase, getPullRequest, verifyRepo } from "../src/github.js";
import type { Octokit } from "@octokit/rest";

/** An HTTP-status-bearing error shaped like an Octokit failure. */
function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Build a fake Octokit exposing only `repos.get`. `result` is returned as
 * `{ data }`; if `throws` is set, the call rejects with it instead.
 */
function makeFakeOctokit(opts: {
  result?: { permissions?: { push?: boolean } };
  throws?: unknown;
}): Octokit {
  const fake = {
    repos: {
      get: async () => {
        if (opts.throws !== undefined) throw opts.throws;
        return { data: opts.result ?? {} };
      },
    },
  };
  return fake as unknown as Octokit;
}

test("verifyRepo: permissions.push === true → { exists: true, canPush: true }", async () => {
  const octokit = makeFakeOctokit({ result: { permissions: { push: true } } });
  const result = await verifyRepo(octokit, "me", "sandbox");
  assert.deepEqual(result, { exists: true, canPush: true });
});

test("verifyRepo: permissions.push === false → { exists: true, canPush: false }", async () => {
  const octokit = makeFakeOctokit({ result: { permissions: { push: false } } });
  const result = await verifyRepo(octokit, "me", "ro");
  assert.deepEqual(result, { exists: true, canPush: false });
});

test("verifyRepo: missing permissions object → exists true, canPush false", async () => {
  const octokit = makeFakeOctokit({ result: {} });
  const result = await verifyRepo(octokit, "me", "no-perms");
  assert.deepEqual(result, { exists: true, canPush: false });
});

test("verifyRepo: 404 → { exists: false, canPush: false }", async () => {
  const octokit = makeFakeOctokit({ throws: httpError(404) });
  const result = await verifyRepo(octokit, "me", "gone");
  assert.deepEqual(result, { exists: false, canPush: false });
});

test("verifyRepo: non-404 error (403) is rethrown for the caller to map", async () => {
  const boom = httpError(403);
  const octokit = makeFakeOctokit({ throws: boom });
  await assert.rejects(
    () => verifyRepo(octokit, "me", "forbidden"),
    (err: unknown) => err === boom,
  );
});

test("verifyRepo: non-404 error (500) is rethrown", async () => {
  const octokit = makeFakeOctokit({ throws: httpError(500) });
  await assert.rejects(
    () => verifyRepo(octokit, "me", "broken"),
    (err: unknown) => err instanceof Error && (err as { status: number }).status === 500,
  );
});

test("getMergeBase: returns merge_base_commit.sha", async () => {
  const octokit = {
    repos: {
      compareCommits: async () => ({
        data: { merge_base_commit: { sha: "base-sha-123" } },
      }),
    },
  } as unknown as Octokit;
  const sha = await getMergeBase(octokit, "me", "repo", "main", "feature");
  assert.equal(sha, "base-sha-123");
});

test("getMergeBase: passes { owner, repo, base, head } through to compareCommits", async () => {
  let captured: unknown;
  const octokit = {
    repos: {
      compareCommits: async (args: unknown) => {
        captured = args;
        return { data: { merge_base_commit: { sha: "abc" } } };
      },
    },
  } as unknown as Octokit;
  await getMergeBase(octokit, "acme", "api", "main", "topic");
  assert.deepEqual(captured, {
    owner: "acme",
    repo: "api",
    base: "main",
    head: "topic",
  });
});

test("getPullRequest: maps pulls.get data to the PullRequest shape", async () => {
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          title: "Add feature",
          user: { login: "octocat" },
          head: { sha: "head-sha" },
          base: { sha: "base-sha", ref: "main" },
        },
      }),
    },
  } as unknown as Octokit;
  const result = await getPullRequest(octokit, "me", "repo", 7);
  assert.deepEqual(result, {
    title: "Add feature",
    user: "octocat",
    headSha: "head-sha",
    baseSha: "base-sha",
    baseRef: "main",
  });
});

test("getPullRequest: null user falls back to empty string", async () => {
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          title: "No author",
          user: null,
          head: { sha: "h" },
          base: { sha: "b", ref: "main" },
        },
      }),
    },
  } as unknown as Octokit;
  const result = await getPullRequest(octokit, "me", "repo", 9);
  assert.deepEqual(result, {
    title: "No author",
    user: "",
    headSha: "h",
    baseSha: "b",
    baseRef: "main",
  });
});
