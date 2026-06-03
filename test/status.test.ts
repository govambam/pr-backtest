/**
 * Tests for the `status` command (`src/status.ts`) — VAL-MEM-005.
 *
 * `runStatus` is driven through an injected `readConfig` seam (so a fake config
 * can be supplied) and a `print` seam (so the rendered lines can be captured).
 * It takes NO network-capable dependency — it cannot make a network call by
 * construction (no Octokit/`makeOctokit` is imported or built in the status code
 * path). These tests assert:
 *  - a populated config → each saved per-source sandbox, plus a per-owner /
 *    per-repo token summary (login + type), and NO token value substring appears;
 *  - empty/absent maps → a clear "none saved" state per section;
 *  - the injected `readConfig` is the only seam invoked (no other collaborator),
 *    proving zero network calls.
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

test("VAL-MEM-005: populated → sandboxes + per-owner/per-repo token summary, no token value", () => {
  const sourceTok = "ghp_SOURCE_SECRET_VALUE_123456";
  const destTok = "ghp_DEST_SECRET_VALUE_7890abcd";
  const cfg: Config = {
    sandboxes: {
      "acme/api": { owner: "me", repo: "api-backtest" },
      "globex/web": { owner: "me", repo: "web-sb" },
    },
    sourceTokens: {
      "octo-org": {
        token: sourceTok,
        username: "octocat",
        source: "fine-grained",
      },
    },
    destinationTokens: {
      "acme/backtests": {
        token: destTok,
        username: "hubber",
        source: "classic",
      },
    },
  };

  const out = capture(cfg).join("\n");

  // Each saved per-source sandbox is listed as <src> → <sandbox>.
  assert.match(out, /acme\/api → me\/api-backtest/);
  assert.match(out, /globex\/web → me\/web-sb/);
  // The token summary names the OWNER / REPO key plus the login + type.
  assert.match(out, /octo-org → @octocat · fine-grained/);
  assert.match(out, /acme\/backtests → @hubber · classic/);

  // The token value is NEVER printed.
  assert.ok(!out.includes(sourceTok), "source token value must not appear");
  assert.ok(!out.includes(destTok), "destination token value must not appear");
});

test("VAL-MEM-005: empty/absent maps → a clear 'none saved' state per section", () => {
  const lines = capture(null);
  const out = lines.join("\n");
  // Each section renders its header and a "none saved" line.
  assert.match(out, /Saved sandboxes:/);
  assert.match(out, /Source tokens:/);
  assert.match(out, /Destination tokens:/);
  // "none saved" appears once per empty section (all three here).
  const noneCount = lines.filter((l) => l.includes("none saved")).length;
  assert.equal(noneCount, 3, "all three sections report 'none saved'");
});

test("VAL-MEM-005: a partially-populated config → only the empty maps say 'none saved'", () => {
  const cfg: Config = {
    sandboxes: { "acme/api": { owner: "me", repo: "api-backtest" } },
  };
  const out = capture(cfg).join("\n");
  assert.match(out, /acme\/api → me\/api-backtest/);
  // The two token sections are empty.
  assert.match(out, /Source tokens:\n {2}none saved/);
  assert.match(out, /Destination tokens:\n {2}none saved/);
});

test("VAL-MEM-005: makes no network call — only the injected readConfig seam is invoked", () => {
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
