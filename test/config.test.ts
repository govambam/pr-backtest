import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configPath,
  deleteConfig,
  readConfig,
  writeConfig,
  type Config,
} from "../src/config.js";

const VALID: Config = { token: "t0kenvalue", username: "stevem", source: "classic" };

/** Point config at a fresh temp dir via XDG_CONFIG_HOME and return it. */
function useTempConfigHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prbt-cfg-"));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

/** Capture everything written to stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  return chunks.join("");
}

test("configPath honors XDG_CONFIG_HOME", () => {
  const dir = useTempConfigHome();
  assert.equal(configPath(), path.join(dir, "pr-backtest", "config.json"));
});

test("configPath falls back to ~/.config when XDG_CONFIG_HOME is unset or empty", { skip: process.platform === "win32" }, () => {
  delete process.env.XDG_CONFIG_HOME;
  assert.equal(
    configPath(),
    path.join(os.homedir(), ".config", "pr-backtest", "config.json"),
  );
  process.env.XDG_CONFIG_HOME = "";
  assert.equal(
    configPath(),
    path.join(os.homedir(), ".config", "pr-backtest", "config.json"),
  );
});

test("readConfig returns null when the file is absent", () => {
  useTempConfigHome();
  assert.equal(readConfig(), null);
});

test("writeConfig round-trips through readConfig", () => {
  useTempConfigHome();
  writeConfig(VALID);
  assert.deepEqual(readConfig(), VALID);
});

test("writeConfig writes mode 0600 and tightens an existing loose file", { skip: process.platform === "win32" }, () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Pre-create a world-readable file; writeConfig must tighten it.
  fs.writeFileSync(p, "{}", { mode: 0o644 });
  fs.chmodSync(p, 0o644);
  writeConfig(VALID);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test("readConfig warns (but still reads) when permissions are loosened", { skip: process.platform === "win32" }, () => {
  useTempConfigHome();
  writeConfig(VALID);
  fs.chmodSync(configPath(), 0o644);
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /group\/other/);
  assert.deepEqual(result, VALID);
});

test("readConfig ignores malformed JSON (warns, returns null)", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{not json", { mode: 0o600 });
  let result: Config | null = VALID;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.equal(result, null);
  assert.match(err, /not valid JSON/);
});

test("readConfig rejects a missing field", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ token: "t", username: "u" }), { mode: 0o600 });
  const err = captureStderr(() => {
    assert.equal(readConfig(), null);
  });
  assert.match(err, /malformed/);
});

test("readConfig rejects a bogus source value", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ token: "t", username: "u", source: "nope" }),
    { mode: 0o600 },
  );
  captureStderr(() => {
    assert.equal(readConfig(), null);
  });
});

test("deleteConfig removes the file and tolerates a second call (ENOENT)", () => {
  useTempConfigHome();
  writeConfig(VALID);
  assert.equal(fs.existsSync(configPath()), true);
  deleteConfig();
  assert.equal(fs.existsSync(configPath()), false);
  assert.doesNotThrow(() => deleteConfig());
});
