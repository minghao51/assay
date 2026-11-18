// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the domain's typed repair refusals, rendered as authored,
 * **value-free** sentences.
 *
 * Every rule about a repair *plan* lives in the domain's fold
 * (`stepColumnRepair`, `overlay.ts`): unknown column, non-textual column type,
 * the pair cap, a malformed/over-cap trim set, dead mapping keys, one trim set
 * per chain, and the identity plan. This module does not restate any of them —
 * it calls `stepOverlay` against the live state and translates the typed
 * outcome. Two consequences, both deliberate:
 *
 * - **No engine call.** A plan the domain refuses is refused before any read
 *   (EW-04I done-when 1: "the domain's typed value-free refusals … surface
 *   without an engine call"). The fold is pure and synchronous.
 * - **No second source of truth.** There is no host-side re-implementation of
 *   the caps or the dead-key rule, so the surface cannot disagree with what
 *   `appendOp` will decide at publication time (it runs the same fold).
 *
 * Copy is value-free by construction (ADR 0025): the sentences name the
 * *shape* — column kind, pair count, code-point count, a dead key's edge, the
 * identity — and never a dataset value or a mapping entry. The one datum a
 * refusal message may echo is a cap/threshold, which is domain configuration.
 */
import type { OpOutcome, OverlayBase, OverlayState } from '@assay/domain'
import { stepOverlay } from '@assay/domain'
import { REPAIR_PAIR_CAP, REPAIR_TRIM_CAP, repairPlanOp, type RepairPlan } from './plan'
import {
  REPAIR_REFUSAL_COLUMN_MISSING,
  REPAIR_REFUSAL_DEAD_KEY,
  REPAIR_REFUSAL_IDENTITY,
  REPAIR_REFUSAL_NOT_TEXT,
  REPAIR_REFUSAL_TRIM_MISMATCH,
  repairRefusalPairCap,
  repairRefusalTrimInvalid,
} from './copy'

/** The stable codes a repair refusal can carry (never rendered). */
export type RepairRefusalCode =
  | 'unknown-column'
  | 'repair-column-not-text'
  | 'repair-mapping-cap'
  | 'repair-trim-invalid'
  | 'repair-dead-mapping-key'
  | 'repair-trim-mismatch'
  | 'repair-identity'

/** One domain refusal: its typed code plus the authored sentence. */
export interface RepairOutcomeRefusal {
  readonly code: RepairRefusalCode
  readonly message: string
}

/** The sentence for one repair-relevant domain reason. */
function messageForReason(code: RepairRefusalCode): string {
  switch (code) {
    case 'unknown-column':
      return REPAIR_REFUSAL_COLUMN_MISSING
    case 'repair-column-not-text':
      return REPAIR_REFUSAL_NOT_TEXT
    case 'repair-mapping-cap':
      return repairRefusalPairCap(REPAIR_PAIR_CAP)
    case 'repair-trim-invalid':
      return repairRefusalTrimInvalid(REPAIR_TRIM_CAP)
    case 'repair-dead-mapping-key':
      return REPAIR_REFUSAL_DEAD_KEY
    case 'repair-trim-mismatch':
      return REPAIR_REFUSAL_TRIM_MISMATCH
    case 'repair-identity':
      return REPAIR_REFUSAL_IDENTITY
  }
}

/** The repair reasons this surface can render (the fold's repair vocabulary). */
const REPAIR_REASONS: ReadonlySet<string> = new Set<RepairRefusalCode>([
  'unknown-column',
  'repair-column-not-text',
  'repair-mapping-cap',
  'repair-trim-invalid',
  'repair-dead-mapping-key',
  'repair-trim-mismatch',
  'repair-identity',
])

/**
 * Translate one folded outcome into a refusal, or `null` when the plan would
 * be applied. A `column-repair` can only be refused by the repair reasons
 * above (or the state-anchor guard, which the live session cannot trip); any
 * other reason is reported through the generic path so it is never swallowed
 * silently — it is still value-free, because only the code travels.
 */
export function repairRefusalForOutcome(outcome: OpOutcome): RepairOutcomeRefusal | null {
  if (outcome.status === 'applied') return null
  const code = outcome.reason
  if (REPAIR_REASONS.has(code)) {
    const repairCode = code as RepairRefusalCode
    return { code: repairCode, message: messageForReason(repairCode) }
  }
  // Not a repair reason (defensive: `state-anchor-mismatch` is the only other
  // member this op could reach). The code is domain vocabulary, never data.
  return { code: 'unknown-column', message: REPAIR_REFUSAL_COLUMN_MISSING }
}

/**
 * Run the domain's own fold for `plan` against `state` and report the refusal,
 * or `null` when the plan is applicable. This is the capture-time gate: no
 * engine call, no append, no state change (`stepOverlay` is pure).
 */
export function validateRepairPlan(
  base: OverlayBase,
  state: OverlayState,
  plan: RepairPlan,
): RepairOutcomeRefusal | null {
  const step = stepOverlay(base, state, repairPlanOp(plan))
  return repairRefusalForOutcome(step.application.outcome)
}
