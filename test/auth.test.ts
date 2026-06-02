import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveRunTokens,
  resolveWriteToken,
  resolveReadToken,
  canRead,
  canWrite,
  NoTokenNonInteractiveError,
  NoSourceTokenNonInteractiveError,
  type ResolveRunTokensOptions,
  type ResolveWriteTokenOptions,
  type ResolveReadTokenOptions,
  type ResolverOctokit,
  type AcceptToken,
  type RepoRef,
} from "../src/auth.js";
import type { Config } from "../src/config.js";
import { setVerbose, setTtyOverride, redact } from "../src/log.js";

const SOURCE: RepoRef = { owner: "acme", repo: "api" };
const DEST: RepoRef = { owner: "alice", repo: "sandbox" };

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

/** Base options with all interactive/persistence seams disabled (overridable). */
function baseOptions(
  overrides: Partial<ResolveRunTokensOptions>,
): ResolveRunTokensOptions {
  return {
    source: SOURCE,
    destination: DEST,
    isPrimary: false,
    makeOctokit: () => {
      throw new Error("makeOctokit not configured for this test");
    },
    getWriteEnvToken: () => undefined,
    getSourceEnvToken: () => undefined,
    getConfig: () => null,
    saveConfig: () => {
      throw new Error("saveConfig must NOT fire");
    },
    getPrimaryPaste: async () => {
      throw new Error("primary paste must NOT fire");
    },
    getSandboxReadPaste: async () => {
      throw new Error("sandbox read paste must NOT fire");
    },
    getSandboxWritePaste: async () => {
      throw new Error("sandbox write paste must NOT fire");
    },
    ...overrides,
  };
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
// VAL-TOKEN-007: per-capability resolution order
// ===========================================================================

/** A Primary-mode fake: destination === source; `rw` tokens read AND write it. */
function primaryFactory(rw: Set<string>) {
  return (token: string): ResolverOctokit =>
    ({
      repos: {
        get: (async () =>
          rw.has(token)
            ? { data: { permissions: { push: true } } }
            : (() => { throw httpError(404); })()) as unknown as ResolverOctokit["repos"]["get"],
      } as unknown as ResolverOctokit["repos"],
      users: {
        getAuthenticated: (async () => ({
          data: { login: `u-${token}` },
        })) as unknown as ResolverOctokit["users"]["getAuthenticated"],
      } as unknown as ResolverOctokit["users"],
    }) as unknown as ResolverOctokit;
}

test("VAL-TOKEN-007: write order — GITHUB_TOKEN env wins over saved destinationToken", async () => {
  const factory = primaryFactory(new Set(["write-env", "saved-dest"]));
  const cfg: Config = {
    destinationToken: { token: "saved-dest", username: "u", source: "fine-grained" },
  };
  const result = await resolveRunTokens(
    baseOptions({
      isPrimary: true,
      source: SOURCE,
      destination: SOURCE, // Primary
      makeOctokit: factory,
      getWriteEnvToken: () => "write-env",
      getConfig: () => cfg,
    }),
  );
  assert.equal(result.writeToken, "write-env");
});

test("VAL-TOKEN-007: write order — saved destinationToken used when env is absent", async () => {
  const factory = primaryFactory(new Set(["saved-dest"]));
  const cfg: Config = {
    destinationToken: { token: "saved-dest", username: "u", source: "fine-grained" },
    sourceToken: { token: "saved-dest", username: "u", source: "fine-grained" },
  };
  const result = await resolveRunTokens(
    baseOptions({
      isPrimary: true,
      destination: SOURCE,
      makeOctokit: factory,
      getConfig: () => cfg,
    }),
  );
  assert.equal(result.writeToken, "saved-dest");
  assert.equal(result.readToken, "saved-dest");
  assert.equal(result.twoToken, false);
});

test("VAL-TOKEN-007: read order — GITHUB_SOURCE_TOKEN env wins over saved sourceToken and write-reuse", async () => {
  const { factory } = makeFactory({
    readable: new Set(["src-env", "saved-src", "write-env"]),
    writable: new Set(["write-env"]),
  });
  const cfg: Config = {
    sourceToken: { token: "saved-src", username: "u", source: "fine-grained" },
  };
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getWriteEnvToken: () => "write-env",
      getSourceEnvToken: () => "src-env",
      getConfig: () => cfg,
    }),
  );
  assert.equal(result.readToken, "src-env");
  assert.equal(result.writeToken, "write-env");
  assert.equal(result.twoToken, true);
});

