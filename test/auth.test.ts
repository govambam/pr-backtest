import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveWriteToken,
  resolveReadToken,
  canRead,
  canWrite,
  NoTokenNonInteractiveError,
  NoSourceTokenNonInteractiveError,
  type ResolveWriteTokenOptions,
  type ResolveReadTokenOptions,
  type ResolverOctokit,
  type AcceptToken,
  type RepoRef,
} from "../src/auth.js";
import type { Config, TokenSlot } from "../src/config.js";
import { destKey, sourceKey } from "../src/config.js";
import { DestinationApiError } from "../src/destination.js";
import { setVerbose, setTtyOverride, redact } from "../src/log.js";

const SOURCE: RepoRef = { owner: "acme", repo: "api" };
const DEST: RepoRef = { owner: "alice", repo: "sandbox" };

/** A Config holding one saved destination token under DEST's key (N1-lowercased). */
function destCfg(slot: TokenSlot, dest: RepoRef = DEST): Config {
  return { destinationTokens: { [destKey(dest.owner, dest.repo)]: slot } };
}

/** A Config holding one saved source token under SOURCE owner's key (N1-lowercased). */
function srcCfg(slot: TokenSlot, src: RepoRef = SOURCE): Config {
  return { sourceTokens: { [sourceKey(src.owner)]: slot } };
}

// The trace surface in log.ts is a module-level singleton. Reset it around every
// test so a throw before a test's own `finally` can't leak state into later tests.
beforeEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});
afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

/** Silence stderr (info/success lines) while a resolution runs. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await run();
  } finally {
    process.stderr.write = original;
  }
}

/** HTTP-error-shaped throwable, matching what Octokit raises (status field). */
function httpError(status: number): Error & { status: number } {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

/**
 * A fake ResolverOctokit factory keyed by token.
 * - `readable`: tokens whose `repos.get(source)` succeeds (read capability).
 * - `writable`: tokens whose `repos.get(dest)` returns permissions.push === true.
 * Every built instance records the token it was built from + every repos.get arg,
 * so a test can assert which token issued which probe.
 */
function makeFactory(opts: {
  readable?: Set<string>;
  writable?: Set<string>;
  login?: (token: string) => string;
}) {
  const readable = opts.readable ?? new Set<string>();
  const writable = opts.writable ?? new Set<string>();
  const built: Array<{
    token: string;
    reposGetArgs: Array<{ owner: string; repo: string }>;
  }> = [];
  const factory = (token: string): ResolverOctokit => {
    const record = { token, reposGetArgs: [] as Array<{ owner: string; repo: string }> };
    built.push(record);
    return {
      repos: {
        get: (async (args: { owner: string; repo: string }) => {
          record.reposGetArgs.push({ owner: args.owner, repo: args.repo });
          const isSource =
            args.owner === SOURCE.owner && args.repo === SOURCE.repo;
          if (isSource) {
            if (readable.has(token)) {
              return { data: { permissions: { push: false }, private: true } };
            }
            throw httpError(404);
          }
          // destination repos.get
          if (writable.has(token)) {
            return { data: { permissions: { push: true }, private: true } };
          }
          // visible but not writable, or not found — model as 404 unless writable.
          throw httpError(404);
        }) as unknown as ResolverOctokit["repos"]["get"],
      } as unknown as ResolverOctokit["repos"],
      users: {
        getAuthenticated: (async () => ({
          data: { login: opts.login ? opts.login(token) : `user-${token}` },
        })) as unknown as ResolverOctokit["users"]["getAuthenticated"],
      } as unknown as ResolverOctokit["users"],
    };
  };
  return { factory, built };
}

// ===========================================================================
// Capability primitives: canRead / canWrite
// ===========================================================================

test("canRead: repos.get(source) success means readable", async () => {
  const { factory, built } = makeFactory({ readable: new Set(["tok"]) });
  assert.equal(await canRead(factory("tok"), SOURCE), true);
  assert.deepEqual(built[0]!.reposGetArgs, [{ owner: "acme", repo: "api" }]);
});

test("canRead: a 404 means not-readable", async () => {
  const { factory } = makeFactory({ readable: new Set() });
  assert.equal(await canRead(factory("nope"), SOURCE), false);
});

test("canRead: a 403 ALSO means not-readable", async () => {
  const factory = (_t: string): ResolverOctokit =>
    ({
      repos: { get: async () => { throw httpError(403); } },
      users: { getAuthenticated: async () => ({ data: { login: "x" } }) },
    }) as unknown as ResolverOctokit;
  assert.equal(await canRead(factory("t"), SOURCE), false);
});

test("canRead rethrows a non-403/404 error (e.g. 500)", async () => {
  const factory = (_t: string): ResolverOctokit =>
    ({
      repos: { get: async () => { throw httpError(500); } },
      users: { getAuthenticated: async () => ({ data: { login: "x" } }) },
    }) as unknown as ResolverOctokit;
  await assert.rejects(() => canRead(factory("t"), SOURCE), /HTTP 500/);
});

test("canWrite: permissions.push === true means writable", async () => {
  const { factory } = makeFactory({ writable: new Set(["w"]) });
  assert.equal(await canWrite(factory("w"), DEST), true);
});

test("canWrite: a token without push is not writable", async () => {
  const factory = (_t: string): ResolverOctokit =>
    ({
      repos: { get: async () => ({ data: { permissions: { push: false } } }) },
      users: { getAuthenticated: async () => ({ data: { login: "x" } }) },
    }) as unknown as ResolverOctokit;
  assert.equal(await canWrite(factory("ro"), DEST), false);
});

test("canWrite: a 404 (missing/not-visible dest) is not writable", async () => {
  const { factory } = makeFactory({ writable: new Set() });
  assert.equal(await canWrite(factory("nope"), DEST), false);
});

// ===========================================================================
// Standalone resolvers: resolveWriteToken / resolveReadToken (sandbox-create path)
// ===========================================================================

/** A factory whose only behavior is users.getAuthenticated (token -> login). */
function loginFactory(login: (token: string) => string) {
  return (token: string): ResolverOctokit =>
    ({
      repos: { get: async () => { throw httpError(404); } },
      users: {
        getAuthenticated: async () => ({ data: { login: login(token) } }),
      },
    }) as unknown as ResolverOctokit;
}

/** Base resolveWriteToken options with interactive/persist seams disabled. */
function writeOptions(
  overrides: Partial<ResolveWriteTokenOptions>,
): ResolveWriteTokenOptions {
  return {
    destination: DEST,
    isPrimary: false,
    makeOctokit: loginFactory((t) => `u-${t}`),
    getEnvToken: () => undefined,
    getConfig: () => null,
    saveConfig: () => { throw new Error("saveConfig must NOT fire"); },
    getPaste: async () => { throw new Error("paste must NOT fire"); },
    accept: async () => false,
    ...overrides,
  };
}

test("resolveWriteToken: env GITHUB_TOKEN wins over saved destinationToken when both accepted", async () => {
  const cfg = destCfg({ token: "saved-dest", username: "u", source: "fine-grained" });
  const seen: string[] = [];
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "write-env",
      getConfig: () => cfg,
      accept: async (_o, token) => { seen.push(token); return true; },
    }),
  );
  assert.equal(result.token, "write-env");
  assert.equal(result.fromPaste, false);
  // An env/saved token already validated via the accept probe; no extra
  // users.getAuthenticated round-trip runs, so no @login is captured.
  assert.equal(result.login, "");
  assert.deepEqual(seen, ["write-env"], "saved slot is not tried once env is accepted");
});

