import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configPath,
  deleteConfig,
  destKey,
  mergeConfig,
  readConfig,
  sandboxKey,
  sourceKey,
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
  sandboxes: { "acme/api": { owner: "acme", repo: "backtests" } },
  destinationTokens: { "acme/backtests": DEST_SLOT },
  sourceTokens: { acme: SOURCE_SLOT },
};

/** Point config at a fresh temp dir via XDG_CONFIG_HOME and return it. */
function useTempConfigHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prbt-cfg-"));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

/** Write a raw JSON object to the config file (for old-shape / malformed fixtures). */
function writeRaw(value: unknown): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
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

// Key helpers (N1): all keys are lowercased.
test("key helpers lowercase their inputs (N1)", () => {
  assert.equal(sandboxKey("Foo", "Bar"), "foo/bar");
  assert.equal(destKey("Foo", "Bar"), "foo/bar");
  assert.equal(sourceKey("Foo"), "foo");
});

// VAL-MEM-CONFIG-001: all three maps round-trip through a 0600 file.
test("writeConfig round-trips all three maps through readConfig", () => {
  useTempConfigHome();
  writeConfig(VALID);
  assert.deepEqual(readConfig(), VALID);
});

// VAL-MEM-CONFIG-001: each map round-trips independently.
test("writeConfig round-trips a sandboxes-only file", () => {
  useTempConfigHome();
  const cfg: Config = {
    sandboxes: { "acme/api": { owner: "globex", repo: "sandbox" } },
  };
  writeConfig(cfg);
  assert.deepEqual(readConfig(), cfg);
});

test("writeConfig round-trips a sourceTokens-only file", () => {
  useTempConfigHome();
  const cfg: Config = { sourceTokens: { acme: SOURCE_SLOT } };
  writeConfig(cfg);
  assert.deepEqual(readConfig(), cfg);
});

// VAL-MEM-CONFIG-001: the round-tripped file is mode 0600.
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

// VAL-MEM-CONFIG-001 (N1): write `Foo/Bar`, read `foo/bar` → hit, single entry.
test("keys normalize to lowercase: write Foo/Bar, read foo/bar hits the same entry", () => {
  useTempConfigHome();
  // Write through the keyed-map API using a mixed-case repo via the key helper.
  mergeConfig({
    destinationTokens: { [destKey("Foo", "Bar")]: DEST_SLOT },
    sourceTokens: { [sourceKey("Foo")]: SOURCE_SLOT },
    sandboxes: { [sandboxKey("Foo", "Bar")]: { owner: "globex", repo: "sb" } },
  });
  const cfg = readConfig();
  // A lookup with a DIFFERENT casing finds the SAME single entry.
  assert.deepEqual(cfg?.destinationTokens?.[destKey("foo", "bar")], DEST_SLOT);
  assert.deepEqual(cfg?.sourceTokens?.[sourceKey("FOO")], SOURCE_SLOT);
  assert.deepEqual(cfg?.sandboxes?.[sandboxKey("FOO", "BAR")], {
    owner: "globex",
    repo: "sb",
  });
  // No duplicate keys: exactly one entry per map.
  assert.equal(Object.keys(cfg!.destinationTokens!).length, 1);
  assert.equal(Object.keys(cfg!.sourceTokens!).length, 1);
  assert.equal(Object.keys(cfg!.sandboxes!).length, 1);
  assert.deepEqual(Object.keys(cfg!.destinationTokens!), ["foo/bar"]);
});

// readConfig also lowercases keys present on disk in mixed case.
test("readConfig lowercases mixed-case keys read from disk (N1)", () => {
  useTempConfigHome();
  writeRaw({ destinationTokens: { "Foo/Bar": DEST_SLOT } });
  const cfg = readConfig();
  assert.deepEqual(Object.keys(cfg!.destinationTokens!), ["foo/bar"]);
  assert.deepEqual(cfg?.destinationTokens?.["foo/bar"], DEST_SLOT);
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
  writeRaw("just a string");
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
  writeRaw({ unrelated: "value" });
  assert.equal(readConfig(), null);
});

