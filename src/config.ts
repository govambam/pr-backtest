/**
 * XDG-aware config file read/write.
 *
 * Tokens live in a JSON file with mode 0600 (owner read/write only).
 * Never log a token; never write one anywhere except this file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warn } from "./log.js";

/**
 * One-time guard so the "old token couldn't be migrated" note (N6) prints at most
 * once per process, even though {@link readConfig} runs on several code paths.
 */
let warnedDroppedOldToken = false;

/** The source a token was obtained from. */
export type TokenSource = "fine-grained" | "classic";

/**
 * Infer a token's source from its prefix: `github_pat_` is a fine-grained PAT;
 * `ghp_` (and everything else) is a classic PAT. Shared by every token entry
 * point (paste, env, inherited credential) so the prefix rule lives in one place.
 */
export function inferTokenSource(token: string): TokenSource {
  return token.startsWith("github_pat_") ? "fine-grained" : "classic";
}

/**
 * A repo coordinate (`owner`/`repo`). Carries no token value — only the location
 * a capability acts on. Defined here (a leaf module) so both `auth.ts` and
 * `destination.ts` share one type without an import cycle.
 */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * A named token slot: a `token` secret plus its `username` (@login) and the
 * `source` it was obtained from. Like the rest of the config, the `token` is a
 * secret: it lives only in the 0600 file and is never logged.
 */
export interface TokenSlot {
  token: string;
  username: string;
  source: TokenSource;
}

/**
 * Persisted config shape (per-repo memory).
 *
 * Three independent, optional keyed maps:
 * - `sandboxes` — the sandbox to reuse for a given SOURCE repo, keyed by the
 *   lowercased `"<srcOwner>/<srcRepo>"`.
 * - `destinationTokens` — the write token per DESTINATION repo, keyed by the
 *   lowercased `"<destOwner>/<destRepo>"`.
 * - `sourceTokens` — the read token per SOURCE owner, keyed by the lowercased
 *   `"<srcOwner>"`.
 *
 * All keys are lowercased at BOTH write and lookup (GitHub owner/repo are
 * case-insensitive). Use {@link repoKey}/{@link sourceKey} so callers store and
 * read consistently.
 *
 * The OLD single-slot `sourceToken`/`destinationToken`/`defaultDestination`
 * fields are NOT part of this schema; {@link readConfig} migrates them in memory
 * (see its docstring for the salvage/drop rules) and they are never written back.
 */
export interface Config {
  sandboxes?: { [srcOwnerRepo: string]: RepoRef };
  destinationTokens?: { [destOwnerRepo: string]: TokenSlot };
  sourceTokens?: { [srcOwner: string]: TokenSlot };
}

// ---------------------------------------------------------------------------
// Key normalization (N1). All map keys are lowercased at BOTH write and lookup.
// Saving under `Foo/Bar` and resolving `foo/bar` is the SAME entry.
// ---------------------------------------------------------------------------

/**
 * Key for the repo-keyed maps (`sandboxes`, `destinationTokens`): lowercased
 * `"<owner>/<repo>"`. Shared by both so the normalization rule lives in one place.
 */
export function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

/** Key for the `sourceTokens` map: lowercased `"<owner>"`. */
export function sourceKey(owner: string): string {
  return owner.toLowerCase();
}

/**
 * Resolve the config file path.
 *
 * - Windows: `%APPDATA%\pr-backtest\config.json`
 * - Otherwise: `$XDG_CONFIG_HOME/pr-backtest/config.json`,
 *   defaulting to `~/.config/pr-backtest/config.json`.
 */
export function configPath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "pr-backtest", "config.json");
  }
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(base, "pr-backtest", "config.json");
}

function isTokenSource(value: unknown): value is TokenSource {
  return value === "fine-grained" || value === "classic";
}

/** A complete token slot: `token` + `username` (strings) + a valid `source`. */
function isTokenSlot(value: unknown): value is TokenSlot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.token === "string" &&
    typeof obj.username === "string" &&
    isTokenSource(obj.source)
  );
}

/** A `{ owner: string, repo: string }` repo coordinate. */
function isRepoRef(value: unknown): value is RepoRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).owner === "string" &&
    typeof (value as Record<string, unknown>).repo === "string"
  );
}

