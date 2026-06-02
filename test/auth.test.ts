import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveToken,
  resolveTokenSource,
  computeTokenNeeds,
  NoTokenNonInteractiveError,
  type TokenResolvers,
  type TokenPurpose,
} from "../src/auth.js";
import type { Config } from "../src/config.js";
import { makeOctokit } from "../src/github.js";
import { setVerbose, setTtyOverride, isVerbose, redact } from "../src/log.js";

const CFG: Config = {
  token: "github_pat_config",
  username: "configuser",
  source: "fine-grained",
};

// The trace surface in log.ts is a module-level singleton. These tests flip
// setVerbose/setTtyOverride; reset them unconditionally around every test so a
// throw before a test's own `finally` can't leak verbose/TTY state into later
// tests (mirrors the hooks already in git/trace/index test files).
beforeEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});
afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

// A resolver set where every step would succeed, so precedence is observable.
function makeResolvers(overrides: Partial<TokenResolvers> = {}): TokenResolvers {
  return {
    getEnvToken: () => "ghp_env",
    getConfig: () => CFG,
    getGhToken: async () => "gh_cli_token",
    getInteractiveToken: async () => "github_pat_pasted",
    ...overrides,
  };
}

// --- computeTokenNeeds: pure token-needs rule (spec §4, VAL-NEED-001..004) ---

/** The required purposes are the entries without an `optional` flag. */
function required(purposes: TokenPurpose[]): TokenPurpose[] {
  return purposes.filter((p) => p.optional !== true);
}

test("VAL-NEED-001: same-owner destination yields one purpose (no read/write split)", () => {
  const purposes = computeTokenNeeds({
    source: { owner: "acme", repo: "api" },
    destination: { owner: "acme", repo: "pr-backtest-sandbox" },
    sourcePrivate: true,
  });
  assert.equal(purposes.length, 1);
  assert.equal(required(purposes).length, 1);
  assert.equal(purposes[0]!.kind, "write");
  assert.equal(purposes[0]!.owner, "acme");
  assert.equal(purposes[0]!.repo, "pr-backtest-sandbox");
  assert.equal(purposes[0]!.optional, undefined);
});

test("VAL-NEED-001: same-owner Primary (destination == source repo) yields one purpose", () => {
  const purposes = computeTokenNeeds({
    source: { owner: "acme", repo: "api" },
    destination: { owner: "acme", repo: "api" },
    sourcePrivate: true,
  });
  assert.equal(purposes.length, 1);
  assert.equal(purposes[0]!.kind, "write");
});

test("VAL-NEED-002: cross-owner + private source yields exactly two purposes: read(source) + write(dest)", () => {
  const purposes = computeTokenNeeds({
    source: { owner: "acme", repo: "api" },
    destination: { owner: "alice", repo: "pr-backtest-sandbox" },
    sourcePrivate: true,
  });
  const req = required(purposes);
  assert.equal(req.length, 2);

  const read = req.find((p) => p.kind === "read");
  const write = req.find((p) => p.kind === "write");
  assert.ok(read, "a read purpose on the source is required");
  assert.ok(write, "a write purpose on the destination is required");
  assert.deepEqual(
    { owner: read!.owner, repo: read!.repo },
    { owner: "acme", repo: "api" },
  );
  assert.deepEqual(
    { owner: write!.owner, repo: write!.repo },
    { owner: "alice", repo: "pr-backtest-sandbox" },
  );
});

test("VAL-NEED-003: cross-owner + public source yields a single required write purpose; source read optional/anonymous", () => {
  const purposes = computeTokenNeeds({
    source: { owner: "acme", repo: "api" },
    destination: { owner: "alice", repo: "pr-backtest-sandbox" },
    sourcePrivate: false,
  });
  const req = required(purposes);
  assert.equal(req.length, 1, "exactly one REQUIRED purpose");
  assert.equal(req[0]!.kind, "write");
  assert.equal(req[0]!.owner, "alice");

  // Any source-read entry that exists must be flagged optional (anonymous).
  const reads = purposes.filter((p) => p.kind === "read");
  for (const r of reads) {
    assert.equal(r.optional, true, "source read for a public source must be optional/anonymous");
  }
});

test("VAL-NEED-004: self-owned source (login == source owner) resolves same-owner -> one purpose", () => {
  // Caller sets the personal-sandbox destination owner to the authenticated
  // login. When that login IS the source owner, the owners match -> one token.
  const authenticatedLogin = "alice";
  const purposes = computeTokenNeeds({
    source: { owner: "alice", repo: "api" },
    destination: { owner: authenticatedLogin, repo: "pr-backtest-sandbox" },
    sourcePrivate: true,
  });
  assert.equal(purposes.length, 1);
  assert.equal(required(purposes).length, 1);
  assert.equal(purposes[0]!.kind, "write");
  assert.equal(purposes[0]!.owner, "alice");
});

test("computeTokenNeeds compares owners case-insensitively (same-owner)", () => {
  const purposes = computeTokenNeeds({
    source: { owner: "Acme", repo: "api" },
    destination: { owner: "acme", repo: "pr-backtest-sandbox" },
    sourcePrivate: true,
  });
  assert.equal(purposes.length, 1, "ACME vs acme must be treated as the same owner");
  assert.equal(purposes[0]!.kind, "write");
});

test("computeTokenNeeds case-insensitive: differing case but different owners stays cross-owner", () => {
  const purposes = computeTokenNeeds({
    source: { owner: "Acme", repo: "api" },
    destination: { owner: "Alice", repo: "sandbox" },
    sourcePrivate: true,
  });
  assert.equal(required(purposes).length, 2);
});

