/**
 * XDG-aware config file read/write.
 *
 * The token lives in a JSON file with mode 0600 (owner read/write only).
 * Never log the token; never write it anywhere except this file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warn } from "./log.js";

/** The source a token was obtained from. */
export type TokenSource = "fine-grained" | "classic" | "gh-cli";

/** Persisted config shape. */
export interface Config {
  token: string;
  username: string;
  source: TokenSource;
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
  return value === "fine-grained" || value === "classic" || value === "gh-cli";
}

/**
 * Read the config file. Returns null if it does not exist.
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

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).token !== "string" ||
    typeof (parsed as Record<string, unknown>).username !== "string" ||
    !isTokenSource((parsed as Record<string, unknown>).source)
  ) {
    warn(`Config file ${filePath} is malformed; ignoring it.`);
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  return {
    token: obj.token as string,
    username: obj.username as string,
    source: obj.source as TokenSource,
  };
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
 * Delete the config file (used by `logout`).
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
