/**
 * Unit tests for the interactive auth-first CHOICE (`src/authFirst.ts`).
 *
 * These exercise `resolveAuthFirstChoice` in isolation through recording seams:
 * the call ORDER of the auth offer vs the destination prompts, the §3 fork
 * routing on both the inherited (YES) and scoped (NO / not-detected) paths, and
 * the guidance-before-slug ordering on the scoped sandbox path. The full
 * orchestration (token resolution, verify/create) is covered in index.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAuthFirstChoice,
  SANDBOX_NAME_SUFFIX,
  type AuthFirstResolvers,
  type RepoRef,
} from "../src/authFirst.js";
import type { InheritedCredential } from "../src/inheritedAuth.js";
import { setVerbose, setTtyOverride } from "../src/log.js";

const SOURCE: RepoRef = { owner: "acme", repo: "api" };

const CRED: InheritedCredential = {
  token: "ghp_inherited_value_for_authfirst_tests_01",
  login: "octocat",
  source: "classic",
};

/**
 * Build recording auth-first resolvers plus an `order` log. Each seam appends a
 * stable label so a test can assert the exact prompt sequence.
 */
function makeResolvers(opts: {
  detected?: InheritedCredential | null;
  useInherited?: boolean;
  landing?: "primary" | "sandbox";
  landInSource?: boolean;
  slug?: RepoRef;
  saved?: { owner: string; repo: string };
}): { resolvers: AuthFirstResolvers; order: string[] } {
  const order: string[] = [];
  const resolvers: AuthFirstResolvers = {
    detectInherited: async () => {
      order.push("detect");
      return opts.detected ?? null;
    },
    offerInherited: async (login) => {
      order.push(`offer:${login}`);
      return opts.useInherited ?? false;
    },
    promptLanding: async () => {
      order.push("landing");
      return opts.landing ?? "primary";
    },
    promptLandInSource: async () => {
      order.push("land-in-source");
      return opts.landInSource ?? true;
    },
    promptForSlug: async () => {
      order.push("slug");
      if (!opts.slug) throw new Error("no slug fake");
      return opts.slug;
    },
    getSandboxReadPaste: async () => {
      order.push("paste:read");
      return "ghp_scoped_read_token_value_for_tests_01";
    },
    getSandboxWritePaste: async () => {
      order.push("paste:write");
      return "ghp_scoped_write_token_value_for_tests_1";
    },
    getDefaultDestination: () => opts.saved,
  };
  return { resolvers, order };
}

test.beforeEach(() => {
  setVerbose(false);
  setTtyOverride(false);
});
test.afterEach(() => {
  setVerbose(false);
  setTtyOverride(null);
});

// --- VAL-FLOW-001: auth offer precedes the destination prompt (both forks) ---

test("VAL-FLOW-001: the auth offer fires BEFORE the destination prompt on the ACCEPT path", async () => {
  const { resolvers, order } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "primary",
  });
  await resolveAuthFirstChoice(SOURCE, resolvers);
  // detect → offer → landing: the offer is strictly before the landing prompt.
  assert.deepEqual(order, ["detect", "offer:octocat", "landing"]);
  assert.ok(
    order.indexOf("offer:octocat") < order.indexOf("landing"),
    "auth offer precedes the destination prompt on the YES fork",
  );
});

test("VAL-FLOW-001: the auth offer fires BEFORE the destination prompt on the DECLINE path", async () => {
  const { resolvers, order } = makeResolvers({
    detected: CRED,
    useInherited: false, // declined → scoped fork
    landInSource: true,
  });
  await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.deepEqual(order, ["detect", "offer:octocat", "land-in-source"]);
  assert.ok(
    order.indexOf("offer:octocat") < order.indexOf("land-in-source"),
    "auth offer precedes the destination prompt on the NO fork",
  );
});

test("VAL-AUTH-001 / VAL-FLOW-001: no detection → NO offer rendered, straight into the scoped fork", async () => {
  const { resolvers, order } = makeResolvers({
    detected: null,
    landInSource: true,
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  // detect ran, but the offer was NEVER rendered; the scoped fork is entered.
  assert.deepEqual(order, ["detect", "land-in-source"]);
  assert.ok(!order.some((o) => o.startsWith("offer:")), "no offer when nothing detected");
  assert.equal(choice.inheritedCredential, null);
});

// --- VAL-FLOW-002: inherited fork routing -----------------------------------

test("VAL-FLOW-002: inherited + Original → Primary (isSandbox false, dest === source), credential carried", async () => {
  const { resolvers } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "primary",
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.isSandbox, false);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, SOURCE);
  assert.equal(choice.offerRemember, false);
  assert.equal(choice.inheritedCredential, CRED, "the inherited credential is carried forward");
});

test("VAL-FLOW-002: inherited + new sandbox → <src-owner>/<src-repo>-backtest, isSandbox true, credential carried", async () => {
  const { resolvers } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "sandbox",
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.isSandbox, true);
  assert.equal(choice.owner, SOURCE.owner, "sandbox is created under the source owner");
  assert.equal(
    choice.repo,
    `${SOURCE.repo}${SANDBOX_NAME_SUFFIX}`,
    "sandbox name is <src-repo>-backtest",
  );
  assert.equal(choice.inheritedCredential, CRED);
  assert.equal(choice.offerRemember, true, "a fresh non-default sandbox flags remember");
});

// --- VAL-FLOW-003: scoped fork routing --------------------------------------

test("VAL-FLOW-003: scoped + yes → Primary, no inherited credential, no slug prompt", async () => {
  const { resolvers, order } = makeResolvers({
    detected: null,
    landInSource: true,
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.isSandbox, false);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, SOURCE);
  assert.equal(choice.inheritedCredential, null, "scoped fork carries no inherited credential");
  assert.ok(!order.includes("slug"), "no slug prompt when landing in the source repo");
});

test("VAL-FLOW-003: scoped + no → guidance, then the slug prompt → Sandbox, no inherited credential", async () => {
  const { resolvers, order } = makeResolvers({
    detected: null,
    landInSource: false,
    slug: { owner: "you", repo: "sandbox" },
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.isSandbox, true);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, { owner: "you", repo: "sandbox" });
  assert.equal(choice.inheritedCredential, null);
  assert.equal(choice.offerRemember, true);
  // §3b order: land-in-source (no) → slug → READ paste → WRITE paste. The
  // guidance is emitted between land-in-source and slug, on stderr via info.
  assert.deepEqual(order, ["detect", "land-in-source", "slug", "paste:read", "paste:write"]);
  // The collected pastes are carried back in read-then-write order.
  assert.ok(choice.scopedSandboxPastes, "scoped pastes are carried back");
  assert.equal(choice.scopedSandboxPastes!.read, "ghp_scoped_read_token_value_for_tests_01");
  assert.equal(choice.scopedSandboxPastes!.write, "ghp_scoped_write_token_value_for_tests_1");
});

test("VAL-FLOW-003: scoped + no with slug equal to the saved default does NOT flag offerRemember", async () => {
  const { resolvers } = makeResolvers({
    detected: null,
    landInSource: false,
    slug: { owner: "Me", repo: "Sandbox" }, // mixed case, equals saved
    saved: { owner: "me", repo: "sandbox" },
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.isSandbox, true);
  assert.equal(choice.offerRemember, false, "equal-to-default → no remember offer");
});