test("env token wins over config, gh, and interactive", async () => {
  const result = await resolveTokenSource(makeResolvers());
  assert.equal(result.token, "ghp_env");
  assert.equal(result.source, "classic"); // ghp_ prefix => classic
  assert.equal(result.fromPaste, false);
});

test("config wins when env is absent", async () => {
  const result = await resolveTokenSource(
    makeResolvers({ getEnvToken: () => undefined }),
  );
  assert.equal(result.token, "github_pat_config");
  assert.equal(result.source, "fine-grained");
  assert.equal(result.fromPaste, false);
});

test("empty-string env token is ignored, falls through to config", async () => {
  const result = await resolveTokenSource(
    makeResolvers({ getEnvToken: () => "" }),
  );
  assert.equal(result.token, "github_pat_config");
});

test("gh CLI wins when env and config are absent", async () => {
  const result = await resolveTokenSource(
    makeResolvers({ getEnvToken: () => undefined, getConfig: () => null }),
  );
  assert.equal(result.token, "gh_cli_token");
  assert.equal(result.source, "gh-cli");
  assert.equal(result.fromPaste, false);
});

test("declining gh falls through to interactive paste", async () => {
  const result = await resolveTokenSource(
    makeResolvers({
      getEnvToken: () => undefined,
      getConfig: () => null,
      getGhToken: async () => null, // user declined / gh unavailable
    }),
  );
  assert.equal(result.token, "github_pat_pasted");
  assert.equal(result.source, "fine-grained"); // github_pat_ prefix
  assert.equal(result.fromPaste, true);
});

test("no token anywhere + no interactive throws NoTokenNonInteractiveError", async () => {
  await assert.rejects(
    () =>
      resolveTokenSource({
        getEnvToken: () => undefined,
        getConfig: () => null,
        getGhToken: async () => null,
        getInteractiveToken: async () => null,
      }),
    (err: unknown) => err instanceof NoTokenNonInteractiveError,
  );
});

// --- validation Octokit routes through the shared factory ---

/** Silence stderr (step/success lines) while a token resolution runs. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await run();
  } finally {
    process.stderr.write = original;
  }
}

test("options.makeOctokit injection seam is honored on the default validation path", async () => {
  let seamUsed = false;
  let seenToken = "";

  const result = await quiet(() =>
    resolveToken({
      resolvers: {
        getEnvToken: () => "ghp_injected_token_value",
        getConfig: () => null,
        getGhToken: async () => null,
        getInteractiveToken: async () => null,
      },
      makeOctokit: (token) => {
        seamUsed = true;
        seenToken = token;
        // Minimal `Pick<Octokit, "users">` shape returning a login.
        return {
          users: {
            getAuthenticated: async () => ({ data: { login: "injected-user" } }),
          },
        } as unknown as ReturnType<NonNullable<Parameters<typeof resolveToken>[0]["makeOctokit"]>>;
      },
    }),
  );

  assert.equal(seamUsed, true, "the injected factory must be used");
  assert.equal(seenToken, "ghp_injected_token_value");
  assert.equal(result.token, "ghp_injected_token_value");
});

test("the token is scrubbed before the validation request is issued", async () => {
  // Use a long, unique sentinel so redact() can't match it by accident. If the
  // scrubber is armed before octokit.users.getAuthenticated() runs, redact()
  // already replaces the sentinel with *** at the moment the validation request
  // is dispatched. Moving registerSecret to AFTER the request makes this fail.
  const sentinel = "ghp_ordering_sentinel_0123456789abcdef";
  let redactedAtRequestTime = "";

  await quiet(() =>
    resolveToken({
      resolvers: {
        getEnvToken: () => sentinel,
        getConfig: () => null,
        getGhToken: async () => null,
        getInteractiveToken: async () => null,
      },
      makeOctokit: () =>
        ({
          users: {
            getAuthenticated: async () => {
              // Captured at the instant the validation request runs.
              redactedAtRequestTime = redact(`token=${sentinel}`);
              return { data: { login: "ordering-user" } };
            },
          },
        }) as unknown as ReturnType<
          NonNullable<Parameters<typeof resolveToken>[0]["makeOctokit"]>
        >,
    }),
  );

  assert.equal(
    redactedAtRequestTime,
    "token=***",
    "the token must be registered with the scrubber before the validation request runs",
  );
  assert.ok(
    !redactedAtRequestTime.includes(sentinel),
    "the sentinel token must not survive redaction at validation time",
  );
});

test("the shared makeOctokit factory traces GET /user (so the default validation call is traced)", async () => {
  // The default validation path builds its Octokit via this same shared factory,
  // so proving the factory traces `GET /user` proves the default path is traced.
  setTtyOverride(false);
  setVerbose(true);
  const original = process.stderr.write.bind(process.stderr);
  let buffer = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const octokit = makeOctokit("ghp_token");
    await octokit.request("GET /user", {
      request: {
        fetch: (async () =>
          new Response(JSON.stringify({ login: "octocat" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    });
  } finally {
    process.stderr.write = original;
    setVerbose(false);
    setTtyOverride(null);
  }

  const lines = buffer.split("\n").filter((l) => l.includes("→"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /GET/);
  assert.match(lines[0]!, /\/user/);
  assert.match(lines[0]!, /200/);
  assert.match(lines[0]!, /\d+ms/);
  assert.equal(isVerbose(), false, "verbose restored after the run");
});
