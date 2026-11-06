// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shell's single next-action derivation (rd-3/rd-4, UI-RD-01).
 *
 * The context bar is a *presentation* of state the App already owns. This
 * module is pure: it receives the existing session states and returns the one
 * action worth offering, so the bar cannot invent work, run anything on its
 * own, or read a value it does not need.
 *
 * Honesty rules baked in here:
 * - the bar names the **consequence** and the action; it never copies the
 *   verdict's counts (the verdict and the section summary keep them);
 * - "stale" is described as the session's staged state changing after the
 *   check, never as "the dataset changed": the editing session also bumps the
 *   overlay revision for a logged no-op, undo/redo and a selective cursor move,
 *   so neither a new operation nor different data is guaranteed;
 * - every state offers at most one primary action and, for the stale verdict,
 *   one secondary review action. Nothing auto-runs, and a busy state offers
 *   Cancel rather than a second run.
 */

/** Contract half, normalised from `ContractState`. */
export type NextActionContract = 'none' | 'unreadable' | 'loaded'

/** Validation half, normalised from `ValidationRunState['kind']`. */
export type NextActionValidation =
  'idle' | 'running' | 'cancelled' | 'failed' | 'binding-errors' | 'verdict'

/** Diff half, normalised from `DiffRunState['kind']`. */
export type NextActionDiff =
  'idle' | 'running' | 'cancelled' | 'failed' | 'binding-errors' | 'result'

export type NextActionKind =
  | 'open-contract'
  | 'review-contract'
  | 'validate'
  | 'cancel-validation'
  | 'review-findings'
  | 'review-comparison'
  | 'rerun-diff'
  | 'cancel-diff'
  | 'export'
  | 'none'

export type NextActionTone = 'neutral' | 'stale' | 'ok'

export interface NextAction {
  readonly kind: NextActionKind
  /** Value-free consequence sentence; never a copied count. */
  readonly state: string
  /** Primary control label, or `null` when the state has no useful action. */
  readonly action: string | null
  readonly tone: NextActionTone
  /** Only the stale verdict offers a second, review-only action. */
  readonly secondaryReview: boolean
}

export interface NextActionInput {
  readonly contract: NextActionContract
  readonly validation: NextActionValidation
  readonly validationStale: boolean
  /** Failing **rule** count from the current verdict; ignored outside `verdict`. */
  readonly failingRules: number
  readonly diff: NextActionDiff
  readonly diffStale: boolean
}

const STALE_VERDICT =
  'Verdict stale — the session\u2019s staged state changed after it was computed'
const STALE_DIFF = 'Comparison stale — the session\u2019s staged state changed after it ran'

/**
 * One deterministic action, with validation exceptions before comparison and
 * comparison before delivery. Busy states win so the user can always cancel.
 */
export function deriveNextAction(input: NextActionInput): NextAction {
  if (input.validation === 'running') {
    return {
      kind: 'cancel-validation',
      state: 'Validating the current dataset view\u2026',
      action: 'Cancel',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  // A running comparison is independent of the contract/check state (the diff
  // session can run on its own), so it must be cancellable in every state.
  if (input.diff === 'running') {
    return {
      kind: 'cancel-diff',
      state: 'Comparing datasets\u2026',
      action: 'Cancel',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.contract === 'none') {
    return {
      kind: 'open-contract',
      state: 'No contract loaded',
      action: 'Open a contract\u2026',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.contract === 'unreadable') {
    return {
      kind: 'review-contract',
      state: 'The contract could not be loaded',
      action: 'Review contract',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.validation === 'failed') {
    return {
      kind: 'validate',
      state: 'The last check failed',
      action: 'Retry check',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.validation === 'binding-errors') {
    return {
      kind: 'review-findings',
      state: 'The contract does not bind to the current schema',
      action: 'Review findings',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.validation === 'verdict') {
    if (input.validationStale) {
      return {
        kind: 'validate',
        state: STALE_VERDICT,
        action: 'Recheck',
        tone: 'stale',
        secondaryReview: true,
      }
    }
    if (input.failingRules > 0) {
      return {
        kind: 'review-findings',
        state: 'The current check found failures',
        action: 'Review findings',
        tone: 'neutral',
        secondaryReview: false,
      }
    }
    return comparisonOrDelivery(input)
  }
  if (input.validation === 'cancelled') {
    return {
      kind: 'validate',
      state: 'Check cancelled — the previous result is unchanged',
      action: 'Validate',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  return {
    kind: 'validate',
    state: 'Contract loaded — not checked yet',
    action: 'Validate',
    tone: 'neutral',
    secondaryReview: false,
  }
}

/**
 * A current, valid verdict: remaining work is the comparison if it needs
 * attention, otherwise delivery. Comparison states are consulted only after
 * the check itself is current, so a failing or unrun check always takes
 * precedence over a stale comparison.
 */
function comparisonOrDelivery(input: NextActionInput): NextAction {
  if (input.diff === 'binding-errors') {
    return {
      kind: 'review-comparison',
      state: 'The comparison needs attention',
      action: 'Review comparison',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.diff === 'failed') {
    return {
      kind: 'rerun-diff',
      state: 'The last comparison failed',
      action: 'Review comparison',
      tone: 'neutral',
      secondaryReview: false,
    }
  }
  if (input.diffStale) {
    return {
      kind: 'rerun-diff',
      state: STALE_DIFF,
      action: 'Review comparison',
      tone: 'stale',
      secondaryReview: false,
    }
  }
  return {
    kind: 'export',
    state: 'Verdict is current — no violations',
    action: 'Export a copy\u2026',
    tone: 'ok',
    secondaryReview: false,
  }
}
