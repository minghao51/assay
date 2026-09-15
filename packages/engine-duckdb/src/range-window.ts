/**
 * Row-window validation and clamping for `fetchRange` (task M1-4).
 *
 * The engine serves *visible-window sized* Arrow slices, never the whole
 * dataset (docs/architecture/02-architecture.md §8: the grid requests only
 * visible or nearby ranges). To keep that guarantee structural, every window
 * is validated and clamped against `MAX_RANGE_ROWS` on both sides of the
 * worker boundary: the client clamps before sending (fast, honest errors) and
 * the worker clamps again authoritatively (the boundary is untrusted). The
 * same pure function runs in both places so the semantics cannot drift.
 */

/**
 * Hard cap on rows per `fetchRange` call — sized for a grid viewport plus
 * overshoot, not for bulk reads. Bulk analytics must go through `query()`,
 * which streams batches (M1-2) rather than materializing windows.
 */
export const MAX_RANGE_ROWS = 1000

/** A validated half-open row window `[startRow, endRow)`. */
export interface RowWindow {
  readonly startRow: number
  readonly endRow: number
}

/** Discriminated result of validating a requested window. */
export type RowWindowValidation =
  | {
      readonly valid: true
      readonly startRow: number
      readonly endRow: number
      /** True when the request exceeded `maxRows` and was clamped down. */
      readonly clamped: boolean
    }
  | { readonly valid: false; readonly reason: string }

/**
 * Validate a requested row window. Rules:
 * - `startRow`/`endRow` must be safe non-negative integers (a non-integer or
 *   negative value is a caller bug → invalid, never silently repaired).
 * - `endRow < startRow` is invalid (inverted window).
 * - Windows larger than `maxRows` are **clamped**, not rejected: an oversized
 *   request is a legitimate "give me everything visible" ask from a virtual
 *   grid, and the honest answer is a capped window of `maxRows` rows.
 */
export function validateRowWindow(
  startRow: unknown,
  endRow: unknown,
  maxRows: number = MAX_RANGE_ROWS,
): RowWindowValidation {
  if (!isRowIndex(startRow)) {
    return { valid: false, reason: 'startRow must be a non-negative integer' }
  }
  if (!isRowIndex(endRow)) {
    return { valid: false, reason: 'endRow must be a non-negative integer' }
  }
  if (endRow < startRow) {
    return { valid: false, reason: 'endRow must be greater than or equal to startRow' }
  }
  const clampedEnd = Math.min(endRow, startRow + maxRows)
  return { valid: true, startRow, endRow: clampedEnd, clamped: clampedEnd !== endRow }
}

function isRowIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
