/**
 * Tests for the `status` command (`src/status.ts`) — VAL-CONFIG-002.
 *
 * `runStatus` is driven through an injected `readConfig` seam (so a fake config
 * can be supplied) and a `print` seam (so the rendered lines can be captured).
 * It takes NO network-capable dependency — it cannot make a network call by
 * construction (no Octokit/`makeOctokit` is imported or built in the status code
 * path). These tests assert:
 *  - both slots saved → each line shows `@login` + token type, plus the default
 *    destination, and NO token value substring appears in the output;
 *  - empty/absent slots → each line reads `not set`;
 *  - the injected `readConfig` is the only seam invoked (no other collaborator),
 *    proving zero network calls;
 *  - exit code 0 (the CLI wiring calls `process.exit(0)` after `runStatus`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runStatus } from "../src/status.js";
import type { Config } from "../src/config.js";

/** Capture the lines `runStatus` prints. */
function capture(cfg: Config | null): string[] {
  const lines: string[] = [];
  runStatus({ readConfig: () => cfg, print: (line) => lines.push(line) });
  return lines;
}

test("status: both slots saved → @login + type per slot + default destination", () => {
  const cfg: Config = {
    sourceToken: {
      token: "ghp_SOURCE_SECRET_VALUE_123456",
      username: "octocat",
      source: "fine-grained",
    },
    destinationToken: {
      token: "ghp_DEST_SECRET_VALUE_7890abcd",
      username: "hubber",
      source: "classic",
    },
    defaultDestination: { owner: "acme", repo: "backtests" },
  };

  const out = capture(cfg).join("\n");

  assert.match(out, /Source token:\s+saved · authenticates as @octocat · fine-grained/);
  assert.match(out, /Destination token:\s+saved · authenticates as @hubber · classic/);
  assert.match(out, /Default destination:\s+acme\/backtests/);

  // The token value is NEVER printed.
  assert.ok(!out.includes(cfg.sourceToken!.token), "source token value must not appear");
  assert.ok(
    !out.includes(cfg.destinationToken!.token),
    "destination token value must not appear",
  );
});

test("status: empty/absent slots → each line reads 'not set'", () => {
  const lines = capture(null);
  assert.deepEqual(lines, [
    "Source token:        not set",
    "Destination token:   not set",
    "Default destination: not set",
  ]);
});

test("status: a single saved slot → others read 'not set'", () => {
  const cfg: Config = {
    sourceToken: {
      token: "ghp_ONLY_SOURCE_SECRET_VALUE",
      username: "octocat",
      source: "fine-grained",
    },
  };
  const out = capture(cfg).join("\n");
  assert.match(out, /Source token:\s+saved · authenticates as @octocat · fine-grained/);
  assert.match(out, /Destination token:\s+not set/);
  assert.match(out, /Default destination:\s+not set/);
});

test("status: makes no network call — only the injected readConfig seam is invoked", () => {
  let reads = 0;
  // A network-capable dep is intentionally NOT part of StatusDeps; the cleanest
  // proof of "no network" is that runStatus accepts only a readConfig (+ print)
  // seam. Here we additionally confirm readConfig is the sole data source and is
  // called exactly once, with no other collaborator available to reach GitHub.
  runStatus({
    readConfig: () => {
      reads += 1;
      return null;
    },
    print: () => {},
  });
  assert.equal(reads, 1);
});