test("resolveWriteToken: falls to saved destinationToken when env is not accepted", async () => {
  const cfg = destCfg({ token: "saved-dest", username: "u", source: "classic" });
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "write-env",
      getConfig: () => cfg,
      accept: async (_o, token) => token === "saved-dest",
    }),
  );
  assert.equal(result.token, "saved-dest");
  assert.equal(result.source, "classic");
});

test("resolveWriteToken: accept on the CREATE path accepts a token canWrite would reject (sandbox creation)", async () => {
  // The destination does not exist yet (canWrite would 404 -> false), but the
  // caller's accept (verify-or-create) accepts the env token.
  let createAttempted = false;
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "creator-token",
      makeOctokit: loginFactory(() => "creator"),
      accept: async () => { createAttempted = true; return true; },
    }),
  );
  assert.equal(result.token, "creator-token");
  // Env token: validated via the accept (create) path, not getAuthenticated.
  assert.equal(result.login, "");
  assert.equal(createAttempted, true);
});

test("resolveWriteToken: an env/saved write token makes NO users.getAuthenticated call", async () => {
  // VAL-CORR-003: captureLogin runs only on the fresh-paste path. A recording
  // factory proves an accepted env (and then saved) token never probes
  // getAuthenticated — that token already validated via the accept predicate.
  const authCalls: string[] = [];
  const recording = (token: string): ResolverOctokit =>
    ({
      repos: { get: async () => { throw httpError(404); } },
      users: {
        getAuthenticated: async () => {
          authCalls.push(token);
          return { data: { login: `u-${token}` } };
        },
      },
    }) as unknown as ResolverOctokit;

  const envResult = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "env-write",
      makeOctokit: recording,
      accept: async (_o, token) => token === "env-write",
    }),
  );
  assert.equal(envResult.token, "env-write");
  assert.equal(envResult.login, "");

  const savedResult = await resolveWriteToken(
    writeOptions({
      getConfig: () => destCfg({ token: "saved-write", username: "u", source: "classic" }),
      makeOctokit: recording,
      accept: async (_o, token) => token === "saved-write",
    }),
  );
  assert.equal(savedResult.token, "saved-write");
  assert.equal(savedResult.login, "");

  assert.deepEqual(authCalls, [], "no getAuthenticated for env/saved write tokens");
});

