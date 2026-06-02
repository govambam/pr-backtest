import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveToken,
  resolveTokenSource,
  resolveTokensForRun,
  resolvePurposeToken,
  probeReadSource,
  computeTokenNeeds,
  NoTokenNonInteractiveError,
  NoSourceTokenNonInteractiveError,
  type TokenResolvers,
  type PurposeResolvers,
  type ResolveTokensForRunOptions,
  type ProbeOctokit,
  type TokenPurpose,
  type CapabilityProbe,
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

// ===========================================================================
// Purpose-aware resolution (spec §6/§7): resolveTokensForRun + resolvePurposeToken
// + probeReadSource. All unit-tested with injected getters + an injected probe
// — no network, no TTY.
// ===========================================================================

/** HTTP-error-shaped throwable, matching what Octokit raises (status field). */
function httpError(status: number): Error & { status: number } {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

/**
 * A fake ProbeOctokit factory keyed by token. `readable` is the set of tokens
 * whose `repos.get` succeeds; every other token's `repos.get` throws the given
 * status (default 404). `users.getAuthenticated` returns a login derived from
 * the token. Records, per built instance, the token it was built from + every
 * repos.get arg, so a test can assert the probe ran on the CANDIDATE's Octokit.
 */
function makeFakeOctokitFactory(opts: {
  readable: Set<string>;
  notReadableStatus?: number;
  login?: (token: string) => string;
}) {
  const built: Array<{ token: string; reposGetArgs: Array<{ owner: string; repo: string }> }> = [];
  const factory = (token: string): ProbeOctokit => {
    const record = { token, reposGetArgs: [] as Array<{ owner: string; repo: string }> };
    built.push(record);
    return {
      repos: {
        get: (async (args: { owner: string; repo: string }) => {
          record.reposGetArgs.push({ owner: args.owner, repo: args.repo });
          if (opts.readable.has(token)) {
            return { data: { permissions: { push: true } } };
          }
          throw httpError(opts.notReadableStatus ?? 404);
        }) as unknown as ProbeOctokit["repos"]["get"],
      } as unknown as ProbeOctokit["repos"],
      users: {
        getAuthenticated: (async () => ({
          data: { login: opts.login ? opts.login(token) : `user-${token}` },
        })) as unknown as ProbeOctokit["users"]["getAuthenticated"],
      } as unknown as ProbeOctokit["users"],
    };
  };
  return { factory, built };
}

const READ_PURPOSE: TokenPurpose = { kind: "read", owner: "acme", repo: "api" };
const WRITE_PURPOSE: TokenPurpose = { kind: "write", owner: "alice", repo: "sandbox" };

/** A PurposeResolvers where every getter is present (overridable). */
function makePurposeResolvers(
  overrides: Partial<PurposeResolvers> = {},
): PurposeResolvers {
  return {
    getPurposeEnvToken: () => undefined,
    getOwnerScopedToken: () => undefined,
    getDefaultToken: async () => null,
    getInteractivePaste: async () => null,
    ...overrides,
  };
}

// --- VAL-PROBE-001: read-source probe runs on the candidate's Octokit; 403 AND 404 -> not-readable ---

test("VAL-PROBE-001: probeReadSource issues repos.get(source) on the candidate's Octokit", async () => {
  const { factory, built } = makeFakeOctokitFactory({ readable: new Set(["tok-ok"]) });
  const ok = await probeReadSource(factory("tok-ok"), "acme", "api");
  assert.equal(ok, true);
  assert.equal(built.length, 1);
  assert.equal(built[0]!.token, "tok-ok");
  assert.deepEqual(built[0]!.reposGetArgs, [{ owner: "acme", repo: "api" }]);
});

test("VAL-PROBE-001: a 404 means not-readable", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(), notReadableStatus: 404 });
  assert.equal(await probeReadSource(factory("nope"), "acme", "api"), false);
});

test("VAL-PROBE-001: a 403 ALSO means not-readable (not just 404)", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(), notReadableStatus: 403 });
  assert.equal(await probeReadSource(factory("nope"), "acme", "api"), false);
});

test("probeReadSource rethrows a non-403/404 error (e.g. 500) rather than masking it", async () => {
  const factory = (_t: string): ProbeOctokit =>
    ({
      repos: { get: async () => { throw httpError(500); } },
      users: { getAuthenticated: async () => ({ data: { login: "x" } }) },
    }) as unknown as ProbeOctokit;
  await assert.rejects(() => probeReadSource(factory("t"), "acme", "api"), /HTTP 500/);
});

