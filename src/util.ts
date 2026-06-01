// Small shared helpers.

/** Number of leading SHA characters used for human-readable display. */
export const SHORT_SHA_LEN = 7;

/** First {@link SHORT_SHA_LEN} chars of a SHA, for display. */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LEN);
}
