// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WF-06 replacement intent machine (v5 §4.1–§4.3, §4.6).
 *
 * The intent is App-local state, separate from `Phase`, so the ready subtree
 * never unmounts while a replacement is chosen or prepared. It has exactly
 * four shapes: `none | guard | choosing | opening-candidate`.
 *
 * Sequence ownership (C2): `none` carries **no** `seq` — there is nothing in
 * flight to supersede. The authority is the monotonic `intentSeqRef`; a
 * `seq` copied into an in-flight intent exists only for render/debug. Every
 * late completion therefore compares against the **ref** (plus the captured
 * `phase` identity), never against the intent object — which is `none` by the
 * time a late result would matter.
 *
 * Refusals are not states (v5 §4.1): G1–G5 render a notice and leave the
 * intent at `none`, so no refusal can be mistaken for pending work.
 */
import type { Phase } from '../sessions/types'

export type ReplacementIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'guard'; readonly seq: number }
  | { readonly kind: 'choosing'; readonly seq: number }
  | { readonly kind: 'opening-candidate'; readonly seq: number }

/** The three in-flight kinds a ready-state gesture can enter. */
export type ReplacementIntentKind = Exclude<ReplacementIntent['kind'], 'none'>

/** The idle intent. `none` deliberately has no `seq`. */
export const NO_REPLACEMENT_INTENT: ReplacementIntent = { kind: 'none' }

/** Build one in-flight intent carrying the sequence it was entered with. */
export function beginIntent(kind: ReplacementIntentKind, seq: number): ReplacementIntent {
  return { kind, seq }
}

/**
 * True while `seq` is still the current intent **and** the phase object is
 * still the one captured when the intent started. Used after every `await` in
 * the candidate chain: a superseded intent's or a different phase's result is
 * dropped silently (T10), never applied.
 */
export function isIntentCurrent(
  currentSeq: number,
  seq: number,
  phase: Phase,
  capturedPhase: Phase,
): boolean {
  return currentSeq === seq && phase === capturedPhase
}

export interface AdoptionPrecondition {
  readonly intent: ReplacementIntent
  /** `intentSeqRef.current` at adoption time (the authority, not the copy). */
  readonly currentSeq: number
  /** The live phase at adoption time. */
  readonly phase: Phase
  /** The phase captured when the intent was entered. */
  readonly capturedPhase: Phase
}

/**
 * `adopt()` step 0 (v5 §4.3). The only adoption guard: the intent must still
 * be `opening-candidate`, its copied sequence must still be the current one,
 * and the phase must be the one captured at intent entry. A `false` here means
 * the adoption writes nothing at all (defensive; no user gesture can supersede
 * a candidate because there is no Cancel and only one intent).
 */
export function canAdopt(input: AdoptionPrecondition): boolean {
  return (
    input.intent.kind === 'opening-candidate' &&
    input.intent.seq === input.currentSeq &&
    input.phase === input.capturedPhase
  )
}