// --- VAL-TOKEN-003: per-purpose order = env -> owner-scoped -> default -> paste; first PROBE-PASSING wins ---

test("VAL-TOKEN-003: resolution tries env, owner-scoped, default, paste in order; first probe-pass wins", async () => {
  // Only the default token passes the probe; env and owner-scoped fail it.
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["tok-default"]) });
  const resolvers = makePurposeResolvers({
    getPurposeEnvToken: () => "tok-env-fails",
    getOwnerScopedToken: () => "tok-owner-fails",
    getDefaultToken: async () => ({ token: "tok-default", source: "fine-grained", fromPaste: false }),
    getInteractivePaste: async () => "tok-paste",
  });
  const resolved = await resolvePurposeToken(READ_PURPOSE, resolvers, factory);
  assert.equal(resolved.token, "tok-default");
  assert.equal(resolved.via, "default");
});

test("VAL-TOKEN-003: env wins when it passes the probe (highest precedence)", async () => {
  const { factory } = makeFakeOctokitFactory({
    readable: new Set(["tok-env", "tok-owner", "tok-default"]),
  });
  const resolvers = makePurposeResolvers({
    getPurposeEnvToken: () => "tok-env",
    getOwnerScopedToken: () => "tok-owner",
    getDefaultToken: async () => ({ token: "tok-default", source: "classic", fromPaste: false }),
  });
  const resolved = await resolvePurposeToken(READ_PURPOSE, resolvers, factory);
  assert.equal(resolved.token, "tok-env");
  assert.equal(resolved.via, "purpose-env");
});

test("VAL-TOKEN-003: owner-scoped wins over default when env fails the probe", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["tok-owner", "tok-default"]) });
  const resolvers = makePurposeResolvers({
    getPurposeEnvToken: () => "tok-env-fails",
    getOwnerScopedToken: () => "tok-owner",
    getDefaultToken: async () => ({ token: "tok-default", source: "classic", fromPaste: false }),
  });
  const resolved = await resolvePurposeToken(READ_PURPOSE, resolvers, factory);
  assert.equal(resolved.token, "tok-owner");
  assert.equal(resolved.via, "owner-scoped");
});

test("resolvePurposeToken falls through to paste when nothing else passes the probe", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["tok-paste"]) });
  const resolvers = makePurposeResolvers({
    getPurposeEnvToken: () => "tok-env-fails",
    getDefaultToken: async () => ({ token: "tok-default-fails", source: "classic", fromPaste: false }),
    getInteractivePaste: async () => "tok-paste",
  });
  const resolved = await resolvePurposeToken(READ_PURPOSE, resolvers, factory);
  assert.equal(resolved.token, "tok-paste");
  assert.equal(resolved.via, "paste");
  assert.equal(resolved.fromPaste, true);
});

test("resolvePurposeToken throws NoTokenNonInteractiveError when no candidate passes and no paste", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set() });
  const resolvers = makePurposeResolvers({
    getDefaultToken: async () => ({ token: "tok-default-fails", source: "classic", fromPaste: false }),
  });
  await assert.rejects(
    () => resolvePurposeToken(READ_PURPOSE, resolvers, factory),
    (e: unknown) => e instanceof NoTokenNonInteractiveError,
  );
});

// --- VAL-TOKEN-001 / VAL-INV-004: one covering token serves both purposes, zero prompts ---

/** A run-options builder with NO interactive seams (asserts they are never called). */
function noPromptOptions(
  overrides: Partial<ResolveTokensForRunOptions>,
): ResolveTokensForRunOptions {
  return {
    purposes: [],
    makeOctokit: () => { throw new Error("makeOctokit not configured for this test"); },
    getSourceEnvToken: () => undefined,
    getWriteEnvToken: () => undefined,
    getConfig: () => null,
    getReadPaste: async () => { throw new Error("read paste prompt must NOT fire"); },
    getWritePaste: async () => { throw new Error("write paste prompt must NOT fire"); },
    confirmSave: async () => { throw new Error("save confirm must NOT fire"); },
    saveOwnerToken: () => { throw new Error("save must NOT fire"); },
    ...overrides,
  };
}

test("VAL-TOKEN-001: a single token passing BOTH probes serves both purposes, zero prompts", async () => {
  // Cross-owner private source needs read(acme)+write(alice); one token covers both.
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["one-token"]) });
  let readPrompts = 0;
  let writePrompts = 0;
  const result = await resolveTokensForRun(
    noPromptOptions({
      purposes: [READ_PURPOSE, WRITE_PURPOSE],
      makeOctokit: factory,
      getDefaultToken: async () => ({ token: "one-token", source: "classic", fromPaste: false }),
      getReadPaste: async () => { readPrompts += 1; return null; },
      getWritePaste: async () => { writePrompts += 1; return null; },
    }),
  );
  assert.equal(result.readToken, "one-token");
  assert.equal(result.writeToken, "one-token");
  assert.equal(result.twoToken, false);
  assert.equal(readPrompts, 0, "no read prompt for a covering token");
  assert.equal(writePrompts, 0, "no write prompt for a covering token");
});

