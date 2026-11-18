// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — plan capture for `column-repair`: the draft the surface edits and
 * the pure parse that turns it into the domain op's payload.
 *
 * The capture is **three authored parts** (EW-04D §2 item 4):
 *
 * 1. the column (chosen from the *effective* schema — the surface never
 *    guesses a name),
 * 2. the explicit trim code-point set — `none`, the domain's recommended
 *    default ({@link DEFAULT_REPAIR_TRIM_CODE_POINTS}) or a user-listed set,
 *    always member-by-member and never `String.prototype.trim()` (D1/D2; the
 *    domain doc comment explains that `trim()`'s implicit set is a different,
 *    wrong set for repair),
 * 3. the mapping pairs, exact whole-value, authored one per line as
 *    `value => replacement`.
 *
 * Everything here is pure: no React, no engine, no I/O. The refusals that need
 * the *folded state* (column type, caps, dead keys, one trim set per chain,
 * identity) are **not** re-implemented here — they are the domain's typed
 * conflicts and are surfaced from the fold by `refusal.ts`
 * (`stepOverlay`), so this module can never disagree with the op's own rules.
 * Only the *authoring* refusals live here (a malformed line, a repeated
 * left-hand value), because the domain never sees a draft.
 *
 * ## The line format, stated honestly
 *
 * One pair per line: everything before the first ` => ` is the value, the rest
 * is its replacement. Neither side is trimmed — a plan that maps a
 * whitespace-padded value must be able to say so, and silently trimming the
 * user's input is exactly the class of lie the explicit trim set exists to
 * avoid. Consequences worth knowing (and pinned by tests):
 *
 * - `'' => x` maps the empty string (an empty left side is data, not a
 *   missing key) and `x => ''` maps a value to the empty string;
 * - a value that *ends* with a space cannot be written on one line, because
 *   `'  => '` positions the separator one character early — the trim set is
 *   the supported way to handle edge whitespace, and the helper copy says so;
 * - duplicate left-hand values are refused here (D4) because a simultaneous
 *   mapping with two targets for one value has no single meaning.
 */
import type { EditOp, TransformationHistory } from '@assay/domain'
import {
  DEFAULT_REPAIR_TRIM_CODE_POINTS,
  MAX_REPAIR_MAPPING_PAIRS,
  MAX_REPAIR_TRIM_CODE_POINTS,
} from '@assay/domain'
import {
  REPAIR_MAPPING_SEPARATOR,
  REPAIR_REFUSAL_COLUMN_MISSING,
  REPAIR_REFUSAL_DUPLICATE_KEY,
  REPAIR_REFUSAL_MAPPING_LINE,
} from './copy'

/** How the trim set is authored. */
export type RepairTrimMode = 'none' | 'default' | 'custom'

/** The draft the surface edits (plain strings — what a form holds). */
export interface RepairPlanDraft {
  /** The effective column name; `''` until one is chosen. */
  readonly column: string
  readonly trimMode: RepairTrimMode
  /** The user-listed set when `trimMode` is `'custom'`; ignored otherwise. */
  readonly customTrim: string
  /** One `value => replacement` pair per line. */
  readonly mappingText: string
}

/** The empty draft (the surface's initial state). */
export const EMPTY_REPAIR_DRAFT: RepairPlanDraft = {
  column: '',
  trimMode: 'none',
  customTrim: '',
  mappingText: '',
}

/** The op payload a validated draft becomes (the domain's own field names). */
export interface RepairPlan {
  readonly column: string
  readonly trim?: string
  readonly mapping: ReadonlyMap<string, string>
}

/** How many examples the preview shows (`LIMIT`; the cap is stated in copy). */
export const MAX_REPAIR_PREVIEW_EXAMPLES = 10

/** A refusal authored at capture/parse time. */
export interface RepairPlanRefusal {
  /** A stable code for tests and call sites — never rendered. */
  readonly code: 'column-missing' | 'mapping-line' | 'mapping-duplicate-key'
  /** The authored, value-free sentence the surface renders. */
  readonly message: string
}

/** The parse outcome: a committable plan, or a refusal (no plan at all). */
export type RepairPlanParse =
  | { readonly ok: true; readonly plan: RepairPlan }
  | { readonly ok: false; readonly refusal: RepairPlanRefusal }

/**
 * One mapping line split into its two sides, or `null` when the line carries
 * no ` => ` at all. The split is at the FIRST separator; neither side is
 * trimmed (see the module doc).
 */