test("VAL-TOKEN-007: read order — saved sourceToken used over write-reuse when source env absent", async () => {
  const { factory } = makeFactory({
    readable: new Set(["saved-src", "write-env"]),
    writable: new Set(["write-env"]),
  });
  const cfg: Config = {
    sourceToken: { token: "saved-src", username: "u", source: "fine-grained" },
  };
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getWriteEnvToken: () => "write-env",
      getConfig: () => cfg,
    }),
  );
  assert.equal(result.readToken, "saved-src");
  assert.equal(result.writeToken, "write-env");
  assert.equal(result.twoToken, true);
});

test("VAL-TOKEN-007: read reuses the resolved write token when it reads the source (single-PAT)", async () => {
  // No source env, no saved source slot: the write token is offered for read and
  // it reads the source, so it fills both slots with NO read prompt.
  const { factory } = makeFactory({
    readable: new Set(["one-pat"]),
    writable: new Set(["one-pat"]),
  });
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getWriteEnvToken: () => "one-pat",
    }),
  );
  assert.equal(result.readToken, "one-pat");
  assert.equal(result.writeToken, "one-pat");
  assert.equal(result.twoToken, false);
});

// ===========================================================================
// VAL-TOKEN-003: single-PAT detection skips the read prompt
// ===========================================================================

test("VAL-TOKEN-003: a single token reading source + writing dest resolves with no read prompt", async () => {
  const { factory } = makeFactory({
    readable: new Set(["one-pat"]),
    writable: new Set(["one-pat"]),
  });
  let readPasteFired = false;
  let writePasteFired = false;
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getWriteEnvToken: () => "one-pat",
      getSandboxReadPaste: async () => {
        readPasteFired = true;
        return null;
      },
      getSandboxWritePaste: async () => {
        writePasteFired = true;
        return null;
      },
    }),
  );
  assert.equal(result.twoToken, false);
  assert.equal(readPasteFired, false, "no read prompt for a single covering PAT");
  assert.equal(writePasteFired, false, "no write prompt — env covers write");
});

// ===========================================================================
// VAL-TOKEN-004: non-interactive env resolution
// ===========================================================================

test("VAL-TOKEN-004: GITHUB_SOURCE_TOKEN reads, GITHUB_TOKEN writes (two distinct tokens)", async () => {
  const { factory } = makeFactory({
    readable: new Set(["src-env"]),
    writable: new Set(["write-env"]),
  });
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getSourceEnvToken: () => "src-env",
      getWriteEnvToken: () => "write-env",
    }),
  );
  assert.equal(result.readToken, "src-env");
  assert.equal(result.writeToken, "write-env");
  assert.equal(result.twoToken, true);
});

test("VAL-TOKEN-004: only GITHUB_TOKEN set, covering both, still works (single-PAT non-interactive)", async () => {
  const { factory } = makeFactory({
    readable: new Set(["only-write-env"]),
    writable: new Set(["only-write-env"]),
  });
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getWriteEnvToken: () => "only-write-env",
    }),
  );
  assert.equal(result.readToken, "only-write-env");
  assert.equal(result.writeToken, "only-write-env");
  assert.equal(result.twoToken, false);
});

// ===========================================================================
// VAL-TOKEN-006: non-interactive missing WRITE token names GITHUB_TOKEN
// ===========================================================================

test("VAL-TOKEN-006: no resolvable write token, non-interactive, exits naming GITHUB_TOKEN", async () => {
  const { factory } = makeFactory({ readable: new Set(), writable: new Set() });
  await assert.rejects(
    () =>
      resolveRunTokens(
        baseOptions({
          makeOctokit: factory,
          // no env, no config; sandbox write paste returns null (non-TTY).
          getSandboxWritePaste: async () => null,
        }),
      ),
    (e: unknown) =>
      e instanceof NoTokenNonInteractiveError &&
      !(e instanceof NoSourceTokenNonInteractiveError) &&
      /GITHUB_TOKEN/.test((e as Error).message),
  );
});

// ===========================================================================
// VAL-TOKEN-005: non-interactive missing READ token names GITHUB_SOURCE_TOKEN
// ===========================================================================