test("VAL-INV-004: single same-owner write purpose resolves one token, no prompt, no second token", async () => {
  // Same-owner -> computeTokenNeeds gives ONE write purpose. Default token only.
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["only-token"]) });
  const purposes = computeTokenNeeds({
    source: { owner: "acme", repo: "api" },
    destination: { owner: "acme", repo: "api" },
    sourcePrivate: true,
  });
  const result = await resolveTokensForRun(
    noPromptOptions({
      purposes,
      makeOctokit: factory,
      getDefaultToken: async () => ({ token: "only-token", source: "classic", fromPaste: false }),
    }),
  );
  assert.equal(result.readToken, "only-token");
  assert.equal(result.writeToken, "only-token");
  assert.equal(result.twoToken, false);
});

test("VAL-INV-004: public-source cross-owner resolves a single write token, source read anonymous", async () => {
  // Public source -> one REQUIRED write purpose; the optional read purpose is ignored.
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["write-token"]) });
  const purposes = computeTokenNeeds({
    source: { owner: "acme", repo: "api" },
    destination: { owner: "alice", repo: "sandbox" },
    sourcePrivate: false,
  });
  const result = await resolveTokensForRun(
    noPromptOptions({
      purposes,
      makeOctokit: factory,
      getDefaultToken: async () => ({ token: "write-token", source: "classic", fromPaste: false }),
    }),
  );
  assert.equal(result.twoToken, false);
  assert.equal(result.writeToken, "write-token");
  assert.equal(result.readToken, "write-token");
});

// --- VAL-TOKEN-002: read-probe failure on the default token triggers a separate READ request ---

test("VAL-TOKEN-002: when the default token fails the read probe, a separate READ token is requested", async () => {
  // Default token can write (passes write probe) but CANNOT read the source.
  // A distinct read token (pasted) covers the read purpose.
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["read-token"]) });
  let readPromptFired = false;
  const result = await resolveTokensForRun({
    purposes: [READ_PURPOSE, WRITE_PURPOSE],
    makeOctokit: factory,
    getSourceEnvToken: () => undefined,
    getWriteEnvToken: () => undefined,
    getConfig: () => null,
    getDefaultToken: async () => ({ token: "write-only-token", source: "fine-grained", fromPaste: false }),
    getReadPaste: async () => { readPromptFired = true; return "read-token"; },
    getWritePaste: async () => { throw new Error("write should resolve from default, not prompt"); },
    confirmSave: async () => false,
    saveOwnerToken: () => {},
  });
  assert.equal(readPromptFired, true, "a separate READ token was requested");
  assert.equal(result.readToken, "read-token");
  assert.equal(result.writeToken, "write-only-token");
  assert.equal(result.twoToken, true);
});

// --- VAL-TOKEN-004: env-var -> purpose mapping, non-interactive ---

test("VAL-TOKEN-004: GITHUB_SOURCE_TOKEN -> read, GITHUB_TOKEN -> write/default (non-interactive)", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["src-env", "write-env"]) });
  const result = await resolveTokensForRun({
    purposes: [READ_PURPOSE, WRITE_PURPOSE],
    makeOctokit: factory,
    getSourceEnvToken: () => "src-env",
    getWriteEnvToken: () => "write-env",
    getConfig: () => null,
    // Default token resolves from GITHUB_TOKEN (the write env) via the standard chain.
    getDefaultToken: async () => ({ token: "write-env", source: "classic", fromPaste: false }),
    getReadPaste: async () => { throw new Error("no read prompt — env covers it"); },
    getWritePaste: async () => { throw new Error("no write prompt — env covers it"); },
    confirmSave: async () => false,
    saveOwnerToken: () => {},
  });
  assert.equal(result.readToken, "src-env");
  assert.equal(result.writeToken, "write-env");
  assert.equal(result.twoToken, true);
});

// --- VAL-TOKEN-005: missing read token non-interactively -> exit-1-style error naming GITHUB_SOURCE_TOKEN ---