export function parseMappingLine(line: string): readonly [string, string] | null {
  const at = line.indexOf(REPAIR_MAPPING_SEPARATOR)
  if (at < 0) return null
  return [line.slice(0, at), line.slice(at + REPAIR_MAPPING_SEPARATOR.length)]
}

/**
 * The trim set a draft declares: absent for `none`, the domain default for
 * `default`, the literal user text for `custom` (`''` — an empty custom set —
 * is passed through as `''` so the domain's own `repair-trim-invalid` refusal
 * is what the user sees: the surface never invents a second rule).
 */
export function draftTrimSet(draft: RepairPlanDraft): string | undefined {
  switch (draft.trimMode) {
    case 'none':
      return undefined
    case 'default':
      return DEFAULT_REPAIR_TRIM_CODE_POINTS
    case 'custom':
      return draft.customTrim
  }
}

/**
 * Parse a draft into the op payload. Total: every draft yields either a plan
 * or a refusal. Blank lines are skipped (a trailing newline is not a pair);
 * every other line must be a pair and every left-hand value must be unique.
 */
export function parseRepairPlan(draft: RepairPlanDraft): RepairPlanParse {
  if (draft.column === '') {
    // No column yet: the surface keeps Preview disabled and says what is
    // missing instead of complaining about the (empty) pair list.
    return {
      ok: false,
      refusal: { code: 'column-missing', message: REPAIR_REFUSAL_COLUMN_MISSING },
    }
  }
  const mapping = new Map<string, string>()
  for (const line of draft.mappingText.split(/\r\n|\r|\n/)) {
    if (line === '') continue
    const pair = parseMappingLine(line)
    if (pair === null) {
      return {
        ok: false,
        refusal: { code: 'mapping-line', message: REPAIR_REFUSAL_MAPPING_LINE },
      }
    }
    const [value, replacement] = pair
    if (mapping.has(value)) {
      return {
        ok: false,
        refusal: { code: 'mapping-duplicate-key', message: REPAIR_REFUSAL_DUPLICATE_KEY },
      }
    }
    mapping.set(value, replacement)
  }
  const trim = draftTrimSet(draft)
  return {
    ok: true,
    plan: {
      column: draft.column,
      ...(trim === undefined ? {} : { trim }),
      mapping,
    },
  }
}

/** The plan as the domain's `column-repair` op. */
export function repairPlanOp(plan: RepairPlan): EditOp {
  return {
    kind: 'column-repair',
    column: plan.column,
    ...(plan.trim === undefined ? {} : { trim: plan.trim }),
    mapping: plan.mapping,
  }
}

/**
 * A canonical identity for a plan: the column, whether a trim is set and its
 * exact set, and the pairs in sorted order. Two drafts that author the same
 * function have the same fingerprint regardless of line order, which is what
 * makes "the previewed plan" comparable to "the draft on screen" and
 * "already applied at this cursor" a decidable question.
 *
 * Not cryptographic (ADR 0007): it is a canonical *string*, compared as one.
 */
export function repairPlanFingerprint(plan: RepairPlan): string {
  const pairs = [...plan.mapping]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([value, replacement]) => `${value}\u0000${replacement}`)
  return [
    plan.column,
    plan.trim === undefined ? '\u0001none' : `\u0001trim:${plan.trim}`,
    ...pairs,
  ].join('\u0002')
}

/** The plan cap and trim cap, re-exported so the surface states domain numbers. */
export const REPAIR_PAIR_CAP = MAX_REPAIR_MAPPING_PAIRS
export const REPAIR_TRIM_CAP = MAX_REPAIR_TRIM_CODE_POINTS

/**
 * The fingerprint of a logged `column-repair` op, or `null` for any other op
 * kind. `describeOp` deliberately drops the plan payload (ADR 0025), so the
 * identity a repeat-apply refusal needs is computed from the op itself rather
 * than parsed back out of a description.
 */
export function repairOpFingerprint(op: EditOp): string | null {
  if (op.kind !== 'column-repair') return null
  return repairPlanFingerprint({
    column: op.column,
    ...(op.trim === undefined ? {} : { trim: op.trim }),
    mapping: op.mapping,
  })
}

/**
 * Whether `fingerprint` is already applied at this cursor — the active prefix
 * only, so a repair that was undone (its entry is in the redo tail) can be
 * applied again, and a repeat Apply of a live plan is refused by identity
 * (EW-04D D7).
 */
export function repairPlanIsActive(history: TransformationHistory, fingerprint: string): boolean {
  for (let index = 0; index < history.cursor; index += 1) {
    const entry = history.entries[index]
    if (entry === undefined) continue
    if (repairOpFingerprint(entry.op) === fingerprint) return true
  }
  return false
}