test("resolveReadToken: an env/saved read token makes NO users.getAuthenticated call", async () => {
  // VAL-CORR-003 on the read path: an accepted env/saved source token validated
  // via canRead never issues users.getAuthenticated.
  const authCalls: string[] = [];
  const recording = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: (async (args: { owner: string; repo: string }) => {
          const isSource =
            args.owner === SOURCE.owner && args.repo === SOURCE.repo;
          if (isSource && (token === "env-read" || token === "saved-read")) {
            return { data: { permissions: { push: false }, private: true } };
          }
          throw httpError(404);
        }) as unknown as ResolverOctokit["repos"]["get"],
      } as unknown as ResolverOctokit["repos"],
      users: {
        getAuthenticated: (async () => {
          authCalls.push(token);
          return { data: { login: `u-${token}` } };
        }) as unknown as ResolverOctokit["users"]["getAuthenticated"],
      } as unknown as ResolverOctokit["users"],
    }) as unknown as ResolverOctokit;

  const envResult = await resolveReadToken(
    readOptions({
      writeToken: "write-only",
      getEnvToken: () => "env-read",
      makeOctokit: recording,
    }),
  );
  assert.equal(envResult.token, "env-read");
  assert.equal(envResult.login, "");

  const savedResult = await resolveReadToken(
    readOptions({
      writeToken: "write-only",
      getConfig: () => srcCfg({ token: "saved-read", username: "u", source: "fine-grained" }),
      makeOctokit: recording,
    }),
  );
  assert.equal(savedResult.token, "saved-read");
  assert.equal(savedResult.login, "");

  assert.deepEqual(authCalls, [], "no getAuthenticated for env/saved read tokens");
});

test("resolveWriteToken: an accept that returns false on rejection falls through to the next candidate", async () => {
  // An accept may reject by returning false (in addition to throwing a
  // DestinationApiError). Here it returns false for the env token and true for
  // the saved one, so resolution falls through correctly.
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "bad-token",
      getConfig: () => destCfg({ token: "good-token", username: "u", source: "fine-grained" }),
      accept: async (_o, token) => token === "good-token",
    }),
  );
  assert.equal(result.token, "good-token");
});

test("resolveWriteToken: a fresh accepted paste persists to destinationToken with @login", async () => {
  const saved: Array<Partial<Config>> = [];
  const result = await quiet(() =>
    resolveWriteToken(
      writeOptions({
        isPrimary: true,
        destination: SOURCE,
        makeOctokit: loginFactory(() => "writer"),
        getPaste: async () => "pasted-write",
        accept: async (_o, token) => token === "pasted-write",
        saveConfig: (u) => saved.push(u),
      }),
    ),
  );
  assert.equal(result.token, "pasted-write");
  assert.equal(result.fromPaste, true);
  assert.equal(result.login, "writer");
  const key = destKey(SOURCE.owner, SOURCE.repo);
  const map = saved.find((s) => s.destinationTokens)?.destinationTokens;
  assert.ok(map, "destinationTokens persisted");
  const slot = map![key];
  assert.ok(slot, "destination token persisted under the dest key");
  assert.equal(slot!.token, "pasted-write");
  assert.equal(slot!.username, "writer");
  // N3/N1: persisted under exactly the (lowercased) destination key, no other.
  assert.deepEqual(Object.keys(map!), [key]);
});

test("resolveWriteToken: bounded 3 paste attempts then throws NoTokenNonInteractiveError naming GITHUB_TOKEN", async () => {
  let pasteCalls = 0;
  await assert.rejects(
    () =>
      quiet(() =>
        resolveWriteToken(
          writeOptions({
            getPaste: async () => { pasteCalls += 1; return "always-bad"; },
            accept: async () => false,
            saveConfig: () => {},
          }),
        ),
      ),
    (e: unknown) =>
      e instanceof NoTokenNonInteractiveError &&
      !(e instanceof NoSourceTokenNonInteractiveError) &&
      /GITHUB_TOKEN/.test((e as Error).message),
  );
  assert.equal(pasteCalls, 3);
});

test("resolveWriteToken: non-interactive (paste returns null) throws immediately naming GITHUB_TOKEN", async () => {
  await assert.rejects(
    () =>
      resolveWriteToken(
        writeOptions({
          getPaste: async () => null,
          accept: async () => false,
          saveConfig: () => {},
        }),
      ),
    (e: unknown) =>
      e instanceof NoTokenNonInteractiveError &&
      /GITHUB_TOKEN/.test((e as Error).message),
  );
});

test("resolveWriteToken: every source rejected by a DestinationApiError surfaces THAT error, not NoTokenNonInteractiveError (non-interactive)", async () => {
  // The real bug: a destination problem (e.g. `--sandbox foo/bar` without
  // --create-sandbox when the repo does not exist) makes the accept check throw
  // a DestinationApiError for every candidate. Off-TTY there is no paste, so on
  // exhaustion the actionable destination error must surface — NOT a misleading
  // "no write token configured" error.
  const destErr = new DestinationApiError(
    "Sandbox alice/sandbox was not found. Pass --create-sandbox to create it.",
  );
  await assert.rejects(
    () =>
      resolveWriteToken(
        writeOptions({
          getEnvToken: () => "env-token",
          getConfig: () => destCfg({ token: "saved", username: "u", source: "classic" }),
          getPaste: async () => null,
          accept: async () => { throw destErr; },
          saveConfig: () => {},
        }),
      ),
    (e: unknown) =>
      e instanceof DestinationApiError &&
      !(e instanceof NoTokenNonInteractiveError) &&
      e === destErr,
  );
});

