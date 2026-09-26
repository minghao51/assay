// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CLI error taxonomy for m5-4 (`assay validate`).
 *
 * Exit codes (the m5-4 contract, pinned by integration tests):
 * - `0` — the dataset is valid (every planned rule reported 0 violations);
 * - `1` — violations were found (the report on stdout IS the result);
 * - `2` — usage, contract, path, or execution error (nothing was validated,
 *   or the plan could not run). Readable stderr only.
 *
 * Privacy (ADR 0025): `CliError` messages are authored, fixed text — they may
 * name user-supplied FILE PATHS (the caller typed them; echoing the path is
 * what makes a path error readable) and contract-authored structure (the m5-0
 * parser's own messages), but they never embed dataset values or raw engine
 * error text. Unexpected internal errors are reported without their message
 * for the same reason — an exception's text is untrusted content.
 */

/** The CLI exit codes (see the module doc). */
export type CliExitCode = 0 | 1 | 2

/**
 * An error with a deliberate exit code and an authored, value-free message.
 * Only this class reaches stderr verbatim; anything else is sanitized.
 */
export class CliError extends Error {
  readonly exitCode: CliExitCode

  constructor(exitCode: CliExitCode, message: string) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/** A usage/contract/path/execution failure — always exit code 2. */
export function usageError(message: string): CliError {
  return new CliError(2, message)
}