/**
 * Read a keyed map field, validating every entry independently: a malformed key
 * or value is warned about and DROPPED, while valid siblings survive. Keys are
 * normalized to lowercase (N1). Returns undefined when no valid entry survives.
 */
function readKeyedMap<V>(
  raw: unknown,
  fieldName: string,
  filePath: string,
  isValue: (v: unknown) => v is V,
): { [key: string]: V } | undefined {
  if (typeof raw !== "object" || raw === null) {
    warn(`Config file ${filePath} ${fieldName} is malformed; ignoring it.`);
    return undefined;
  }
  const out: { [key: string]: V } = {};
  let any = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || !isValue(value)) {
      warn(
        `Config file ${filePath} ${fieldName}["${key}"] is malformed; ignoring it.`,
      );
      continue;
    }
    const lowered = key.toLowerCase();
    if (out[lowered] !== undefined) {
      // Two keys collide after lowercasing (e.g. a hand-edited config with both
      // `Foo/Bar` and `foo/bar`). Keys are case-insensitive, so this is one
      // entry; warn that the later case-variant wins rather than dropping silently.
      warn(
        `Config file ${filePath} ${fieldName}["${key}"] collides with an earlier ` +
          `case-variant of the same key; the later one wins.`,
      );
    }
    out[lowered] = value;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Read the config file. Returns null if it does not exist, is unparseable, or
 * holds no recognized field.
 *
 * Each map entry is validated independently: a present-but-malformed entry is
 * warned about and dropped, while valid sibling entries (and the other maps)
 * survive. Mirrors the old single-slot tolerance, now per entry.
 *
 * Migration (N6) is read-only and in-memory: an OLD-shape file
 * (`sourceToken`/`destinationToken`/`defaultDestination`) is folded into the new
 * keyed maps, FILLING ONLY keys not already present (new keys win; old fields
 * never overwrite). Salvage: an old `destinationToken` migrates to
 * `destinationTokens[<defaultDestination>]` IFF that key is free. DROPPED (not
 * mis-keyed): an old `destinationToken` with no `defaultDestination`; a bare old
 * `sourceToken` (no recorded owner); a bare `defaultDestination`. When a
 * well-formed old token is DROPPED (can't be keyed) we warn ONCE that it must be
 * re-pasted. Reading performs NO disk write — old fields leave disk only on the
 * next {@link mergeConfig}.
 *
 * Warns (does not throw) if the file's permissions have been loosened so that
 * group or other can read it.
 */
export function readConfig(): Config | null {
  const filePath = configPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  // On POSIX, warn if any group/other permission bits are set.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    warn(
      `Config file ${filePath} is readable by group/other (mode ${(
        stat.mode & 0o777
      ).toString(8)}). Consider: chmod 600 ${filePath}`,
    );
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`Config file ${filePath} is not valid JSON; ignoring it.`);
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    warn(`Config file ${filePath} is malformed; ignoring it.`);
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const cfg: Config = {};

  // --- New keyed maps (each entry validated independently, keys lowercased). ---
  if (obj.sandboxes !== undefined) {
    const map = readKeyedMap<RepoRef>(
      obj.sandboxes,
      "sandboxes",
      filePath,
      isRepoRef,
    );
    if (map) {
      cfg.sandboxes = map;
    }
  }
  if (obj.destinationTokens !== undefined) {
    const map = readKeyedMap<TokenSlot>(
      obj.destinationTokens,
      "destinationTokens",
      filePath,
      isTokenSlot,
    );
    if (map) {
      cfg.destinationTokens = map;
    }
  }
  if (obj.sourceTokens !== undefined) {
    const map = readKeyedMap<TokenSlot>(
      obj.sourceTokens,
      "sourceTokens",
      filePath,
      isTokenSlot,
    );
    if (map) {
      cfg.sourceTokens = map;
    }
  }

  // --- N6 migration: fold OLD single fields into the new maps (in memory). ---
  // Salvage/drop rules live in the readConfig docstring. Reads the RAW on-disk
  // object (not a Config field) so it survives `defaultDestination` leaving the type.
  let oldDefault: RepoRef | undefined;
  if (obj.defaultDestination !== undefined) {
    if (isRepoRef(obj.defaultDestination)) {
      oldDefault = {
        owner: obj.defaultDestination.owner,
        repo: obj.defaultDestination.repo,
      };
    } else {
      warn(
        `Config file ${filePath} defaultDestination is malformed; ignoring it.`,
      );
    }
  }

  // Tracks whether a well-formed old token was dropped because it can't be keyed,
  // so we can explain the forced re-paste once (below).
  let droppedSalvageableToken = false;

  if (obj.destinationToken !== undefined) {
    if (isTokenSlot(obj.destinationToken)) {
      const key = oldDefault
        ? repoKey(oldDefault.owner, oldDefault.repo)
        : undefined;
      const existing = cfg.destinationTokens ?? {};
      // Salvage only when the destination key is both known AND free: a present
      // new-map key always wins, and a bare destinationToken has no key to use.
      if (key !== undefined && existing[key] === undefined) {
        existing[key] = {
          token: obj.destinationToken.token,
          username: obj.destinationToken.username,
          source: obj.destinationToken.source,
        };
        cfg.destinationTokens = existing;
      } else if (key === undefined) {
        droppedSalvageableToken = true;
      }
    } else {
      warn(`Config file ${filePath} destinationToken is malformed; ignoring it.`);
    }
  }

  if (obj.sourceToken !== undefined) {
    if (isTokenSlot(obj.sourceToken)) {
      // A well-formed old sourceToken has no recorded owner to key it by → DROP.
      droppedSalvageableToken = true;
    } else {
      warn(`Config file ${filePath} sourceToken is malformed; ignoring it.`);
    }
  }

  // A well-formed old token couldn't be carried into the new keyed maps; explain
  // the forced re-paste ONCE per process (malformed entries already warned above).
  if (droppedSalvageableToken && !warnedDroppedOldToken) {
    warnedDroppedOldToken = true;
    warn(
      "Upgraded saved config to per-repo memory; an old saved token couldn't be " +
        "carried over — you'll be asked to paste it once.",
    );
  }

  // A file with zero recognized fields is treated as no config at all. A bare
  // old defaultDestination is NOT a recognized field — it salvages nothing on its
  // own and is not part of the new schema — so it does not keep the config alive.
  if (
    cfg.sandboxes === undefined &&
    cfg.destinationTokens === undefined &&
    cfg.sourceTokens === undefined
  ) {
    return null;
  }

  return cfg;
}