// VAL-MEM-CONFIG-001: a malformed ENTRY in one map is dropped + warned, while
// valid siblings in the same map AND the other maps survive.
test("readConfig drops a malformed map entry but keeps valid siblings + other maps", () => {
  useTempConfigHome();
  writeRaw({
    destinationTokens: {
      "acme/good": DEST_SLOT,
      "acme/bad": { token: "t", username: "u" }, // missing source → malformed
    },
    sourceTokens: { acme: SOURCE_SLOT },
  });
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /destinationTokens\["acme\/bad"\] is malformed/);
  assert.deepEqual(result?.destinationTokens, { "acme/good": DEST_SLOT });
  assert.equal(result?.destinationTokens?.["acme/bad"], undefined);
  // Sibling map untouched.
  assert.deepEqual(result?.sourceTokens, { acme: SOURCE_SLOT });
});

// A map entry with a bogus source value is malformed and dropped.
test("readConfig drops a token entry with a bogus source value", () => {
  useTempConfigHome();
  writeRaw({
    destinationTokens: {
      "acme/bad": { token: "t", username: "u", source: "nope" },
      "acme/good": DEST_SLOT,
    },
  });
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /destinationTokens\["acme\/good"\]|destinationTokens\["acme\/bad"\]/);
  assert.equal(result?.destinationTokens?.["acme/bad"], undefined);
  assert.deepEqual(result?.destinationTokens?.["acme/good"], DEST_SLOT);
});

