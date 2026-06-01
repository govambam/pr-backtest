import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveToken,
  resolveTokenSource,
  NoTokenNonInteractiveError,
  type TokenResolvers,
} from "../src/auth.js";
import type { Config } from "../src/config.js";
import { makeOctokit } from "../src/github.js";
import { setVerbose, setTtyOverride, isVerbose } from "../src/log.js";

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

// --- VAL-API-002: validation Octokit routes through the shared factory --------

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
  assert.equal(result.username, "injected-user");
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
