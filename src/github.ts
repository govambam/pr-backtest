// Octokit REST wrappers: fetch a PR and its commits, look up a commit's parent,
// detect an existing backtest PR, and open the new PR.
//
// All GitHub network egress for the tool flows through these functions (and the
// Octokit instance they wrap). No direct fetch/https — only api.github.com via
// Octokit, per SPEC §5.5. This module never posts a comment or review back to
// the original PR (VAL-GH-004).

import { Octokit } from "@octokit/rest";
import type { PrCommit } from "./resolveCommit.js";
import { isVerbose, verboseLine } from "./log.js";

/** The PR fields the rest of the tool consumes. */
export interface PullRequest {
  number: number;
  title: string;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: string;
  /** The PR author's login (empty string if GitHub returns no user). */
  user: string;
}

/**
 * The only host the tool ever talks to. The hook below asserts every resolved
 * request host equals this; any other host is a hard error (INV-HOST). The tool
 * issues no uploads/codeload requests, so `api.github.com` is the only
 * legitimate host.
 */
const GITHUB_API_HOST = "api.github.com";

/**
 * Format a single traced request as the spec §4.2 dim line, e.g.
 * `→ GET   /repos/acme/api/pulls/123    200  142ms`. Only method, path+query,
 * status and elapsed ms are recorded — never the request body. `redact()` (in
 * log.ts) is the final scrub when this is written.
 */
function formatRequestLine(
  method: string,
  pathAndQuery: string,
  status: number,
  elapsedMs: number,
): string {
  const m = method.toUpperCase().padEnd(5);
  return `→ ${m} ${pathAndQuery}  ${status}  ${Math.round(elapsedMs)}ms`;
}

/**
 * Build the single Octokit instance used for all API calls.
 *
 * This is the SOLE Octokit factory for the tool: it installs a `request` hook
 * exactly once so every API request is traced automatically, with no
 * per-call-site annotation and no call silently omitted (VAL-API-001). The hook
 * times each request, asserts its host (INV-HOST / VAL-API-004), and — only when
 * verbose is active, read dynamically via {@link isVerbose} — prints one dim
 * line per request via {@link verboseLine} (VAL-API-003). Default mode still runs
 * and times the hook but prints nothing.
 *
 * The hook records HTTP method, URL path + query, response status, and elapsed
 * ms — NEVER the request body (which can carry large diffs) and never the token;
 * `redact()` remains the final net.
 */
export function makeOctokit(token: string): Octokit {
  const octokit = new Octokit({ auth: token, userAgent: "pr-backtest" });

  octokit.hook.wrap("request", async (request, options) => {
    // Resolve the templated endpoint (e.g. `/repos/{owner}/{repo}/...`) into the
    // final absolute URL so we can read the real path + query and check the
    // host. `parse` substitutes path params and appends the query string.
    const resolved = octokit.request.endpoint.parse(options);
    const url = new URL(resolved.url);

    // INV-HOST: any host other than api.github.com is a hard error, not a silent
    // skip. This is runtime enforcement of SPEC §5.5.
    if (url.host !== GITHUB_API_HOST) {
      throw new Error(
        `pr-backtest refuses to call ${url.host}: only ${GITHUB_API_HOST} is allowed.`,
      );
    }

    const method = resolved.method ?? options.method;
    const pathAndQuery = url.pathname + url.search;
    const start = Date.now();
    try {
      const response = await request(options);
      if (isVerbose()) {
        verboseLine(
          formatRequestLine(method, pathAndQuery, response.status, Date.now() - start),
        );
      }
      return response;
    } catch (err: unknown) {
      // Still trace the failed request (status if the error carries one), then
      // rethrow unchanged so callers' error handling is unaffected.
      if (isVerbose()) {
        const status =
          typeof err === "object" && err !== null && "status" in err
            ? Number((err as { status: unknown }).status) || 0
            : 0;
        verboseLine(
          formatRequestLine(method, pathAndQuery, status, Date.now() - start),
        );
      }
      throw err;
    }
  });

  return octokit;
}

/**
 * Fetch a pull request via `pulls.get`. A 404 is rewrapped into a clear
 * "not found" Error (still thrown — index.ts maps it to exit 2).
 */
export async function getPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  try {
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    return {
      number: data.number,
      title: data.title,
      htmlUrl: data.html_url,
      headRef: data.head.ref,
      baseRef: data.base.ref,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      state: data.state,
      user: data.user?.login ?? "",
    };
  } catch (err: unknown) {
    if (isStatus(err, 404)) {
      throw new Error(
        `Pull request ${owner}/${repo}#${number} was not found ` +
          "(it may be private, deleted, or the URL may be wrong).",
      );
    }
    throw err;
  }
}

/**
 * List a PR's commits in API order via `pulls.listCommits`, paginated so PRs
 * with more than one page of commits are fully covered. Shaped as `PrCommit[]`
 * for `resolveCommit`.
 */