test("VAL-TOKEN-005: non-interactive cross-owner private with no covering read token throws naming GITHUB_SOURCE_TOKEN", async () => {
  // Write token covers write (write probe always passes) but cannot read the
  // private source (not in the readable set); no read paste (non-TTY).
  const { factory, built } = makeFakeOctokitFactory({ readable: new Set() });
  let writeOctokitBuilt = false;
  await assert.rejects(
    () =>
      resolveTokensForRun({
        purposes: [READ_PURPOSE, WRITE_PURPOSE],
        makeOctokit: (token) => {
          if (token === "write-only") writeOctokitBuilt = true;
          return factory(token);
        },
        getSourceEnvToken: () => undefined,
        getWriteEnvToken: () => undefined,
        getConfig: () => null,
        getDefaultToken: async () => ({ token: "write-only", source: "fine-grained", fromPaste: false }),
        getReadPaste: async () => null, // non-TTY: no paste
        getWritePaste: async () => null,
        confirmSave: async () => false,
        saveOwnerToken: () => {},
      }),
    (e: unknown) =>
      e instanceof NoSourceTokenNonInteractiveError &&
      e instanceof NoTokenNonInteractiveError &&
      /GITHUB_SOURCE_TOKEN/.test((e as Error).message),
  );
  // The read purpose is resolved FIRST (it is the first required purpose), so the
  // failure happens before the write purpose is ever fully resolved as the run token.
  void writeOctokitBuilt;
  void built;
});

// --- VAL-TOKEN-006: guided prompt copy (grep-checkable text in src/auth.ts) ---

test("VAL-TOKEN-006: source auth.ts contains the READ-only-scope and WRITE Contents/Pull-requests copy", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const src = fs.readFileSync(
    url.fileURLToPath(new URL("../src/auth.ts", import.meta.url)),
    "utf8",
  );
  // READ prompt: read-only, scoped to the source repo, no write anywhere.
  assert.match(src, /read-only/i);
  assert.match(src, /no write access anywhere/i);
  // WRITE prompt: Contents + Pull requests write on the destination.
  assert.match(src, /Contents:\s+Read & write/);
  assert.match(src, /Pull requests:\s+Read & write/);
  // The creation URL is included.
  assert.match(src, /settings\/personal-access-tokens\/new/);
});

// --- VAL-TOKEN-007: a pasted purpose token is validated via users.getAuthenticated and offered for save ---

test("VAL-TOKEN-007: a pasted read token is validated via users.getAuthenticated and offered for owner-scoped save", async () => {
  // Only the pasted read token can read the source; the write token cannot,
  // so the read purpose falls through env/owner/default to the guided paste.
  const { factory } = makeFakeOctokitFactory({
    readable: new Set(["pasted-read"]),
    login: (t) => (t === "pasted-read" ? "reader-login" : "writer-login"),
  });
  const saved: Array<Partial<Config>> = [];
  let confirmAsked = false;
  const result = await resolveTokensForRun({
    purposes: [READ_PURPOSE, WRITE_PURPOSE],
    makeOctokit: factory,
    getSourceEnvToken: () => undefined,
    getWriteEnvToken: () => undefined,
    getConfig: () => null,
    getDefaultToken: async () => ({ token: "write-token", source: "fine-grained", fromPaste: false }),
    getReadPaste: async () => "pasted-read",
    getWritePaste: async () => { throw new Error("write resolves from default"); },
    confirmSave: async () => { confirmAsked = true; return true; },
    saveOwnerToken: (update) => { saved.push(update); },
  });
  assert.equal(result.readToken, "pasted-read");
  assert.equal(confirmAsked, true, "persistence was offered");
  assert.equal(saved.length, 1);
  const entry = saved[0]!.tokens?.[0];
  assert.ok(entry, "an owner-scoped tokens[] entry was saved");
  assert.equal(entry!.owner, "acme", "scoped to the source owner");
  assert.equal(entry!.token, "pasted-read");
  assert.equal(entry!.username, "reader-login", "validated login is recorded");
});

test("VAL-TOKEN-007: a pasted token that GitHub rejects (getAuthenticated throws) surfaces an error and is not saved", async () => {
  // Only the pasted token can read the source, so the read purpose falls through
  // to the paste; getAuthenticated then rejects it.
  const factory = (token: string): ProbeOctokit =>
    ({
      repos: {
        get: async () => {
          if (token === "bad-paste") return { data: { permissions: { push: true } } };
          throw httpError(404);
        },
      },
      users: {
        getAuthenticated: async () => {
          if (token === "bad-paste") throw httpError(401);
          return { data: { login: "ok" } };
        },
      },
    }) as unknown as ProbeOctokit;
  let saved = false;
  await assert.rejects(
    () =>
      resolveTokensForRun({
        purposes: [READ_PURPOSE, WRITE_PURPOSE],
        makeOctokit: factory,
        getSourceEnvToken: () => undefined,
        getWriteEnvToken: () => undefined,
        getConfig: () => null,
        getDefaultToken: async () => ({ token: "write-token", source: "fine-grained", fromPaste: false }),
        getReadPaste: async () => "bad-paste",
        getWritePaste: async () => null,
        confirmSave: async () => true,
        saveOwnerToken: () => { saved = true; },
      }),
    /GitHub rejected the pasted token/,
  );
  assert.equal(saved, false, "a rejected token is never persisted");
});