test("resolveWriteToken: 3 paste attempts all rejected by DestinationApiError surface THAT error, not the misleading non-TTY error", async () => {
  // Bug #2: after exhausting the interactive paste attempts with tokens that
  // cannot write the destination, the user IS on a TTY — claiming "stdin is not
  // a TTY" is wrong. The write-permission DestinationApiError surfaces instead.
  let pasteCalls = 0;
  const destErr = new DestinationApiError(
    "That token cannot write alice/sandbox (no write access).",
  );
  await assert.rejects(
    () =>
      quiet(() =>
        resolveWriteToken(
          writeOptions({
            getPaste: async () => { pasteCalls += 1; return "cant-write"; },
            accept: async () => { throw destErr; },
            saveConfig: () => {},
          }),
        ),
      ),
    (e: unknown) =>
      e instanceof DestinationApiError &&
      !(e instanceof NoTokenNonInteractiveError) &&
      e === destErr,
  );
  assert.equal(pasteCalls, 3, "all 3 interactive attempts were exhausted first");
});

test("resolveWriteToken: a non-DestinationApiError thrown by accept propagates immediately (not swallowed as a rejection)", async () => {
  // A genuine API/network failure during the accept probe must NOT be treated
  // as a candidate rejection — it propagates as-is, never reaching the paste
  // loop or the no-token error.
  const boom = new Error("network down");
  let pasteCalls = 0;
  await assert.rejects(
    () =>
      resolveWriteToken(
        writeOptions({
          getEnvToken: () => "env-token",
          getPaste: async () => { pasteCalls += 1; return "x"; },
          accept: async () => { throw boom; },
          saveConfig: () => {},
        }),
      ),
    (e: unknown) => e === boom,
  );
  assert.equal(pasteCalls, 0, "a real failure short-circuits before any paste");
});

test("resolveWriteToken: an accepted candidate after a DestinationApiError rejection still wins (rejection is not terminal)", async () => {
  // A DestinationApiError rejecting one candidate must still let a later
  // candidate be accepted — the remembered error is only surfaced on full
  // exhaustion.
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "bad-token",
      getConfig: () => destCfg({ token: "good-token", username: "u", source: "fine-grained" }),
      accept: async (_o, token) => {
        if (token === "good-token") return true;
        throw new DestinationApiError("cannot write with bad-token");
      },
    }),
  );
  assert.equal(result.token, "good-token");
});

/** One recorded `repos.get` probe: which token's Octokit issued it, against what repo. */
interface ReadProbe {
  token: string;
  owner: string;
  repo: string;
}

/**
 * A factory keyed on canRead(source): tokens in `readable` read the source.
 * If a `built` array is passed, every `repos.get` is recorded into it (token +
 * target repo), so a test can assert WHICH token probed the source.
 */
function readFactory(
  readable: Set<string>,
  login?: (t: string) => string,
  built?: ReadProbe[],
) {
  return (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
          built?.push({ token, owner: args.owner, repo: args.repo });
          const isSource = args.owner === SOURCE.owner && args.repo === SOURCE.repo;
          if (isSource && readable.has(token)) {
            return { data: { permissions: { push: false } } };
          }
          throw httpError(404);
        },
      },
      users: {
        getAuthenticated: async () => ({
          data: { login: login ? login(token) : `u-${token}` },
        }),
      },
    }) as unknown as ResolverOctokit;
}

/** Base resolveReadToken options with interactive/persist seams disabled. */
function readOptions(
  overrides: Partial<ResolveReadTokenOptions>,
): ResolveReadTokenOptions {
  return {
    source: SOURCE,
    writeToken: "",
    makeOctokit: readFactory(new Set()),
    getEnvToken: () => undefined,
    getConfig: () => null,
    saveConfig: () => { throw new Error("saveConfig must NOT fire"); },
    getPaste: async () => { throw new Error("paste must NOT fire"); },
    ...overrides,
  };
}

test("resolveReadToken: env GITHUB_SOURCE_TOKEN wins over saved sourceToken and write-reuse", async () => {
  const cfg = srcCfg({ token: "saved-src", username: "u", source: "fine-grained" });
  const result = await resolveReadToken(
    readOptions({
      writeToken: "write-token",
      makeOctokit: readFactory(new Set(["src-env", "saved-src", "write-token"])),
      getEnvToken: () => "src-env",
      getConfig: () => cfg,
    }),
  );
  assert.equal(result.token, "src-env");
  assert.equal(result.fromPaste, false);
});

test("resolveReadToken: saved sourceToken used over write-reuse when env absent", async () => {
  const cfg = srcCfg({ token: "saved-src", username: "u", source: "fine-grained" });
  const result = await resolveReadToken(
    readOptions({
      writeToken: "write-token",
      makeOctokit: readFactory(new Set(["saved-src", "write-token"])),
      getConfig: () => cfg,
    }),
  );
  assert.equal(result.token, "saved-src");
});