// A map that is present but not an object is dropped with a warning; other maps survive.
test("readConfig drops a non-object map field but keeps the others", () => {
  useTempConfigHome();
  writeRaw({ sandboxes: "not an object", sourceTokens: { acme: SOURCE_SLOT } });
  let result: Config | null = null;
  const err = captureStderr(() => {
    result = readConfig();
  });
  assert.match(err, /sandboxes is malformed/);
  assert.equal(result?.sandboxes, undefined);
  assert.deepEqual(result?.sourceTokens, { acme: SOURCE_SLOT });
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

// ===========================================================================
// N5 — merge, never replace.
// ===========================================================================

// Saving destinationTokens[B] leaves destinationTokens[A] byte-identical.
test("mergeConfig adds a destination token key without clobbering a sibling key", () => {
  useTempConfigHome();
  writeConfig({ destinationTokens: { "acme/a": DEST_SLOT } });
  const newSlot: TokenSlot = { token: "b-tok", username: "bee", source: "classic" };
  mergeConfig({ destinationTokens: { "acme/b": newSlot } });
  const result = readConfig();
  assert.deepEqual(result?.destinationTokens, {
    "acme/a": DEST_SLOT,
    "acme/b": newSlot,
  });
});

// Saving a sourceTokens key leaves another sourceTokens key unchanged.
test("mergeConfig adds a source token key without clobbering a sibling key", () => {
  useTempConfigHome();
  writeConfig({ sourceTokens: { owner1: SOURCE_SLOT } });
  const newSlot: TokenSlot = { token: "o2", username: "two", source: "classic" };
  mergeConfig({ sourceTokens: { owner2: newSlot } });
  const result = readConfig();
  assert.deepEqual(result?.sourceTokens, {
    owner1: SOURCE_SLOT,
    owner2: newSlot,
  });
});

// A write to one map preserves the OTHER maps and their values.
test("mergeConfig writing one map preserves the other maps (N5)", () => {
  useTempConfigHome();
  writeConfig({
    sourceTokens: { acme: SOURCE_SLOT },
    sandboxes: { "acme/api": { owner: "g", repo: "sb" } },
  });
  mergeConfig({ destinationTokens: { "acme/backtests": DEST_SLOT } });
  const result = readConfig();
  assert.deepEqual(result, {
    sourceTokens: { acme: SOURCE_SLOT },
    sandboxes: { "acme/api": { owner: "g", repo: "sb" } },
    destinationTokens: { "acme/backtests": DEST_SLOT },
  });
});

// mergeConfig re-asserts mode 0600.
test("mergeConfig keeps mode 0600 after a key save", { skip: process.platform === "win32" }, () => {
  useTempConfigHome();
  mergeConfig({ sourceTokens: { acme: SOURCE_SLOT } });
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
});

// ===========================================================================
// VAL-MEM-CONFIG-002 — old/partial-shape config loads without error (N6).
// ===========================================================================

// (a) salvage: destinationToken + defaultDestination → destinationTokens[defaultDestination].
test("N6 (a): old destinationToken + defaultDestination salvages into destinationTokens[key]", () => {
  useTempConfigHome();
  writeRaw({
    destinationToken: DEST_SLOT,
    defaultDestination: { owner: "Acme", repo: "Backtests" },
  });
  let result: Config | null = null;
  assert.doesNotThrow(() => {
    result = readConfig();
  });
  // Salvaged under the LOWERCASED defaultDestination key (N1).
  assert.deepEqual(result?.destinationTokens, { "acme/backtests": DEST_SLOT });
});

// (b) drop: destinationToken with NO defaultDestination → token absent (not mis-keyed).
test("N6 (b): old destinationToken with no defaultDestination is dropped (not mis-keyed)", () => {
  useTempConfigHome();
  writeRaw({ destinationToken: DEST_SLOT });
  let result: Config | null = "x" as unknown as Config;
  assert.doesNotThrow(() => {
    result = readConfig();
  });
  // No defaultDestination → no salvage key → nothing recognized → null config.
  assert.equal(result, null);
});

// (c) drop: a bare sourceToken (no recorded owner) → absent.
test("N6 (c): a bare old sourceToken is dropped (no owner to key it under)", () => {
  useTempConfigHome();
  writeRaw({ sourceToken: SOURCE_SLOT });
  let result: Config | null = "x" as unknown as Config;
  assert.doesNotThrow(() => {
    result = readConfig();
  });
  assert.equal(result, null);
});

// (d) drop: a bare defaultDestination → no phantom token, no config at all.
test("N6 (d): a bare defaultDestination yields no phantom token", () => {
  useTempConfigHome();
  writeRaw({ defaultDestination: { owner: "acme", repo: "backtests" } });
  let result: Config | null = "x" as unknown as Config;
  assert.doesNotThrow(() => {
    result = readConfig();
  });
  // The deprecated single-slot default is NOT part of the new schema and salvages
  // nothing on its own — a file holding only it has zero recognized fields, so it
  // reads as no config at all (null). It produces no token map entry.
  assert.equal(result, null);
});

// (e) partial: new destinationTokens[A] + old destinationToken + defaultDestination=A
//     → the existing NEW entry is NOT overwritten.
test("N6 (e): an existing new destinationTokens[A] is not overwritten by old salvage", () => {
  useTempConfigHome();
  const newSlot: TokenSlot = { token: "new-tok", username: "new", source: "fine-grained" };
  writeRaw({
    destinationTokens: { "acme/backtests": newSlot },
    destinationToken: DEST_SLOT, // old slot would salvage to acme/backtests
    defaultDestination: { owner: "acme", repo: "backtests" },
  });
  let result: Config | null = null;
  assert.doesNotThrow(() => {
    result = readConfig();
  });
  // New wins; old never overwrites.
  assert.deepEqual(result?.destinationTokens, { "acme/backtests": newSlot });
});

// (f) reading performs NO disk write (the file is byte-identical after a read).
test("N6 (f): reading an old-shape config performs no disk write", () => {
  useTempConfigHome();
  const raw = JSON.stringify({
    destinationToken: DEST_SLOT,
    defaultDestination: { owner: "acme", repo: "backtests" },
  });
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, raw, { mode: 0o600 });
  const before = fs.readFileSync(p, "utf8");
  readConfig();
  const after = fs.readFileSync(p, "utf8");
  assert.equal(after, before, "readConfig must not rewrite the file");
});

// Migration is additive: a file with BOTH new maps and old fields loads, new maps intact.
test("N6: a partial mix keeps new maps and salvages a free old key", () => {
  useTempConfigHome();
  writeRaw({
    sourceTokens: { acme: SOURCE_SLOT },
    destinationToken: DEST_SLOT,
    defaultDestination: { owner: "globex", repo: "sandbox" },
  });
  const result = readConfig();
  assert.deepEqual(result?.sourceTokens, { acme: SOURCE_SLOT });
  assert.deepEqual(result?.destinationTokens, { "globex/sandbox": DEST_SLOT });
});
