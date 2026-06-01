/**
 * Tests for the API request trace hook installed in the single `makeOctokit`
 * factory (`src/github.ts`). These cover the `api-hook` feature's four
 * assertions:
 *
 *  - VAL-API-001: the hook fires exactly once per request (a fake `fetch`
 *    transport counts the underlying calls; one hook pass per request).
 *  - VAL-API-003: in verbose mode each request prints exactly one stderr line
 *    carrying method, path+query, status, and a `<N>ms` figure — and the request
 *    body never appears; in default mode no per-request line prints.
 *  - VAL-API-004: a request whose resolved host is not `api.github.com` makes
 *    the hook throw (a hard error, not a silent skip).
 *
 * The file is structured so later features (e.g. the full redact-net flow) can
 * add cases without reshaping these.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { SimpleGit } from "simple-git";

import { makeOctokit } from "../src/github.js";
import { fetchCommit } from "../src/git.js";
import {
  registerSecret,
  setVerbose,
  setTtyOverride,
  verboseLine,
} from "../src/log.js";

/** A fake `SimpleGit` whose `fetch` resolves — enough to drive `traceOp`. */
function fakeGitOk(): SimpleGit {
  return {
    fetch: async () => ({}) as never,
  } as unknown as SimpleGit;
}

/**
 * Capture everything written to `process.stderr` for the duration of `run`,
 * restoring the original writer afterwards. Returns the concatenated output.
 */
async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = "";
  // Replace with a recorder that swallows output (so test logs stay clean) and
  // records it for assertions.
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return buffer;
}

/**
 * Build a fake `fetch` that records each call and returns a canned JSON
 * response with the given status. `calls` accumulates the `[url, init]` pairs
 * the transport saw, so a test can count hook/transport passes and inspect the
 * request body that was (or was not) sent.
 */
function fakeFetch(
  status: number,
  body: unknown,
  calls: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // Force non-TTY + non-verbose by default; each test opts in explicitly.
  setTtyOverride(false);
  setVerbose(false);
});

afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

test("VAL-API-001: the hook fires once per request (N requests → N transport calls)", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const octokit = makeOctokit("ghp_sentinel_token_value_123");

  await octokit.request("GET /repos/{owner}/{repo}/pulls/{n}", {
    owner: "acme",
    repo: "api",
    n: 123,
    request: { fetch: fakeFetch(200, { number: 123 }, calls) },
  });
  await octokit.request("GET /repos/{owner}/{repo}", {
    owner: "acme",
    repo: "api",
    request: { fetch: fakeFetch(200, { id: 1 }, calls) },
  });
  await octokit.request("GET /user", {
    request: { fetch: fakeFetch(200, { login: "octocat" }, calls) },
  });

  // Three requests issued → the transport (and thus the hook wrapping it) ran
  // exactly three times.
  assert.equal(calls.length, 3);
});

test("VAL-API-003: verbose prints one line per request with method/path+query/status/<N>ms; body never appears", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  setVerbose(true);

  const out = await captureStderr(async () => {
    const octokit = makeOctokit("ghp_token");
    await octokit.request("GET /repos/{owner}/{repo}/pulls/{n}/commits", {
      owner: "acme",
      repo: "api",
      n: 123,
      per_page: 100,
      request: { fetch: fakeFetch(200, [{ sha: "abc" }], calls) },
    });
  });

  const lines = out.split("\n").filter((l) => l.includes("→"));
  assert.equal(lines.length, 1, `expected exactly one request line, got: ${out}`);
  const line = lines[0]!;
  assert.match(line, /GET/);
  // Path + query string are both present.
  assert.match(line, /\/repos\/acme\/api\/pulls\/123\/commits/);
  assert.match(line, /per_page=100/);
  // Status and elapsed figure.
  assert.match(line, /200/);
  assert.match(line, /\d+ms/);
  // The body of a GET is empty, but assert that no JSON payload leaks into the
  // trace under any circumstance.
  assert.ok(!line.includes("sha"), "request/response body must not appear in trace");
});

test("VAL-API-003: a request body is never written to the trace (POST)", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  setVerbose(true);
  const SECRET_BODY_MARKER = "do-not-leak-this-body-payload";

  const out = await captureStderr(async () => {
    const octokit = makeOctokit("ghp_token");
    await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: "acme",
      repo: "api",
      title: SECRET_BODY_MARKER,
      head: "h",
      base: "b",
      request: { fetch: fakeFetch(201, { html_url: "https://x" }, calls) },
    });
  });

  const lines = out.split("\n").filter((l) => l.includes("→"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /POST/);
  assert.match(lines[0]!, /201/);
  assert.ok(
    !out.includes(SECRET_BODY_MARKER),
    "the request body must never appear in any traced line",
  );
});

