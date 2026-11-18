// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the column-repair surface's copy (EW-04D §3/§5/§6/§7; ADR 0050;
 * post-R1 acceptance D4; the D16/D17 composition probe).
 *
 * Constant-only, exactly like `csv/copy.ts` and `replace/messages.ts`: nothing
 * here interpolates engine text, a filename, a path, a **dataset value** or a
 * **mapping entry**. The composed sentences take only plan *shape* numbers that
 * are engine/domain configuration (`MAX_REPAIR_MAPPING_PAIRS`, the code-point
 * cap, the published export envelope, counts this surface itself measured) —
 * ADR 0025. Every sentence a user can see is pinned by a literal in
 * `App.repair.test.tsx`, and the refusal set is additionally pinned by
 * `refusal.test.ts` so a domain-reason → sentence mapping cannot drift.
 *
 * Truth constraints these strings carry:
 *
 * - **Scope is whole-effective** (EW-04D §2, D10): the plan reads the whole
 *   column; grid filters/sort/paging are never captured and never narrow the
 *   target set. `REPAIR_SCOPE` states it, `REPAIR_COUNT_NOTE` repeats it where
 *   the numbers appear.
 * - **Counts are complete, examples are bounded and stated** (EW-04D §3). The
 *   cap is *said out loud* with both numbers ("first N of K"), never implied —
 *   `repairExampleCapSentence`.
 * - **The trim set is explicit** (D1/D2, `DEFAULT_REPAIR_TRIM_CODE_POINTS`).
 *   `REPAIR_TRIM_DEFAULT_HELPER` names the four members and says plainly that
 *   no other character is trimmed, which is exactly the difference from
 *   `String.prototype.trim()` (it strips NBSP and keeps tab/LF/CR — see the
 *   domain's doc comment).
 * - **One entry, one undo step; undo is a refold** (ADR 0050): the surface
 *   previews a plan, applies it once through the existing commit boundary, and
 *   the history panel is where "one entry, one undo" is read back (the entry's
 *   description is `describeOp`'s plan shape only).
 * - **Nothing partial, no interrupt claim** (EW-04D §5/§7, D4(a)). The budget
 *   refusal speaks about a plan that was never previewed or applied; no
 *   sentence in this module claims an engine query was interrupted, cancelled
 *   or aborted (there is no such op).
 */

/** Entry control in the editing surface (ready phase only). */
export const REPAIR_ACTION = 'Repair a column…'

/** The dialog's accessible name and heading. */
export const REPAIR_TITLE = 'Repair a column'

/**
 * Scope, stated before anything is authored: the target set is the whole
 * effective column, and nothing is applied by looking.
 */
export const REPAIR_SCOPE =
  'This repair reads the whole column: every row in the session, including rows the grid is filtering out. Sorting, filtering and paging never change what it reaches. Nothing is applied until you choose Apply repair.'

/** Plan capture: the column. */
export const REPAIR_COLUMN_LABEL = 'Column'
export const REPAIR_COLUMN_HELPER =
  'Only a text column can be repaired — a repair trims and matches text.'

/** Edge trim (the explicit code-point set; never `String.prototype.trim()`). */
export const REPAIR_TRIM_LABEL = 'Edge trim'
export const REPAIR_TRIM_NONE = 'No trim'
export const REPAIR_TRIM_DEFAULT = 'Space, tab, LF and CR'
export const REPAIR_TRIM_CUSTOM = 'Characters I list'
export const REPAIR_TRIM_DEFAULT_HELPER =
  'Removes exactly these four characters from both ends of every value, repeatedly. Interior characters are untouched and no other character is trimmed: NBSP and the other Unicode spaces are not in this set.'
export const REPAIR_TRIM_CUSTOM_LABEL = 'Characters to trim'
export const REPAIR_TRIM_CUSTOM_HELPER =
  'Up to sixteen characters, removed from both ends of every value. Type the characters themselves — a character you do not list is never trimmed.'

/** The mapping editor: one pair per line. */
export const REPAIR_MAPPING_LABEL = 'Mapping'
export const REPAIR_MAPPING_HELPER =
  'One pair per line, written value => replacement. The whole value must match exactly — same spelling, same case — so spaces on either side of the arrow are part of the value. Trim runs first, then the mapping.'
export const REPAIR_MAPPING_SEPARATOR = ' => '

/** Preview / apply controls. */
export const REPAIR_PREVIEW_ACTION = 'Preview'
export const REPAIR_APPLY = 'Apply repair'
export const REPAIR_CANCEL = 'Cancel'

/** The preview section. */
export const REPAIR_PREVIEW_HEADING = 'What this plan would do'
export const REPAIR_PREVIEW_LOADING = 'Reading the whole column…'
export const REPAIR_COUNT_SCANNED = 'Rows in the column'
export const REPAIR_COUNT_AFFECTED = 'Rows it changes'
export const REPAIR_COUNT_UNAFFECTED = 'Rows it leaves as they are'
export const REPAIR_COUNT_NOTE =
  'Counted over the whole column in one pass. Grid filters and sorting do not narrow these numbers.'

/** The bounded examples. */
export const REPAIR_EXAMPLES_HEADING = 'Changed rows, bounded'
export const REPAIR_EXAMPLES_NOTE =
  'Shown exactly as stored, so a whitespace-only difference is a real difference.'
export const REPAIR_EXAMPLE_ROW = 'Row'
export const REPAIR_EXAMPLE_BEFORE = 'Value now'
export const REPAIR_EXAMPLE_AFTER = 'Value after the repair'
export const REPAIR_EXAMPLES_NONE = 'No row changes under this plan, so there is nothing to show.'

/** Staleness: the preview no longer describes the session it was read from. */
export const REPAIR_PREVIEW_STALE =
  'This preview is out of date: an edit, an undo or a different file version landed after it was read. Preview again before applying — nothing was applied.'
/** Staleness: the draft no longer matches the previewed plan. */
export const REPAIR_PREVIEW_OUTDATED =
  'The plan changed after this preview. Preview it again before applying.'

/**
 * The example cap, stated with both numbers whenever the plan changes more
 * rows than the surface shows (EW-04D §3: never a silent top-N).
 */
export function repairExampleCapSentence(shown: number, affected: number): string {
  if (affected <= shown) return `All ${String(affected)} changed rows are shown.`
  return `Showing the first ${String(shown)} of ${String(affected)} changed rows.`
}

/** The pair-count read-out (shape only; the cap is domain configuration). */
export function repairPairCountSentence(pairs: number, cap: number): string {
  return `${String(pairs)} of ${String(cap)} mapping pairs.`
}

/** The trim-set size read-out (shape only; never the characters themselves). */
export function repairTrimCountSentence(codePoints: number, cap: number): string {
  return `${String(codePoints)} of ${String(cap)} characters in the trim set.`
}

/**
 * The published export envelope refusal (post-R1 acceptance D4(a); EW-04D
 * §4.4). Pre-apply: the projection is `rows × mapping pairs` over the
 * *whole effective relation*, the same quantity the engine's
 * `MAX_REPAIR_EXPORT_CELL_WORK` envelope refuses at export time — surfaced
 * here before anything is read or applied, and never described as an
 * interrupt (nothing cancels a query once composed).
 */
export function repairBudgetRefusal(rows: number, pairs: number, envelope: number): string {
  const work = rows * pairs
  return (
    `This plan would cost ${String(rows)} rows × ${String(pairs)} mapping pairs = ` +
    `${work.toLocaleString('en-US')} cell rewrites, over the published envelope of ` +
    `${envelope.toLocaleString('en-US')}. Nothing was previewed or applied: export the edits ` +
    'to a new file and re-open it before repairing further.'
  )
}

/** Refusals authored here (each names plan *shape* only — ADR 0025). */
export const REPAIR_REFUSAL_COLUMN_MISSING = 'Choose the column to repair.'

export const REPAIR_REFUSAL_NOT_TEXT =
  'That column is not a text column, so a repair cannot target it: only VARCHAR, TEXT and STRING can be repaired. Character and ENUM columns are refused because a trim would re-declare their type.'

export function repairRefusalPairCap(cap: number): string {
  return `This plan has more than ${String(cap)} mapping pairs, over the plan cap. Split it into several repairs.`
}

export function repairRefusalTrimInvalid(cap: number): string {
  return `The trim set must hold between 1 and ${String(cap)} characters. Choose No trim, or list at least one character.`
}

export const REPAIR_REFUSAL_DEAD_KEY =
  'A mapping value ends or begins with a character from the trim set, so that pair could never match — trimming happens before the mapping. Remove those characters from the pair, or change the trim set.'

export const REPAIR_REFUSAL_TRIM_MISMATCH =
  'This column already carries a repair with a different trim set in this session, and one repair chain has one trim set. Undo that repair, or match its trim set.'

export const REPAIR_REFUSAL_IDENTITY =
  'This plan changes nothing: it has no mapping pairs and no trim, so every value would pass through unchanged.'

export const REPAIR_REFUSAL_MAPPING_LINE =
  'Each line must read value => replacement. A line without => is refused.'

export const REPAIR_REFUSAL_DUPLICATE_KEY =
  'Two lines use the same left-hand value. Each value may appear in the mapping once.'

/** Zero-affected refusal (EW-04D D8 / U1): nothing is appended. */
export const REPAIR_REFUSAL_ZERO_AFFECTED =
  'No row changes under this plan, so nothing was applied and the history is unchanged.'

/** Repeat Apply of the plan already at the cursor (D7, plan identity). */
export const REPAIR_REFUSAL_ALREADY_ACTIVE =
  'This exact plan is already applied at this point in the history, so nothing was applied. One undo removes the repair that is there.'

/** The plan is not the one that was previewed. */
export const REPAIR_REFUSAL_NO_PREVIEW =
  'Preview this plan before applying it — nothing was applied.'