// --- VAL-CONFIG-003: a saved owner-scoped READ token is reused without prompting ---

test("VAL-CONFIG-003: a saved owner-scoped READ token is reused on a later run without prompting", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["saved-read-token", "write-token"]) });
  const cfg: Config = {
    token: "write-token",
    username: "writer",
    source: "fine-grained",
    tokens: [
      { owner: "acme", token: "saved-read-token", source: "fine-grained", username: "reader" },
    ],
  };
  const result = await resolveTokensForRun(
    noPromptOptions({
      purposes: [READ_PURPOSE, WRITE_PURPOSE],
      makeOctokit: factory,
      getConfig: () => cfg,
      getDefaultToken: async () => ({ token: "write-token", source: "fine-grained", fromPaste: false }),
    }),
  );
  assert.equal(result.readToken, "saved-read-token", "the saved owner-scoped read token was reused");
  assert.equal(result.writeToken, "write-token");
  assert.equal(result.twoToken, true);
});

test("owner-scoped lookup is case-insensitive on the owner", async () => {
  const { factory } = makeFakeOctokitFactory({ readable: new Set(["saved-read-token", "write-token"]) });
  const cfg: Config = {
    tokens: [{ owner: "ACME", token: "saved-read-token", source: "fine-grained", username: "reader" }],
  };
  const result = await resolveTokensForRun(
    noPromptOptions({
      purposes: [{ kind: "read", owner: "acme", repo: "api" }, WRITE_PURPOSE],
      makeOctokit: factory,
      getConfig: () => cfg,
      getDefaultToken: async () => ({ token: "write-token", source: "fine-grained", fromPaste: false }),
    }),
  );
  assert.equal(result.readToken, "saved-read-token");
});

// --- VAL-INV-003: BOTH tokens registered with the scrubber BEFORE their first request ---

test("VAL-INV-003: each of TWO distinct tokens is scrubbed before its first probe request", async () => {
  const readSentinel = "ghp_read_sentinel_0123456789abcdef";
  const writeSentinel = "ghp_write_sentinel_0123456789abcdef";
  const redactedAtFirstRequest = new Map<string, string>();

  const factory = (token: string): ProbeOctokit =>
    ({
      repos: {
        get: async () => {
          // Captured the instant the probe issues its first request with `token`.
          if (!redactedAtFirstRequest.has(token)) {
            redactedAtFirstRequest.set(token, redact(`auth=${token}`));
          }
          // read purpose (acme) passes only for the read sentinel; write passes for write sentinel.
          return { data: { permissions: { push: true } } };
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: "u" } }) },
    }) as unknown as ProbeOctokit;

  // A capability probe that gates read on the read sentinel and accepts write.
  const probe: CapabilityProbe = async (octokit, purpose) => {
    await octokit.repos.get({ owner: purpose.owner, repo: purpose.repo });
    return true;
  };

  const result = await resolveTokensForRun({
    purposes: [READ_PURPOSE, WRITE_PURPOSE],
    makeOctokit: factory,
    probe,
    getSourceEnvToken: () => readSentinel,
    getWriteEnvToken: () => writeSentinel,
    getConfig: () => null,
    getDefaultToken: async () => ({ token: writeSentinel, source: "classic", fromPaste: false }),
    getReadPaste: async () => null,
    getWritePaste: async () => null,
    confirmSave: async () => false,
    saveOwnerToken: () => {},
  });

  assert.equal(result.readToken, readSentinel);
  assert.equal(result.writeToken, writeSentinel);
  assert.notEqual(result.readToken, result.writeToken, "two DISTINCT tokens resolved");

  assert.equal(
    redactedAtFirstRequest.get(readSentinel),
    "auth=***",
    "the READ token must be scrubbed before ITS first request",
  );
  assert.equal(
    redactedAtFirstRequest.get(writeSentinel),
    "auth=***",
    "the WRITE token must be scrubbed before ITS first request",
  );
});