export async function listPullRequestCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PrCommit[]> {
  const commits = await octokit.paginate(octokit.pulls.listCommits, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return commits.map((commit) => ({
    sha: commit.sha,
    parents: commit.parents.map((parent) => ({ sha: parent.sha })),
  }));
}

/**
 * Look up a commit's first-parent SHA via `repos.getCommit`. Used as the
 * `getParentSha` callback for `resolveCommit` when a listed commit carries no
 * parent of its own. Returns the empty string for a root commit (no parents).
 */
export async function getCommitParentSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  const { data } = await octokit.repos.getCommit({ owner, repo, ref: sha });
  return data.parents[0]?.sha ?? "";
}

/**
 * Pre-flight: detect an existing backtest PR for the planned head/base pair via
 * `pulls.list`. Returns the existing PR's `html_url`, or `null`.
 *
 * Defaults to open PRs for the pre-flight check. Pass `state: "all"` to also
 * surface a closed/merged PR — used to recover the URL when `pulls.create`
 * reports a duplicate (422).
 */
export async function findExistingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
  state: "open" | "all" = "open",
): Promise<string | null> {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${headBranch}`,
    base: baseBranch,
    state,
  });
  return data.length > 0 ? data[0]!.html_url : null;
}

/** True when `err` is an Octokit-style HTTP error with the given status. */
export function isHttpStatus(err: unknown, status: number): boolean {
  return isStatus(err, status);
}

/**
 * Open the backtest PR from `headBranch` to `baseBranch` via `pulls.create`.
 * Returns the new PR's `html_url`.
 */
export async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<string> {
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    head: headBranch,
    base: baseBranch,
    title,
    body,
  });
  return data.html_url;
}

/**
 * Create a PRIVATE repository for a backtest sandbox and return its
 * `{ owner, repo }`. INV-PRIVATE: the repo is ALWAYS created private — never
 * more visible than private.
 *
 * Owner routing (personal vs org): we resolve the authenticated login once via
 * `users.getAuthenticated` and compare it to the requested `owner`. If they
 * match (case-insensitively — GitHub logins are case-insensitive), the owner is
 * the user's personal account and we call `repos.createForAuthenticatedUser`
 * (which has no `owner` parameter — it always creates under the caller). Any
 * other owner is treated as an org and routed to `repos.createInOrg`. We chose
 * the explicit "compare to authenticated login" approach over "try org, fall
 * back" because it is deterministic, makes exactly one extra read call, and is
 * trivially unit-testable with a fake octokit recording the call it makes.
 *
 * Initialization: `auto_init: true` so the repo gets a default branch with a
 * minimal commit. A backtest run pushes a base branch and opens a PR against
 * it; an empty repo has no default branch, so `auto_init` is the safe default
 * that makes VAL-CREATE-003 hold without extra plumbing.
 *
 * Failure handling (VAL-CREATE-002): a 403 / insufficient-permission from the
 * create call (common when `owner` is an org the caller cannot create repos in)
 * is re-thrown by the caller as a `DestinationApiError`. This wrapper surfaces
 * the underlying error unchanged so the caller can recognise the status and
 * compose a message naming the owner + the missing permission; it NEVER falls
 * back to any other repo.
 *
 * Takes an Octokit instance, never a raw token (INV-TOKEN): the token reaches
 * GitHub only through the injected Octokit, and is never placed in a URL, a git
 * argument, or a log line on this path.
 */
export async function createPrivateRepo(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<{ owner: string; repo: string }> {
  const { data: authed } = await octokit.users.getAuthenticated();
  const isPersonalAccount =
    authed.login.toLowerCase() === owner.toLowerCase();

  if (isPersonalAccount) {
    // Personal account: createForAuthenticatedUser has no `owner` arg; it
    // always creates under the authenticated user (i.e. `owner`).
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name,
      private: true,
      auto_init: true,
    });
    return { owner: data.owner?.login ?? owner, repo: data.name };
  }

  // Org owner: create inside the org.
  const { data } = await octokit.repos.createInOrg({
    org: owner,
    name,
    private: true,
    auto_init: true,
  });
  return { owner: data.owner?.login ?? owner, repo: data.name };
}

/** The result of a destination pre-flight check. */
export interface RepoVerification {
  /** True when `repos.get` succeeds (the repo exists and is visible to the token). */
  exists: boolean;
  /** True only when `data.permissions.push === true` (the token can write). */
  canPush: boolean;
}

/**
 * Pre-flight verify a destination repo via `repos.get`. Reads existence and
 * `permissions.push` in one call. A 404 maps to `{ exists: false, canPush: false }`;
 * any other error is rethrown for the caller to map to exit 2.
 *
 * Takes an Octokit instance, never a raw token (INV-TOKEN): the token reaches
 * GitHub only through the injected Octokit.
 */
export async function verifyRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<RepoVerification> {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return { exists: true, canPush: data.permissions?.push === true };
  } catch (err: unknown) {
    if (isStatus(err, 404)) {
      return { exists: false, canPush: false };
    }
    throw err;
  }
}

/** Narrow an unknown thrown value to an Octokit-style HTTP error of a status. */
function isStatus(err: unknown, status: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === status
  );
}