test("VAL-TOKEN-005: write resolves but source unreadable, non-interactive, exits naming GITHUB_SOURCE_TOKEN before any write", async () => {
  // Write token writes the dest but cannot read the source; no read paste (non-TTY).
  const { factory } = makeFactory({
    readable: new Set(),
    writable: new Set(["write-only"]),
  });
  await assert.rejects(
    () =>
      resolveRunTokens(
        baseOptions({
          makeOctokit: factory,
          getWriteEnvToken: () => "write-only",
          getSandboxReadPaste: async () => null,
        }),
      ),
    (e: unknown) =>
      e instanceof NoSourceTokenNonInteractiveError &&
      e instanceof NoTokenNonInteractiveError &&
      /GITHUB_SOURCE_TOKEN/.test((e as Error).message),
  );
});

// ===========================================================================
// VAL-TOKEN-001: Primary read-only token rejected with a write-scope message
// ===========================================================================

test("VAL-TOKEN-001: Primary read-only token is rejected (canWrite fails) and re-prompts with write-scope message", async () => {
  // The first token reads but cannot write the source (read-only); the second can.
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async () => {
          if (token === "rw") return { data: { permissions: { push: true } } };
          // read-only: visible (read) but no push.
          return { data: { permissions: { push: false } } };
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: `u-${token}` } }) },
    }) as unknown as ResolverOctokit;

  const messages: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    messages.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;

  let pasteCalls = 0;
  let result;
  try {
    result = await resolveRunTokens(
      baseOptions({
        isPrimary: true,
        destination: SOURCE,
        makeOctokit: factory,
        getPrimaryPaste: async () => {
          pasteCalls += 1;
          return pasteCalls === 1 ? "read-only" : "rw";
        },
        saveConfig: () => {},
      }),
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result.writeToken, "rw");
  assert.equal(pasteCalls, 2, "re-prompted after the read-only token failed canWrite");
  const joined = messages.join("");
  assert.match(joined, /cannot write/i);
});

// ===========================================================================
// VAL-TOKEN-009: bounded 3-attempt re-prompt then error
// ===========================================================================

test("VAL-TOKEN-009: a paste that keeps failing re-prompts up to 3 attempts then throws", async () => {
  const { factory } = makeFactory({ readable: new Set(), writable: new Set() });
  let pasteCalls = 0;
  await assert.rejects(
    () =>
      quiet(() =>
        resolveRunTokens(
          baseOptions({
            isPrimary: true,
            destination: SOURCE,
            makeOctokit: factory,
            getPrimaryPaste: async () => {
              pasteCalls += 1;
              return "always-bad";
            },
            saveConfig: () => {},
          }),
        ),
      ),
    (e: unknown) => e instanceof NoTokenNonInteractiveError,
  );
  assert.equal(pasteCalls, 3, "bounded to 3 paste attempts");
});

test("VAL-TOKEN-009: a paste that fails once then succeeds resolves without throwing", async () => {
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async () =>
          token === "good"
            ? { data: { permissions: { push: true } } }
            : (() => { throw httpError(404); })(),
      },
      users: { getAuthenticated: async () => ({ data: { login: "u" } }) },
    }) as unknown as ResolverOctokit;
  let pasteCalls = 0;
  const result = await quiet(() =>
    resolveRunTokens(
      baseOptions({
        isPrimary: true,
        destination: SOURCE,
        makeOctokit: factory,
        getPrimaryPaste: async () => {
          pasteCalls += 1;
          return pasteCalls === 1 ? "bad" : "good";
        },
        saveConfig: () => {},
      }),
    ),
  );
  assert.equal(result.writeToken, "good");
  assert.equal(pasteCalls, 2);
});

// ===========================================================================
// Persistence: pasted write -> destinationToken, pasted read -> sourceToken
// ===========================================================================

