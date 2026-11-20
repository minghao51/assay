// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single engine error-text projection (D04a seam extraction): an op
 * failure is posted as its own value-free message, never as engine text that
 * could embed data (ADR 0025 — the classes and messages are composed by the
 * callers; this helper only projects whatever was thrown).
 *
 * One canonical owner: `engine-executor.ts` (the dispatch catch) and
 * `csv-dispatch.ts` (the acceptance-time refusals) both use this function, so
 * a thrown non-`Error` value projects identically on every path.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
