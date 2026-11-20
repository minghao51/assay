// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TransformationHistory } from '@assay/domain'
import type { DiffRunState } from '../diff/DiffPanel'
import { activeOps } from '../edit/session'
import type { ValidationRunState } from '../validation/ValidationPanel'

/**
 * D02a: the pure state summaries the shell-owned section toggles render next
 * to their purpose line (ug-17/UG-27). They were lifted out of `App.tsx`
 * verbatim: each one is a byte-exact string projection of an existing run
 * state, with no hooks, no engine/session lifecycle and no state ownership —
 * so they belong with the other workbench presentation helpers and are
 * testable without mounting the composition root.
 *
 * `App.tsx` re-exports all three so the existing test seam
 * (`import { validationSectionSummary } from './App'`) keeps working.
 */

/**
 * ug-17 / UG-27 (also the next-action bar's `failingRules` input): the count
 * of rules the CURRENT verdict reports as failing
 * (the same `failing` flag the Validation panel renders). Not a row count and
 * never a rule name — the summary is value-free (ADR 0025) and only ever
 * renders when > 0. A stale verdict keeps its count; the panel owns the stale
 * marking, so the summary neither claims freshness nor repeats it.
 */
export function failingRuleCount(run: ValidationRunState): number {
  if (run.kind !== 'verdict') return 0
  return run.report.rows.filter((row) => row.failing).length
}

/**
 * ug-17: state summary for the shell-owned Validation toggle, byte-exact
 * (`Validation · <N> failing`, singular and plural alike). `null` at 0 and in
 * every non-verdict state (idle/running/cancelled/failed/binding-errors), so
 * the toggle renders no summary element at all.
 */
export function validationSectionSummary(run: ValidationRunState): string | null {
  const count = failingRuleCount(run)
  return count > 0 ? `Validation \u00b7 ${String(count)} failing` : null
}

/**
 * ug-17: state summary for the shell-owned Compare toggle, byte-exact
 * (`Compare · <N> changed`) from the current row-diff result's `changed`
 * count. `null` for 0 changed and for every non-result state, and a stale
 * result keeps its count (the panel owns the stale marking).
 */
export function comparisonSectionSummary(run: DiffRunState): string | null {
  const count = run.kind === 'result' ? run.report.changed.count : 0
  return count > 0 ? `Compare \u00b7 ${String(count)} changed` : null
}

/**
 * ug-17: state summary for the shell-owned History toggle, byte-exact
 * (`History · <N> pending`). N is `activeOps(history).length` — the SAME
 * staged-operation count R-16 (ug-10) labels in the Profile panel, not a net
 * difference — so the toggle and the panel can never disagree. `null` at
 * cursor 0 and after undoing back to 0.
 */
export function historySectionSummary(history: TransformationHistory): string | null {
  const count = activeOps(history).length
  return count > 0 ? `History \u00b7 ${String(count)} pending` : null
}