test("a freshly pasted write token persists to destinationToken with @login", async () => {
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async () =>
          token === "pasted-write"
            ? { data: { permissions: { push: true } } }
            : (() => { throw httpError(404); })(),
      },
      users: { getAuthenticated: async () => ({ data: { login: "writer" } }) },
    }) as unknown as ResolverOctokit;
  const saved: Array<Partial<Config>> = [];
  await quiet(() =>
    resolveRunTokens(
      baseOptions({
        isPrimary: true,
        destination: SOURCE,
        makeOctokit: factory,
        getPrimaryPaste: async () => "pasted-write",
        saveConfig: (u) => saved.push(u),
      }),
    ),
  );
  const destSave = saved.find((s) => s.destinationToken);
  assert.ok(destSave, "destinationToken was persisted");
  assert.equal(destSave!.destinationToken!.token, "pasted-write");
  assert.equal(destSave!.destinationToken!.username, "writer");
});

test("a freshly pasted read token persists to sourceToken with @login", async () => {
  // Write resolves from env; read falls through to the sandbox read paste.
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
          const isSource = args.owner === SOURCE.owner && args.repo === SOURCE.repo;
          if (isSource) {
            if (token === "pasted-read") return { data: { permissions: { push: false } } };
            throw httpError(404);
          }
          if (token === "write-env") return { data: { permissions: { push: true } } };
          throw httpError(404);
        },
      },
      users: {
        getAuthenticated: async () => ({
          data: { login: token === "pasted-read" ? "reader" : "writer" },
        }),
      },
    }) as unknown as ResolverOctokit;
  const saved: Array<Partial<Config>> = [];
  const result = await quiet(() =>
    resolveRunTokens(
      baseOptions({
        makeOctokit: factory,
        getWriteEnvToken: () => "write-env",
        getSandboxReadPaste: async () => "pasted-read",
        saveConfig: (u) => saved.push(u),
      }),
    ),
  );
  assert.equal(result.readToken, "pasted-read");
  assert.equal(result.writeToken, "write-env");
  assert.equal(result.twoToken, true);
  const srcSave = saved.find((s) => s.sourceToken);
  assert.ok(srcSave, "sourceToken was persisted");
  assert.equal(srcSave!.sourceToken!.token, "pasted-read");
  assert.equal(srcSave!.sourceToken!.username, "reader");
});

test("a pasted token GitHub rejects (getAuthenticated throws) surfaces an error", async () => {
  const factory = (_token: string): ResolverOctokit =>
    ({
      repos: { get: async () => ({ data: { permissions: { push: true } } }) },
      users: { getAuthenticated: async () => { throw httpError(401); } },
    }) as unknown as ResolverOctokit;
  await assert.rejects(
    () =>
      quiet(() =>
        resolveRunTokens(
          baseOptions({
            isPrimary: true,
            destination: SOURCE,
            makeOctokit: factory,
            getPrimaryPaste: async () => "pasted",
            saveConfig: () => {},
          }),
        ),
      ),
    /GitHub rejected the pasted token/,
  );
});

// ===========================================================================
// VAL-INV-003: each distinct token is scrubbed before its first request
// ===========================================================================

test("VAL-INV-003: each of two distinct tokens is scrubbed before its first probe request", async () => {
  const readSentinel = "ghp_read_sentinel_0123456789abcdef";
  const writeSentinel = "ghp_write_sentinel_0123456789abcdef";
  const redactedAtFirstRequest = new Map<string, string>();

  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
          if (!redactedAtFirstRequest.has(token)) {
            redactedAtFirstRequest.set(token, redact(`auth=${token}`));
          }
          const isSource =
            args.owner === SOURCE.owner && args.repo === SOURCE.repo;
          if (isSource) {
            if (token === readSentinel) return { data: { permissions: { push: false } } };
            throw httpError(404);
          }
          if (token === writeSentinel) return { data: { permissions: { push: true } } };
          throw httpError(404);
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: "u" } }) },
    }) as unknown as ResolverOctokit;

  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getSourceEnvToken: () => readSentinel,
      getWriteEnvToken: () => writeSentinel,
    }),
  );

  assert.equal(result.readToken, readSentinel);
  assert.equal(result.writeToken, writeSentinel);
  assert.notEqual(result.readToken, result.writeToken);
  assert.equal(redactedAtFirstRequest.get(readSentinel), "auth=***");
  assert.equal(redactedAtFirstRequest.get(writeSentinel), "auth=***");
});

// ===========================================================================
// VAL-TOKEN-010: prompt copy for Primary / Sandbox-read / Sandbox-write
// ===========================================================================

