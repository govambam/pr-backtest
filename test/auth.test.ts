import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTokenSource,
  NoTokenNonInteractiveError,
  type TokenResolvers,
} from "../src/auth.js";
import type { Config } from "../src/config.js";

const CFG: Config = {
  token: "github_pat_config",
  username: "configuser",
  source: "fine-grained",
};

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
