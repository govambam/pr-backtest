import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configPath,
  deleteConfig,
  mergeConfig,
  readConfig,
  writeConfig,
  type Config,
  type TokenSlot,
} from "../src/config.js";

const SOURCE_SLOT: TokenSlot = {
  token: "sourcetokenvalue",
  username: "octocat",
  source: "fine-grained",
};
const DEST_SLOT: TokenSlot = {
  token: "desttokenvalue",
  username: "octocat",
  source: "classic",
};
const VALID: Config = {
  sourceToken: SOURCE_SLOT,
  destinationToken: DEST_SLOT,
  defaultDestination: { owner: "acme", repo: "backtests" },
};

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

// VAL-CONFIG-001: both slots round-trip through a 0600 file.
test("writeConfig round-trips both slots through readConfig", () => {
  useTempConfigHome();
  writeConfig(VALID);
  assert.deepEqual(readConfig(), VALID);
});

// VAL-CONFIG-001: the round-tripped file is mode 0600.
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

// A single-PAT run fills both slots with the same value.
test("writeConfig round-trips when both slots share a token value", () => {
  useTempConfigHome();
  const shared: TokenSlot = {
    token: "sharedtoken",
    username: "octocat",
    source: "classic",
  };
  const cfg: Config = { sourceToken: shared, destinationToken: shared };
  writeConfig(cfg);
  assert.deepEqual(readConfig(), cfg);
});

// VAL-CONFIG-005: the loosened-permissions warning fires but the file still loads.
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

test("readConfig ignores a non-object file (warns, returns null)", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify("just a string"), { mode: 0o600 });
  let result: Config | null = VALID;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.equal(result, null);
  assert.match(err, /malformed/);
});

// A file with zero recognized fields reads back as null (no config).
test("readConfig returns null for a file with no recognized fields", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ unrelated: "value" }), { mode: 0o600 });
  assert.equal(readConfig(), null);
});

// VAL-CONFIG-004: a malformed slot is warned + dropped while a valid sibling
// slot in the same file is still used.
test("readConfig drops a malformed slot but keeps a valid sibling slot", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      // sourceToken missing `source` → malformed
      sourceToken: { token: "s", username: "u" },
      destinationToken: DEST_SLOT,
    }),
    { mode: 0o600 },
  );
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /sourceToken is malformed/);
  assert.equal(result?.sourceToken, undefined);
  assert.deepEqual(result?.destinationToken, DEST_SLOT);
});

// VAL-CONFIG-004: a slot with a bogus source value is malformed.
test("readConfig drops a slot with a bogus source value", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      destinationToken: { token: "t", username: "u", source: "nope" },
      defaultDestination: { owner: "acme", repo: "backtests" },
    }),
    { mode: 0o600 },
  );
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /destinationToken is malformed/);
  assert.equal(result?.destinationToken, undefined);
  assert.deepEqual(result?.defaultDestination, { owner: "acme", repo: "backtests" });
});

// A malformed defaultDestination is warned + dropped, valid slots survive.
test("readConfig drops a malformed defaultDestination but keeps a valid slot", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      sourceToken: SOURCE_SLOT,
      defaultDestination: { owner: "acme" }, // missing repo → malformed
    }),
    { mode: 0o600 },
  );
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /defaultDestination is malformed/);
  assert.equal(result?.defaultDestination, undefined);
  assert.deepEqual(result?.sourceToken, SOURCE_SLOT);
});

// A slot-only file (no destination) reads back exposing just that slot.
test("readConfig tolerates a source-token-only file", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ sourceToken: SOURCE_SLOT }), {
    mode: 0o600,
  });
  const result = readConfig();
  assert.notEqual(result, null);
  assert.deepEqual(result?.sourceToken, SOURCE_SLOT);
  assert.equal(result?.destinationToken, undefined);
  assert.equal(result?.defaultDestination, undefined);
});

// A destination-only file (no token slots) reads back exposing the destination.
test("readConfig tolerates a destination-only file (no token slots)", () => {
  useTempConfigHome();
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ defaultDestination: { owner: "acme", repo: "backtests" } }),
    { mode: 0o600 },
  );
  const result = readConfig();
  assert.notEqual(result, null);
  assert.equal(result?.sourceToken, undefined);
  assert.equal(result?.destinationToken, undefined);
  assert.deepEqual(result?.defaultDestination, { owner: "acme", repo: "backtests" });
});

// VAL-CONFIG-003: logout (deleteConfig) removes the whole file and tolerates
// an absent file.
test("deleteConfig removes the whole file and tolerates a second call (ENOENT)", () => {
  useTempConfigHome();
  writeConfig(VALID);
  assert.equal(fs.existsSync(configPath()), true);
  deleteConfig();
  assert.equal(fs.existsSync(configPath()), false);
  assert.equal(readConfig(), null);
  assert.doesNotThrow(() => deleteConfig());
});

// mergeConfig: saving the destinationToken preserves a saved sourceToken and
// defaultDestination (merge, not overwrite).
test("mergeConfig saving destinationToken preserves sourceToken and defaultDestination", () => {
  useTempConfigHome();
  writeConfig({
    sourceToken: SOURCE_SLOT,
    defaultDestination: { owner: "acme", repo: "backtests" },
  });
  mergeConfig({ destinationToken: DEST_SLOT });
  const result = readConfig();
  assert.deepEqual(result, {
    sourceToken: SOURCE_SLOT,
    destinationToken: DEST_SLOT,
    defaultDestination: { owner: "acme", repo: "backtests" },
  });
});

// mergeConfig: saving a defaultDestination preserves saved token slots.
test("mergeConfig saving a destination preserves saved token slots", () => {
  useTempConfigHome();
  writeConfig({ sourceToken: SOURCE_SLOT, destinationToken: DEST_SLOT });
  mergeConfig({ defaultDestination: { owner: "globex", repo: "sandbox" } });
  const result = readConfig();
  assert.deepEqual(result, {
    sourceToken: SOURCE_SLOT,
    destinationToken: DEST_SLOT,
    defaultDestination: { owner: "globex", repo: "sandbox" },
  });
});

// VAL-CONFIG-004 / mergeConfig re-asserts mode 0600.
test("mergeConfig keeps mode 0600 after a slot save", { skip: process.platform === "win32" }, () => {
  useTempConfigHome();
  mergeConfig({ sourceToken: SOURCE_SLOT });
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
});