test("VAL-API-003: default mode (verbose off) prints zero per-request lines", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  // verbose stays false (beforeEach default).

  const out = await captureStderr(async () => {
    const octokit = makeOctokit("ghp_token");
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "acme",
      repo: "api",
      request: { fetch: fakeFetch(200, { id: 1 }, calls) },
    });
  });

  assert.equal(calls.length, 1, "the request still ran (hook still times it)");
  const lines = out.split("\n").filter((l) => l.includes("→"));
  assert.equal(lines.length, 0, `expected no per-request line, got: ${out}`);
});

test("VAL-GIT-003: on a TTY a git op rewrites its start line in place (carriage return)", async () => {
  setTtyOverride(true);
  const out = await captureStderr(async () => {
    await fetchCommit(fakeGitOk(), "9f3c1a2", 123, "source");
  });
  // TTY: the in-progress line is overwritten in place — a `\r` is present and
  // the completion marker (`✓`) appears.
  assert.ok(out.includes("\r"), `expected an in-place rewrite (\\r), got: ${JSON.stringify(out)}`);
  assert.match(out, /✓/);
});

test("VAL-GIT-003: with no TTY a git op prints only the completion line, no carriage returns", async () => {
  setTtyOverride(false);
  const out = await captureStderr(async () => {
    await fetchCommit(fakeGitOk(), "9f3c1a2", 123, "source");
  });
  assert.ok(!out.includes("\r"), `expected no carriage return off-TTY, got: ${JSON.stringify(out)}`);
  assert.match(out, /✓/);
});

test("VAL-SAFE-001: a sentinel token never appears across a full traced flow (API + git, verbose)", async () => {
  // A long, distinctive sentinel — registerSecret ignores values < 8 chars.
  const SENTINEL = "ghp_SENTINEL_token_value_should_never_leak_0001";
  registerSecret(SENTINEL);
  setVerbose(true);

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const out = await captureStderr(async () => {
    // The token is the SENTINEL: it travels via Octokit auth (never into a
    // traced line) and via GIT_ASKPASS in the real flow — here the fake git
    // never sees it, but we still register + verbose-trace both layers.
    const octokit = makeOctokit(SENTINEL);
    await octokit.request("GET /repos/{owner}/{repo}/pulls/{n}", {
      owner: "acme",
      repo: "api",
      n: 123,
      request: { fetch: fakeFetch(200, { number: 123 }, calls) },
    });
    // A git op trace line (constructed argv) in the same captured stderr.
    await fetchCommit(fakeGitOk(), "9f3c1a2", 123, "source");
  });

  // Across BOTH the API hook line and the git op line, the token never appears.
  assert.ok(
    !out.includes(SENTINEL),
    `the registered token must never appear in any traced line, got: ${out}`,
  );
  // Sanity: the trace actually ran (so the absence is meaningful, not vacuous).
  assert.match(out, /GET/);
  assert.match(out, /git fetch source/);
});

test("VAL-SAFE-001: redact() is the proven net — a sentinel passed INTO a trace line is scrubbed to ***", async () => {
  const SENTINEL = "ghp_SENTINEL_redact_net_proof_value_0002";
  registerSecret(SENTINEL);
  setVerbose(true);

  const out = await captureStderr(async () => {
    // Deliberately construct a line that CONTAINS the secret. If redact() were
    // not the net, this would leak; instead the secret must become `***`.
    verboseLine("token=" + SENTINEL);
  });

  assert.ok(!out.includes(SENTINEL), "the secret must be scrubbed from the line");
  assert.match(out, /token=\*\*\*/, "the secret is replaced with ***");
});

test("VAL-API-004: a request to a non-api.github.com host is a hard error (throws)", async () => {
  const octokit = makeOctokit("ghp_token");
  const calls: Array<{ url: string; init: RequestInit }> = [];

  await assert.rejects(
    () =>
      octokit.request("GET https://evil.example.com/x", {
        request: { fetch: fakeFetch(200, {}, calls) },
      }),
    /evil\.example\.com|only api\.github\.com/,
  );

  // The hook threw before the transport ran — no request reached the wire.
  assert.equal(calls.length, 0, "no request should reach a non-base host");
});
