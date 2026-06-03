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

import prompts from "prompts";

import {
  makeSandboxNamePrompt,
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
  landing?: "primary" | "saved" | "sandbox";
  landInSource?: boolean;
  /** The three-option scoped landing answer (only consulted when a saved sandbox exists). */
  scopedLanding?: "primary" | "saved" | "sandbox";
  slug?: RepoRef;
  /** The saved sandbox for this source, if any (N7). */
  saved?: RepoRef;
  /** When set, the editable-name prompt returns this instead of the default. */
  editName?: string;
}): {
  resolvers: AuthFirstResolvers;
  order: string[];
  /** The `saved` argument the inherited landing prompt was handed (null until called). */
  landingSavedArg: () => RepoRef | undefined | null;
} {
  const order: string[] = [];
  let landingSavedArg: RepoRef | undefined | null = null;
  const resolvers: AuthFirstResolvers = {
    detectInherited: async () => {
      order.push("detect");
      return opts.detected ?? null;
    },
    offerInherited: async (login) => {
      order.push(`offer:${login}`);
      return opts.useInherited ?? false;
    },
    promptLanding: async (saved) => {
      order.push("landing");
      landingSavedArg = saved;
      return opts.landing ?? "primary";
    },
    promptSandboxName: async (defaultName) => {
      order.push(`name:${defaultName}`);
      return opts.editName ?? defaultName;
    },
    promptLandInSource: async () => {
      order.push("land-in-source");
      return opts.landInSource ?? true;
    },
    promptScopedLanding: async () => {
      order.push("scoped-landing");
      return opts.scopedLanding ?? "primary";
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
    getSavedSandbox: () => opts.saved,
  };
  return { resolvers, order, landingSavedArg: () => landingSavedArg };
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
});

// --- VAL-CREATE-002 / VAL-CREATE-003: warn upfront + editable name -----------

test("VAL-CREATE-002: choosing a new sandbox warns upfront (repo + scope) BEFORE the name prompt", async () => {
  const { sandboxCreateWarning } = await import("../src/authFirst.js");
  // The exact greppable copy names the repo to be created and the scope needed.
  const warning = sandboxCreateWarning(SOURCE, `${SOURCE.repo}${SANDBOX_NAME_SUFFIX}`);
  assert.match(warning, /acme\/api-backtest/, "names <src-owner>/<src-repo>-backtest");
  assert.match(warning, /create repos in acme/, "states the repo-creation scope on <src-owner>");

  // And in the real choice flow the name prompt fires AFTER the landing choice
  // (the warning is emitted between them — its stderr emission is asserted
  // end-to-end in index.test.ts where stdout/stderr are captured).
  const { resolvers, order } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "sandbox",
  });
  await resolveAuthFirstChoice(SOURCE, resolvers);
  const landingIdx = order.indexOf("landing");
  const nameIdx = order.findIndex((o) => o.startsWith("name:"));
  assert.ok(landingIdx >= 0 && nameIdx >= 0, "landing then name prompt both fired");
  assert.ok(landingIdx < nameIdx, "the landing choice precedes the name prompt");
  // The default name handed to the prompt is <src-repo>-backtest.
  assert.ok(order.includes(`name:${SOURCE.repo}${SANDBOX_NAME_SUFFIX}`), "name prompt defaulted to <src-repo>-backtest");
});

test("VAL-CREATE-003: the default name flows through unchanged", async () => {
  const { resolvers } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "sandbox",
    // editName omitted → the prompt returns the default.
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.owner, SOURCE.owner);
  assert.equal(choice.repo, `${SOURCE.repo}${SANDBOX_NAME_SUFFIX}`);
});

test("VAL-CREATE-003: an EDITED name flows through to the resolved choice (foo)", async () => {
  const { resolvers } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "sandbox",
    editName: "foo",
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.owner, SOURCE.owner, "still under the source owner");
  assert.equal(choice.repo, "foo", "the edited name replaces the default");
  assert.equal(choice.isSandbox, true);
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
  // §3b order: land-in-source (no) → slug → READ paste → WRITE paste. The
  // guidance is emitted between land-in-source and slug, on stderr via info.
  assert.deepEqual(order, ["detect", "land-in-source", "slug", "paste:read", "paste:write"]);
  // The collected pastes are carried back in read-then-write order.
  assert.ok(choice.scopedSandboxPastes, "scoped pastes are carried back");
  assert.equal(choice.scopedSandboxPastes!.read, "ghp_scoped_read_token_value_for_tests_01");
  assert.equal(choice.scopedSandboxPastes!.write, "ghp_scoped_write_token_value_for_tests_1");
});

// --- VAL-MEM-INT-001: the saved sandbox surfaces as a landing option ---------

const SAVED_SANDBOX: RepoRef = { owner: "me", repo: "saved-sb" };

