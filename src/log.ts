/**
 * Tiny stderr logger.
 *
 * All progress/info/success/warn/error output goes to stderr so that stdout
 * stays reserved for the final PR URL (pipe-friendly).
 *
 * Callers {@link registerSecret} the GitHub token as soon as it is resolved.
 * Every line written here — and via {@link redact} for stdout — has the
 * registered raw token replaced with `***` before it leaves the process, so a
 * stray git/API error string can never leak the token even if an upstream path
 * forgets to sanitize it.
 *
 * On top of the basic level helpers, this module also hosts the live activity
 * trace surface ({@link setVerbose}/{@link isVerbose}, {@link traceOp},
 * {@link verboseLine}, {@link setTtyOverride}): a verbose/TTY-aware renderer that
 * shows operations starting and completing in real time. It reuses the same
 * stderr channel and `redact()` net — it is not a second logging stack.
 */
import chalk from "chalk";

/** Registered secret strings, scrubbed from all output. */
const secrets = new Set<string>();

/**
 * Register a secret to be scrubbed from every subsequent log line (and any
 * string passed through {@link redact}). Short/empty values are ignored so we
 * never blanket-replace trivial substrings.
 */
export function registerSecret(secret: string): void {
  if (secret && secret.length >= 8) {
    secrets.add(secret);
  }
}

/** Replace every registered secret in `text` with `***`. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.replaceAll(secret, "***");
    }
  }
  return out;
}

function write(line: string): void {
  process.stderr.write(redact(line) + "\n");
}

// Live activity trace (verbose / TTY-aware). Two module-level switches control
// it: a verbose flag and a TTY accessor that defaults to `process.stderr.isTTY`
// but can be overridden for tests. It reuses the same `redact()` net and stderr
// channel as the level helpers above.

/** Whether `--verbose` is active. Off by default. */
let verbose = false;

/**
 * Optional TTY override for tests. `null` means "ask `process.stderr.isTTY`";
 * `true`/`false` force the answer so renderer behavior is testable off a real
 * terminal.
 */
let ttyOverride: boolean | null = null;

/** Enable or disable verbose tracing (the `--verbose` flag wires this). */
export function setVerbose(on: boolean): void {
  verbose = on;
}

/** Whether verbose tracing is currently enabled. */
export function isVerbose(): boolean {
  return verbose;
}

/**
 * Force the renderer's view of whether stderr is a TTY, overriding
 * `process.stderr.isTTY`. Pass `null` to restore auto-detection. Intended for
 * tests that assert the in-place-rewrite (`\r`) behavior without a real
 * terminal.
 */
export function setTtyOverride(value: boolean | null): void {
  ttyOverride = value;
}

/** Whether the trace renderer should treat stderr as a TTY. */
function isStderrTty(): boolean {
  if (ttyOverride !== null) {
    return ttyOverride;
  }
  return Boolean(process.stderr.isTTY);
}

/**
 * Format an elapsed millisecond count as a `<N>ms` figure (e.g. `142ms`). The
 * api-hook (`github.ts`) and git-trace (`git.ts`) layers import this so the
 * `<N>ms` representation (rounded to whole milliseconds) is defined in one place.
 */
export function formatElapsed(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/**
 * A live trace handle for a single operation, returned by {@link traceOp}.
 *
 * On a TTY the start line is printed immediately and later overwritten in place
 * (single carriage return) by the completion line. On a non-TTY nothing prints
 * until completion, and then only the completion line prints. Either way the
 * completion line carries an elapsed `<N>ms` figure and passes through
 * `redact()` on its way to stderr.
 */
export interface TraceHandle {
  /**
   * Mark the operation complete. Renders a green `✓ <label>` line with elapsed
   * timing, overwriting the in-progress line on a TTY. An optional `detail`
   * (already redaction-safe by construction) is appended dim.
   */
  done(detail?: string): void;
  /**
   * Mark the operation failed. Renders a red `✗ <label>` line with elapsed
   * timing, overwriting the in-progress line on a TTY. Raw child output (e.g.
   * git stderr) must NOT be passed here; `detail` is a tool-constructed note only.
   */
  fail(detail?: string): void;
}

/**
 * Begin tracing an operation. On a TTY this immediately prints a transient
 * in-progress line (`⋯ <label>`) with no trailing newline, so the matching
 * `.done()`/`.fail()` can overwrite it in place via a leading `\r`. On a
 * non-TTY nothing prints until completion.
 *
 * `label` is the friendly, redacted operation description (e.g.
 * `Cloned octocat/repo`). Timing uses the tool's own clock.
 */
export function traceOp(label: string): TraceHandle {
  const start = Date.now();
  const tty = isStderrTty();
  if (tty) {
    // In-progress line, no newline — the completion line rewrites it via `\r`.
    process.stderr.write(redact(chalk.dim("⋯ ") + label));
  }

  function finish(marker: string, detail?: string): void {
    const elapsed = chalk.dim(` ${formatElapsed(Date.now() - start)}`);
    const tail = detail ? chalk.dim(`  ${detail}`) : "";
    const body = marker + label + elapsed + tail;
    if (tty) {
      // `\r` returns to column 0; the trailing space-padding-free rewrite is
      // acceptable because the completion line is always >= the start line's
      // visible width for these labels, but to be safe we clear to EOL.
      process.stderr.write("\r\x1b[K" + redact(body) + "\n");
    } else {
      // Non-TTY: only the completion line, no carriage returns.
      write(body);
    }
  }

  return {
    done(detail?: string): void {
      finish(chalk.green("✓ "), detail);
    },
    fail(detail?: string): void {
      finish(chalk.red("✗ "), detail);
    },
  };
}

/**
 * Print a verbose-only DIM detail line (one per GitHub API request / git
 * command, constructed by the api-hook and git-trace layers). Does nothing when
 * verbose is off. The caller passes a fully-constructed string; it still passes
 * through `redact()` to stderr as the final scrub.
 */
export function verboseLine(text: string): void {
  if (!verbose) {
    return;
  }
  write(chalk.dim(text));
}

/** Neutral informational message. */
export function info(message: string): void {
  write(message);
}

/** A numbered or arrow-prefixed progress step. */
export function step(message: string): void {
  write(chalk.cyan("→ ") + message);
}

/** A successful outcome. */
export function success(message: string): void {
  write(chalk.green("✓ ") + message);
}

/** A non-fatal warning. */
export function warn(message: string): void {
  write(chalk.yellow("! ") + message);
}

/** A failure message. */
export function error(message: string): void {
  write(chalk.red("✗ ") + message);
}
