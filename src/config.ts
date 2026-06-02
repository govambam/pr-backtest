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

/** The source a token was obtained from. */
export type TokenSource = "fine-grained" | "classic";

/**
 * A repo coordinate (`owner`/`repo`). Carries no token value — only the location
 * a capability acts on. Defined here (a leaf module) so both `auth.ts` and
 * `destination.ts` share one type without an import cycle.
 */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** A saved write destination (the repo branches/PRs are pushed to). */
export interface SavedDestination {
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
 * Persisted config shape.
 *
 * Two named token slots plus an optional saved destination, each independent
 * and optional:
 * - `sourceToken` — the token used to read the source PR/repo.
 * - `destinationToken` — the token used to write branches/PRs to the
 *   destination. In a single-PAT run both slots may hold the same value.
 * - `defaultDestination` — the saved write destination.
 *
 * Any field may be absent (a config may hold only a `defaultDestination` when a
 * token came from the environment or `gh` and was never persisted).
 */
export interface Config {
  sourceToken?: TokenSlot;
  destinationToken?: TokenSlot;
  defaultDestination?: SavedDestination;
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

/** A `defaultDestination` shaped as `{ owner: string, repo: string }`. */
function isSavedDestination(value: unknown): value is SavedDestination {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).owner === "string" &&
    typeof (value as Record<string, unknown>).repo === "string"
  );
}

/**
 * Read the config file. Returns null if it does not exist, is unparseable, or
 * holds no recognized field.
 *
 * Each slot is validated independently: a present-but-malformed slot (or
 * `defaultDestination`) is warned about and dropped, while valid sibling fields
 * in the same file are still returned.
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

  // Each slot is validated independently: a present-but-malformed slot is
  // warned about and dropped, while a valid sibling slot survives.
  if (obj.sourceToken !== undefined) {
    if (isTokenSlot(obj.sourceToken)) {
      cfg.sourceToken = {
        token: obj.sourceToken.token,
        username: obj.sourceToken.username,
        source: obj.sourceToken.source,
      };
    } else {
      warn(`Config file ${filePath} sourceToken is malformed; ignoring it.`);
    }
  }

  if (obj.destinationToken !== undefined) {
    if (isTokenSlot(obj.destinationToken)) {
      cfg.destinationToken = {
        token: obj.destinationToken.token,
        username: obj.destinationToken.username,
        source: obj.destinationToken.source,
      };
    } else {
      warn(
        `Config file ${filePath} destinationToken is malformed; ignoring it.`,
      );
    }
  }

  if (obj.defaultDestination !== undefined) {
    if (isSavedDestination(obj.defaultDestination)) {
      cfg.defaultDestination = {
        owner: obj.defaultDestination.owner,
        repo: obj.defaultDestination.repo,
      };
    } else {
      warn(
        `Config file ${filePath} defaultDestination is malformed; ignoring it.`,
      );
    }
  }

  // A file with zero recognized fields is treated as no config at all.
  if (
    cfg.sourceToken === undefined &&
    cfg.destinationToken === undefined &&
    cfg.defaultDestination === undefined
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
 * Unlike {@link writeConfig}, which replaces the whole object, this preserves
 * fields not present in `update`: saving a `destinationToken` keeps a saved
 * `sourceToken` and `defaultDestination`, and vice versa. Re-asserts mode 0600
 * on every write, exactly as {@link writeConfig} does.
 */
export function mergeConfig(update: Partial<Config>): void {
  const existing = readConfig() ?? {};
  const merged: Config = { ...existing, ...update };
  writeConfig(merged);
}

/**
 * Delete the config file (used by `logout`).
 *
 * Removes the whole file, including both token slots and the
 * `defaultDestination`. Tolerates an already-absent file (ENOENT).
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