test("resolveReadToken: reuses the write token iff it reads the source (single-PAT)", async () => {
  const built: ReadProbe[] = [];
  const result = await resolveReadToken(
    readOptions({
      writeToken: "one-pat",
      makeOctokit: readFactory(new Set(["one-pat"]), () => "owner", built),
    }),
  );
  assert.equal(result.token, "one-pat");
  assert.equal(result.fromPaste, false);
  // Reused write token is non-paste: no getAuthenticated, so no @login captured.
  assert.equal(result.login, "");
  // The reuse is EARNED: `one-pat`'s Octokit actually probed the SOURCE repo.
  // This fails if resolveReadToken were changed to return writeToken blindly
  // (without a source read), which is the whole point of the single-PAT rule.
  assert.deepEqual(
    built,
    [{ token: "one-pat", owner: SOURCE.owner, repo: SOURCE.repo }],
    "the reused write token issued a repos.get against the source",
  );
});

test("resolveReadToken: a fresh accepted paste persists to sourceToken with @login", async () => {
  const saved: Array<Partial<Config>> = [];
  const result = await quiet(() =>
    resolveReadToken(
      readOptions({
        writeToken: "write-only", // cannot read source -> falls to paste
        makeOctokit: readFactory(new Set(["pasted-read"]), (t) =>
          t === "pasted-read" ? "reader" : "writer",
        ),
        getPaste: async () => "pasted-read",
        saveConfig: (u) => saved.push(u),
      }),
    ),
  );
  assert.equal(result.token, "pasted-read");
  assert.equal(result.fromPaste, true);
  assert.equal(result.login, "reader");
  const key = sourceKey(SOURCE.owner);
  const map = saved.find((s) => s.sourceTokens)?.sourceTokens;
  assert.ok(map, "sourceTokens persisted");
  const slot = map![key];
  assert.ok(slot, "source token persisted under the owner key");
  assert.equal(slot!.username, "reader");
  // N3/N1: persisted under exactly the (lowercased) source owner key, no other.
  assert.deepEqual(Object.keys(map!), [key]);
});

test("resolveReadToken: bounded 3 paste attempts then throws NoSourceTokenNonInteractiveError naming GITHUB_SOURCE_TOKEN", async () => {
  let pasteCalls = 0;
  await assert.rejects(
    () =>
      quiet(() =>
        resolveReadToken(
          readOptions({
            writeToken: "write-only",
            makeOctokit: readFactory(new Set()), // nothing reads the source
            getPaste: async () => { pasteCalls += 1; return "always-bad"; },
            saveConfig: () => {},
          }),
        ),
      ),
    (e: unknown) =>
      e instanceof NoSourceTokenNonInteractiveError &&
      e instanceof NoTokenNonInteractiveError &&
      /GITHUB_SOURCE_TOKEN/.test((e as Error).message),
  );
  assert.equal(pasteCalls, 3);
});

test("resolveReadToken: non-interactive (paste null) with unreadable source throws naming GITHUB_SOURCE_TOKEN", async () => {
  await assert.rejects(
    () =>
      resolveReadToken(
        readOptions({
          writeToken: "write-only",
          makeOctokit: readFactory(new Set()),
          getPaste: async () => null,
          saveConfig: () => {},
        }),
      ),
    (e: unknown) =>
      e instanceof NoSourceTokenNonInteractiveError &&
      /GITHUB_SOURCE_TOKEN/.test((e as Error).message),
  );
});

test("resolveReadToken: each candidate is scrubbed before its first request", async () => {
  const sentinel = "ghp_read_only_sentinel_0123456789ab";
  let redactedAtRequest = "";
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async () => {
          redactedAtRequest = redact(`auth=${token}`);
          return { data: { permissions: { push: false } } };
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: "u" } }) },
    }) as unknown as ResolverOctokit;
  const result = await resolveReadToken(
    readOptions({
      writeToken: "",
      makeOctokit: factory,
      getEnvToken: () => sentinel,
    }),
  );
  assert.equal(result.token, sentinel);
  assert.equal(redactedAtRequest, "auth=***");
});

// ===========================================================================
// VAL-AUTH-006 — inherited slots into precedence: AFTER env + saved slot, BEFORE
// the interactive paste, for BOTH the write and read resolvers. Ordering is
// proven by seam call-order/counts, not just outcome.
// ===========================================================================

test("VAL-AUTH-006 (write): a valid saved destinationToken wins WITHOUT detecting the inherited credential", async () => {
  let detectorCalls = 0;
  const result = await resolveWriteToken(
    writeOptions({
      getConfig: () => destCfg({ token: "saved-dest", username: "u", source: "fine-grained" }),
      accept: async (_o, token) => token === "saved-dest",
      getInheritedCredential: async () => {
        detectorCalls += 1;
        return { token: "inherited", login: "octo", source: "classic" };
      },
      getPaste: async () => { throw new Error("paste must NOT fire"); },
    }),
  );
  assert.equal(result.token, "saved-dest");
  assert.equal(detectorCalls, 0, "saved slot wins -> inherited detector never runs");
});