/**
 * Write the config file with mode 0600 (owner read/write only).
 * Parent directories are created as needed.
 */
export function writeConfig(cfg: Config): void {
  const filePath = configPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
  // writeFileSync only applies `mode` when creating the file; enforce it
  // explicitly so an existing, looser file gets tightened on rewrite.
  fs.chmodSync(filePath, 0o600);
}

/**
 * Merge a partial update into the existing config (read-modify-write).
 *
 * N5 — merge, never replace. Each keyed map in `update` is deep-merged into the
 * existing map so writing ONE key preserves the other keys AND their values:
 * saving `destinationTokens[B]` leaves `destinationTokens[A]` byte-identical.
 * Re-asserts mode 0600 on every write, exactly as {@link writeConfig}.
 */
export function mergeConfig(update: Partial<Config>): void {
  const existing = readConfig() ?? {};
  const merged: Config = { ...existing };

  if (update.sandboxes !== undefined) {
    merged.sandboxes = { ...(existing.sandboxes ?? {}), ...update.sandboxes };
  }
  if (update.destinationTokens !== undefined) {
    merged.destinationTokens = {
      ...(existing.destinationTokens ?? {}),
      ...update.destinationTokens,
    };
  }
  if (update.sourceTokens !== undefined) {
    merged.sourceTokens = {
      ...(existing.sourceTokens ?? {}),
      ...update.sourceTokens,
    };
  }

  writeConfig(merged);
}

/**
 * Delete the config file (used by `logout`).
 *
 * Removes the whole file, including every saved sandbox and token slot.
 * Tolerates an already-absent file (ENOENT).
 */
export function deleteConfig(): void {
  const filePath = configPath();
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}
