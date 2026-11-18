// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — projecting one preview read into the surface's state.
 *
 * Pure: a `RepairPreview` is plain data built from (plan, capture tag, the two
 * engine answers). No React state holds a row list: the `examples` array is
 * `≤10` entries, and everything else is a count. The complete row set is never
 * in memory anywhere (EW-04D §3: "no matching-row arrays in React").
 *
 * The example cap is carried with the preview (`exampleCap`) so the render can
 * state it against the *complete* affected count — "first 10 of 137" — instead
 * of implying the sample is the whole answer (`previewExampleCapSentence`).
 *
 * Example text is the stored text, not a prettified rendering: a repair is
 * exact whole-value equality over text, so a value whose only difference is
 * whitespace must look different (the cells render `white-space: pre-wrap`).
 * NULL is unreachable inside the affected set (a repair never matches or
 * produces NULL) but is rendered as the literal `NULL` if a response ever
 * disagrees, never as an empty cell.
 */
import type { RepairCaptureTag } from './capture'
import { repairExampleCapSentence } from './copy'
import type { RepairPlan } from './plan'
import { repairedValue } from './preview-sql'

/** The complete counts of one preview (one pass over the whole column). */
export interface RepairCounts {
  /** Effective live rows in the column. */
  readonly scanned: number
  /** Rows this plan changes (`scanned - unaffected`). */
  readonly affected: number
  /** Rows it leaves exactly as they are. */
  readonly unaffected: number
}

/** One bounded before/after example: a logical row id and two strings. */
export interface RepairExample {
  readonly rowId: string
  readonly before: string
  readonly after: string
}

/** Everything the preview surface renders, and nothing else. */
export interface RepairPreview {
  readonly plan: RepairPlan
  /** `repairPlanFingerprint(plan)` — what "the previewed plan" means. */
  readonly fingerprint: string
  /** The captured revision this preview answers for (staleness is decided on it). */
  readonly tag: RepairCaptureTag
  readonly counts: RepairCounts
  readonly examples: readonly RepairExample[]
  /** The stated `LIMIT` (never implied). */
  readonly exampleCap: number
}

/** One engine answer for a preview: complete counts plus the bounded rows. */
export interface RepairPreviewRead {
  readonly scanned: number
  readonly affected: number
  /** Raw effective values with their logical row ids, `≤ exampleCap` long. */
  readonly exampleRows: readonly { readonly rowId: string; readonly value: unknown }[]
  readonly exampleCap: number
}

/**
 * One example's display text for an effective value. A VARCHAR column yields
 * strings; anything else is rendered through `String` rather than guessed, and
 * NULL stays visibly NULL.
 */
export function repairValueText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return value
  return String(value)
}

/**
 * Project one returned row into a before/after pair. The `after` side is the
 * plan applied to the *before* value with the domain's own function (the same
 * one the composer's D17 literal rewrite uses), so the pair is not a second
 * opinion about the repair's semantics — it is the repair's semantics, on the
 * value the engine returned.
 */
export function repairExampleFrom(rowId: string, value: unknown, plan: RepairPlan): RepairExample {
  const before = repairValueText(value)
  // A non-text value cannot be repaired; the domain refuses a non-text column
  // and the predicate filters to text rows, so this is the defensive branch:
  // the row is shown unchanged rather than a `after` invented from a non-string.
  const after = typeof value === 'string' ? repairedValue(value, plan) : before
  return { rowId, before, after }
}

/** Assemble the preview from the capture tag and one complete read. */
export function assembleRepairPreview(
  plan: RepairPlan,
  fingerprint: string,
  tag: RepairCaptureTag,
  read: RepairPreviewRead,
): RepairPreview {
  const examples = read.exampleRows
    .slice(0, read.exampleCap)
    .map((row) => repairExampleFrom(row.rowId, row.value, plan))
  const affected = read.affected
  return {
    plan,
    fingerprint,
    tag,
    counts: {
      scanned: read.scanned,
      affected,
      unaffected: Math.max(0, read.scanned - affected),
    },
    examples,
    exampleCap: read.exampleCap,
  }
}

/** The stated cap sentence for a preview (both numbers, always). */
export function previewExampleCapSentence(preview: RepairPreview): string {
  return repairExampleCapSentence(preview.examples.length, preview.counts.affected)
}