test("VAL-AUTH-006 (write): inherited is offered AFTER env/saved are rejected and BEFORE the paste; never persisted", async () => {
  let detectorCalls = 0;
  let pasteCalls = 0;
  let saveCalls = 0;
  // Record the order accept is offered each candidate, so we prove the inherited
  // probe runs AFTER both the env token and the saved slot are actually rejected —
  // not as the sole candidate. Moving the inherited probe ahead of the env+saved
  // loop in src/auth.ts makes the order assertion below fail.
  const acceptOrder: string[] = [];
  const result = await resolveWriteToken(
    writeOptions({
      // BOTH env AND a saved slot present — and BOTH rejected by accept.
      getEnvToken: () => "env-bad",
      getConfig: () => destCfg({ token: "saved-bad", username: "u", source: "fine-grained" }),
      // Only the inherited token writes the destination; env + saved are rejected.
      accept: async (_o, token) => {
        acceptOrder.push(token);
        return token === "inherited-good";
      },
      getInheritedCredential: async () => {
        detectorCalls += 1;
        // The detector must not run until env + saved have been tried & rejected.
        assert.deepEqual(
          acceptOrder,
          ["env-bad", "saved-bad"],
          "inherited detector runs only AFTER env + saved are rejected",
        );
        return { token: "inherited-good", source: "classic" };
      },
      getPaste: async () => { pasteCalls += 1; return "would-paste"; },
      saveConfig: () => { saveCalls += 1; },
    }),
  );
  assert.equal(result.token, "inherited-good");
  assert.equal(result.fromPaste, false, "inherited is not a fresh paste");
  assert.equal(result.login, "", "inherited (non-paste) makes no extra getAuthenticated");
  assert.equal(detectorCalls, 1, "inherited detector consulted after env/saved");
  assert.deepEqual(
    acceptOrder,
    ["env-bad", "saved-bad", "inherited-good"],
    "env → saved → inherited precedence; inherited offered last before the paste",
  );
  assert.equal(pasteCalls, 0, "inherited wins -> paste getter never runs");
  assert.equal(saveCalls, 0, "inherited token is NOT persisted to config");
});

test("VAL-AUTH-006 (write): a rejected inherited credential still falls through to the paste", async () => {
  let pasteCalls = 0;
  const result = await quiet(() =>
    resolveWriteToken(
      writeOptions({
        isPrimary: true,
        destination: SOURCE,
        makeOctokit: loginFactory(() => "writer"),
        accept: async (_o, token) => token === "pasted-write",
        getInheritedCredential: async () => ({
          token: "inherited-cant-write",
          login: "octo",
          source: "classic",
        }),
        getPaste: async () => { pasteCalls += 1; return "pasted-write"; },
        saveConfig: () => {},
      }),
    ),
  );
  assert.equal(result.token, "pasted-write");
  assert.equal(pasteCalls, 1, "a rejected inherited credential drops to the paste");
});

test("VAL-AUTH-006 (read): a valid saved sourceToken wins WITHOUT detecting the inherited credential", async () => {
  let detectorCalls = 0;
  const result = await resolveReadToken(
    readOptions({
      writeToken: "write-only", // does not read source
      makeOctokit: readFactory(new Set(["saved-src"])),
      getConfig: () => srcCfg({ token: "saved-src", username: "u", source: "fine-grained" }),
      getInheritedCredential: async () => {
        detectorCalls += 1;
        return { token: "inherited", login: "octo", source: "classic" };
      },
      getPaste: async () => { throw new Error("paste must NOT fire"); },
    }),
  );
  assert.equal(result.token, "saved-src");
  assert.equal(detectorCalls, 0, "saved slot wins -> inherited detector never runs");
});

test("VAL-AUTH-006 (read): inherited offered after env/saved/write-reuse, before the paste", async () => {
  let pasteCalls = 0;
  // Record each read-probe (canRead) in order. The inherited token is consulted
  // only AFTER a rejecting env token, a rejecting saved slot, AND a non-reading
  // write token (single-PAT reuse) are all tried — none of which read the source.
  // Moving the inherited probe ahead of the env+saved+write-reuse candidates in
  // src/auth.ts makes the probe-order assertion fail.
  const built: ReadProbe[] = [];
  const result = await resolveReadToken(
    readOptions({
      writeToken: "write-only", // cannot read source -> not single-PAT
      getEnvToken: () => "env-bad", // present but does NOT read the source
      getConfig: () => srcCfg({ token: "saved-bad", username: "u", source: "fine-grained" }),
      // Only the inherited token reads the source.
      makeOctokit: readFactory(new Set(["inherited-reads"]), undefined, built),
      getInheritedCredential: async () => {
        // env, saved, and the write-reuse token have all been probed & rejected
        // (none read the source) before the inherited detector is consulted.
        assert.deepEqual(
          built.map((p) => p.token),
          ["env-bad", "saved-bad", "write-only"],
          "inherited detector runs only AFTER env + saved + write-reuse are rejected",
        );
        return { token: "inherited-reads", source: "classic" };
      },
      getPaste: async () => { pasteCalls += 1; return "would-paste"; },
    }),
  );
  assert.equal(result.token, "inherited-reads");
  assert.equal(result.fromPaste, false);
  assert.deepEqual(
    built.map((p) => p.token),
    ["env-bad", "saved-bad", "write-only", "inherited-reads"],
    "env → saved → write-reuse → inherited precedence; inherited offered last before the paste",
  );
  assert.equal(pasteCalls, 0, "inherited wins -> paste getter never runs");
});