test("VAL-TOKEN-010: source auth.ts carries Primary/Sandbox-read/Sandbox-write prompt copy", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const src = fs.readFileSync(
    url.fileURLToPath(new URL("../src/auth.ts", import.meta.url)),
    "utf8",
  );
  // Primary + Sandbox-write: read + write on the target.
  assert.match(src, /read \+ write on the source/);
  assert.match(src, /write on the destination/);
  assert.match(src, /Contents:\s+Read & write/);
  assert.match(src, /Pull requests:\s+Read & write/);
  // Sandbox read-only token #1.
  assert.match(src, /read-only token is enough/);
  assert.match(src, /no write access anywhere/i);
  // The creation URL is included.
  assert.match(src, /settings\/personal-access-tokens\/new/);
});

// ===========================================================================
// VAL-TOKEN-002 (resolver slice): quarantine — read-only source + separate write
// ===========================================================================

test("VAL-TOKEN-002: read-only source token + separate write token resolves two distinct tokens", async () => {
  const factory = (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
          const isSource =
            args.owner === SOURCE.owner && args.repo === SOURCE.repo;
          if (isSource) {
            // read-only token can read source; write token cannot.
            if (token === "ro-source") return { data: { permissions: { push: false } } };
            throw httpError(404);
          }
          if (token === "rw-dest") return { data: { permissions: { push: true } } };
          throw httpError(404);
        },
      },
      users: { getAuthenticated: async () => ({ data: { login: "u" } }) },
    }) as unknown as ResolverOctokit;
  const result = await resolveRunTokens(
    baseOptions({
      makeOctokit: factory,
      getSourceEnvToken: () => "ro-source",
      getWriteEnvToken: () => "rw-dest",
    }),
  );
  assert.equal(result.readToken, "ro-source");
  assert.equal(result.writeToken, "rw-dest");
  assert.equal(result.twoToken, true);
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
  const cfg: Config = {
    destinationToken: { token: "saved-dest", username: "u", source: "fine-grained" },
  };
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
  assert.equal(result.login, "u-write-env");
  assert.deepEqual(seen, ["write-env"], "saved slot is not tried once env is accepted");
});

test("resolveWriteToken: falls to saved destinationToken when env is not accepted", async () => {
  const cfg: Config = {
    destinationToken: { token: "saved-dest", username: "u", source: "classic" },
  };
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
  assert.equal(result.login, "creator");
  assert.equal(createAttempted, true);
});

test("resolveWriteToken: a caller's wrapped accept (false on rejection) falls through to the next candidate", async () => {
  // Contract: the CALLER wraps its verify-or-create check so a rejected candidate
  // returns false (not throws). Here the wrapped accept returns false for the env
  // token and true for the saved one, so resolution falls through correctly.
  const result = await resolveWriteToken(
    writeOptions({
      getEnvToken: () => "bad-token",
      getConfig: () => ({
        destinationToken: { token: "good-token", username: "u", source: "fine-grained" },
      }),
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
  const slot = saved.find((s) => s.destinationToken)?.destinationToken;
  assert.ok(slot, "destinationToken persisted");
  assert.equal(slot!.token, "pasted-write");
  assert.equal(slot!.username, "writer");
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

/** A factory keyed on canRead(source): tokens in `readable` read the source. */
function readFactory(readable: Set<string>, login?: (t: string) => string) {
  return (token: string): ResolverOctokit =>
    ({
      repos: {
        get: async (args: { owner: string; repo: string }) => {
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
  const cfg: Config = {
    sourceToken: { token: "saved-src", username: "u", source: "fine-grained" },
  };
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
  const cfg: Config = {
    sourceToken: { token: "saved-src", username: "u", source: "fine-grained" },
  };
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
  const result = await resolveReadToken(
    readOptions({
      writeToken: "one-pat",
      makeOctokit: readFactory(new Set(["one-pat"]), () => "owner"),
    }),
  );
  assert.equal(result.token, "one-pat");
  assert.equal(result.fromPaste, false);
  assert.equal(result.login, "owner");
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
  const slot = saved.find((s) => s.sourceToken)?.sourceToken;
  assert.ok(slot, "sourceToken persisted");
  assert.equal(slot!.username, "reader");
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

// Type-only: confirm AcceptToken is exported and shaped as documented.
const _acceptTypeCheck: AcceptToken = async (_octokit, _token) => true;
void _acceptTypeCheck;