test("VAL-MEM-INT-001: inherited fork — saved present, the landing prompt is handed the saved sandbox", async () => {
  const { resolvers, landingSavedArg } = makeResolvers({
    detected: CRED,
    useInherited: true,
    saved: SAVED_SANDBOX,
    landing: "primary",
  });
  await resolveAuthFirstChoice(SOURCE, resolvers);
  // The landing prompt received the saved sandbox so it can offer it as a row.
  assert.deepEqual(landingSavedArg(), SAVED_SANDBOX);
});

test("VAL-MEM-INT-001: inherited fork — selecting the saved sandbox returns it with isSandbox true", async () => {
  const { resolvers } = makeResolvers({
    detected: CRED,
    useInherited: true,
    saved: SAVED_SANDBOX,
    landing: "saved",
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, SAVED_SANDBOX);
  assert.equal(choice.isSandbox, true);
  assert.equal(choice.inheritedCredential, CRED, "still uses the inherited credential");
});

test("VAL-MEM-INT-001: inherited fork — saved ABSENT, the landing prompt is handed undefined (byte-identical)", async () => {
  const { resolvers, landingSavedArg, order } = makeResolvers({
    detected: CRED,
    useInherited: true,
    landing: "primary",
    // no saved
  });
  await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(landingSavedArg(), undefined, "no saved sandbox passed to the prompt");
  assert.deepEqual(order, ["detect", "offer:octocat", "landing"]);
});

test("VAL-MEM-INT-001: scoped fork — saved present, the three-option prompt is used; selecting saved returns it", async () => {
  const { resolvers, order } = makeResolvers({
    detected: null,
    saved: SAVED_SANDBOX,
    scopedLanding: "saved",
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, SAVED_SANDBOX);
  assert.equal(choice.isSandbox, true);
  assert.equal(choice.inheritedCredential, null);
  assert.equal(choice.scopedSandboxPastes, null, "reusing the saved sandbox collects no eager pastes");
  // The three-option scoped landing prompt is used, NOT the two-option confirm.
  assert.ok(order.includes("scoped-landing"));
  assert.ok(!order.includes("land-in-source"));
});

test("VAL-MEM-INT-001: scoped fork — saved present, choosing 'a different repo' falls through to the guided slug+paste flow", async () => {
  const { resolvers, order } = makeResolvers({
    detected: null,
    saved: SAVED_SANDBOX,
    scopedLanding: "sandbox",
    slug: { owner: "you", repo: "other" },
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, { owner: "you", repo: "other" });
  assert.equal(choice.isSandbox, true);
  assert.ok(choice.scopedSandboxPastes, "the guided sandbox flow collects pastes");
  assert.deepEqual(order, ["detect", "scoped-landing", "slug", "paste:read", "paste:write"]);
});

test("VAL-MEM-INT-001: scoped fork — saved ABSENT, the two-option land-in-source confirm is used (byte-identical)", async () => {
  const { resolvers, order } = makeResolvers({
    detected: null,
    landInSource: true,
    // no saved
  });
  const choice = await resolveAuthFirstChoice(SOURCE, resolvers);
  assert.equal(choice.isSandbox, false);
  assert.deepEqual({ owner: choice.owner, repo: choice.repo }, SOURCE);
  assert.ok(order.includes("land-in-source"));
  assert.ok(!order.includes("scoped-landing"), "no three-option prompt when nothing is saved");
});

// --- VAL-CREATE-003: the EDITED new-sandbox name is VALIDATED, re-prompting ---
// (consistency with parseRepoSlug: an invalid name never flows downstream).

test("makeSandboxNamePrompt: a valid edited name passes straight through", async () => {
  prompts.inject(["my-sandbox"]);
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => true });
  assert.equal(await namePrompt("api-backtest"), "my-sandbox");
});

test("makeSandboxNamePrompt: an INVALID name re-prompts; the next valid name is used", async () => {
  // First entry has a forbidden char (space), second is valid → loop re-prompts.
  prompts.inject(["bad name!", "good-name"]);
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => true });
  assert.equal(await namePrompt("api-backtest"), "good-name");
});

test("makeSandboxNamePrompt: a dot-only name (..) is rejected and re-prompted", async () => {
  prompts.inject(["..", "ok-name"]);
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => true });
  assert.equal(await namePrompt("api-backtest"), "ok-name");
});

test("makeSandboxNamePrompt: a name containing a slash is rejected and re-prompted", async () => {
  prompts.inject(["owner/name", "name-only"]);
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => true });
  assert.equal(await namePrompt("api-backtest"), "name-only");
});

test("makeSandboxNamePrompt: an empty entry keeps the default unchanged", async () => {
  prompts.inject([""]);
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => true });
  assert.equal(await namePrompt("api-backtest"), "api-backtest");
});

test("makeSandboxNamePrompt: aborting (Esc) keeps the default unchanged", async () => {
  prompts.inject([undefined]);
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => true });
  assert.equal(await namePrompt("api-backtest"), "api-backtest");
});

test("makeSandboxNamePrompt: off-TTY returns the default without prompting", async () => {
  const namePrompt = makeSandboxNamePrompt({ isTTY: () => false });
  assert.equal(await namePrompt("api-backtest"), "api-backtest");
});