// ===========================================================================
// VAL-MEM-002 — keyed write-token resolution (N1, N3, N5)
// ===========================================================================

const SAVED_DEST_SLOT: TokenSlot = {
  token: "saved-dest-tok",
  username: "dest-user",
  source: "fine-grained",
};

test("VAL-MEM-002: a saved destinationTokens[dest] is auto-used (paste seam 0 calls)", async () => {
  let pasteCalls = 0;
  const result = await resolveWriteToken(
    writeOptions({
      // The saved key matches DEST exactly.
      getConfig: () => destCfg(SAVED_DEST_SLOT),
      accept: async (_o, token) => token === SAVED_DEST_SLOT.token,
      getPaste: async () => { pasteCalls += 1; return "x"; },
    }),
  );
  assert.equal(result.token, SAVED_DEST_SLOT.token);
  assert.equal(result.fromPaste, false);
  assert.equal(pasteCalls, 0, "saved key hit -> no paste");
});

test("VAL-MEM-002: a saved token under a DIFFERENT dest key misses (no hit for this dest)", async () => {
  // Saved under another repo; resolving DEST must NOT see it -> falls to paste.
  let pasteCalls = 0;
  const result = await quiet(() =>
    resolveWriteToken(
      writeOptions({
        getConfig: () => destCfg(SAVED_DEST_SLOT, { owner: "other", repo: "repo" }),
        makeOctokit: loginFactory(() => "pwriter"),
        accept: async (_o, token) => token === "pasted",
        getPaste: async () => { pasteCalls += 1; return "pasted"; },
        saveConfig: () => {},
      }),
    ),
  );
  assert.equal(result.token, "pasted");
  assert.equal(pasteCalls, 1, "no key for this dest -> prompts");
});

test("VAL-MEM-002 (N1): saved under Foo/Bar, resolving foo/bar hits (0 paste calls)", async () => {
  const mixedDest: RepoRef = { owner: "Foo", repo: "Bar" };
  const lowerDest: RepoRef = { owner: "foo", repo: "bar" };
  let pasteCalls = 0;
  const result = await resolveWriteToken(
    writeOptions({
      destination: lowerDest,
      // Saved under the mixed-case key; the resolver lowercases on lookup.
      getConfig: () => destCfg(SAVED_DEST_SLOT, mixedDest),
      accept: async (_o, token) => token === SAVED_DEST_SLOT.token,
      getPaste: async () => { pasteCalls += 1; return "x"; },
    }),
  );
  assert.equal(result.token, SAVED_DEST_SLOT.token);
  assert.equal(pasteCalls, 0, "case-insensitive key hit");
});

test("VAL-MEM-002 (N3): a fresh paste persists ONLY destinationTokens[dest] (no clobber payload)", async () => {
  // The save seam receives a partial update keyed by THIS dest only; merging is
  // mergeConfig's job (covered in config.test.ts). Here we prove the resolver
  // hands mergeConfig exactly one keyed entry under the right key.
  const saved: Array<Partial<Config>> = [];
  await quiet(() =>
    resolveWriteToken(
      writeOptions({
        destination: DEST,
        makeOctokit: loginFactory(() => "writer"),
        getPaste: async () => "fresh",
        accept: async (_o, token) => token === "fresh",
        saveConfig: (u) => saved.push(u),
      }),
    ),
  );
  const map = saved.find((s) => s.destinationTokens)?.destinationTokens;
  assert.ok(map, "destinationTokens written");
  assert.deepEqual(Object.keys(map!), [destKey(DEST.owner, DEST.repo)]);
  assert.equal(map![destKey(DEST.owner, DEST.repo)]!.token, "fresh");
});

test("VAL-MEM-002 (N3): a saved-key HIT never writes (save seam not called)", async () => {
  // writeOptions' default saveConfig throws if called -> a hit must not save.
  const result = await resolveWriteToken(
    writeOptions({
      getConfig: () => destCfg(SAVED_DEST_SLOT),
      accept: async (_o, token) => token === SAVED_DEST_SLOT.token,
    }),
  );
  assert.equal(result.token, SAVED_DEST_SLOT.token);
});

test("VAL-MEM-002 (N3): an env write token never writes (save seam not called)", async () => {
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "env-write",
      accept: async (_o, token) => token === "env-write",
    }),
  );
  assert.equal(result.token, "env-write");
});

test("VAL-MEM-002 (N3): an inherited write token never writes (save seam not called)", async () => {
  const result = await resolveWriteToken(
    writeOptions({
      accept: async (_o, token) => token === "inherited-good",
      getInheritedCredential: async () => ({ token: "inherited-good", source: "classic" }),
    }),
  );
  assert.equal(result.token, "inherited-good");
});

test("VAL-MEM-002 (N2): env GITHUB_TOKEN still wins over a saved destinationTokens key", async () => {
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "env-write",
      getConfig: () => destCfg(SAVED_DEST_SLOT),
      accept: async () => true, // both would pass; env must be offered first
    }),
  );
  assert.equal(result.token, "env-write");
});

// ===========================================================================
// VAL-MEM-SRC-001 — keyed read-token resolution (N1, N3)
// ===========================================================================

const SAVED_SRC_SLOT: TokenSlot = {
  token: "saved-src-tok",
  username: "src-user",
  source: "fine-grained",
};

test("VAL-MEM-SRC-001: a saved sourceTokens[owner] reads the source (paste 0 calls)", async () => {
  let pasteCalls = 0;
  const result = await resolveReadToken(
    readOptions({
      writeToken: "write-only", // does not read source
      getConfig: () => srcCfg(SAVED_SRC_SLOT),
      makeOctokit: readFactory(new Set([SAVED_SRC_SLOT.token])),
      getPaste: async () => { pasteCalls += 1; return "x"; },
    }),
  );
  assert.equal(result.token, SAVED_SRC_SLOT.token);
  assert.equal(result.fromPaste, false);
  assert.equal(pasteCalls, 0, "saved owner key hit -> no paste");
});

test("VAL-MEM-SRC-001: a token saved under a DIFFERENT owner misses -> prompts and saves under owner2", async () => {
  // saved under owner "other"; resolving SOURCE (acme) must not see it.
  const saved: Array<Partial<Config>> = [];
  let pasteCalls = 0;
  const result = await quiet(() =>
    resolveReadToken(
      readOptions({
        writeToken: "write-only",
        getConfig: () => srcCfg(SAVED_SRC_SLOT, { owner: "other", repo: "x" }),
        makeOctokit: readFactory(new Set(["pasted-read"]), (t) =>
          t === "pasted-read" ? "reader" : "w",
        ),
        getPaste: async () => { pasteCalls += 1; return "pasted-read"; },
        saveConfig: (u) => saved.push(u),
      }),
    ),
  );
  assert.equal(result.token, "pasted-read");
  assert.equal(pasteCalls, 1);
  const map = saved.find((s) => s.sourceTokens)?.sourceTokens;
  assert.ok(map, "sourceTokens written");
  // Persisted under SOURCE's owner key only.
  assert.deepEqual(Object.keys(map!), [sourceKey(SOURCE.owner)]);
});

test("VAL-MEM-SRC-001 (N1): saved under Foo, resolving foo hits (0 paste calls)", async () => {
  const mixedSrc: RepoRef = { owner: "Foo", repo: "api" };
  const lowerSrc: RepoRef = { owner: "foo", repo: "api" };
  let pasteCalls = 0;
  // readFactory keys readability on SOURCE; build a source-specific factory.
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
          const isSource =
            args.owner === lowerSrc.owner && args.repo === lowerSrc.repo;
          if (isSource && token === SAVED_SRC_SLOT.token) {
            return { data: { permissions: { push: false } } };
          }
          throw httpError(404);
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: "u" } }) },
    }) as unknown as ResolverOctokit;
  const result = await resolveReadToken(
    readOptions({
      source: lowerSrc,
      writeToken: "",
      getConfig: () => srcCfg(SAVED_SRC_SLOT, mixedSrc),
      makeOctokit: factory,
      getPaste: async () => { pasteCalls += 1; return "x"; },
    }),
  );
  assert.equal(result.token, SAVED_SRC_SLOT.token);
  assert.equal(pasteCalls, 0, "case-insensitive owner key hit");
});

test("VAL-MEM-SRC-001 (N3): the single-PAT write-reuse does NOT write sourceTokens", async () => {
  // writeOptions/readOptions default saveConfig throws if called; the reused
  // write token is fromPaste:false, so no save fires.
  const result = await resolveReadToken(
    readOptions({
      writeToken: "one-pat",
      makeOctokit: readFactory(new Set(["one-pat"])),
    }),
  );
  assert.equal(result.token, "one-pat");
  assert.equal(result.fromPaste, false);
});

test("VAL-MEM-SRC-001 (N3): a saved-key HIT never writes; env still wins over saved key", async () => {
  // saved-key hit: no save.
  const hit = await resolveReadToken(
    readOptions({
      writeToken: "write-only",
      getConfig: () => srcCfg(SAVED_SRC_SLOT),
      makeOctokit: readFactory(new Set([SAVED_SRC_SLOT.token])),
    }),
  );
  assert.equal(hit.token, SAVED_SRC_SLOT.token);

  // env wins over the saved key (N2).
  const env = await resolveReadToken(
    readOptions({
      writeToken: "write-only",
      getEnvToken: () => "env-read",
      getConfig: () => srcCfg(SAVED_SRC_SLOT),
      makeOctokit: readFactory(new Set(["env-read", SAVED_SRC_SLOT.token])),
    }),
  );
  assert.equal(env.token, "env-read");
});

// Type-only: confirm AcceptToken is exported and shaped as documented.
const _acceptTypeCheck: AcceptToken = async (_octokit, _token) => true;
void _acceptTypeCheck;
