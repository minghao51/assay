// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WF-06 pure ready-state gesture gate (v5 §3.2, rows G1–G6).
 *
 * The gate is evaluated **synchronously, before any dialog, picker, `await` or
 * state write**, and it is the single entry point for the `guard` and
 * `choosing` intents. It reads the authority values the app keeps synchronous
 * mirrors for — the App-owned editor-state ref, the mutation counter, the
 * aggregate cast-pending set size and the settled `historyRef.current` — so its
 * verdict never depends on blur semantics or on React having re-rendered.
 *
 * Refusals are notices, not states: a refusal leaves the intent at `none` so
 * the very next gesture is evaluated from scratch (no auto-resume, no queued
 * retry). Dirty is computed only after G1–G5 pass, from the history the app
 * actually published.
 */
import type { TransformationHistory } from '@assay/domain'
import { hasAppliedChanges } from '../edit/session'
import type { ReplacementIntent } from './machine'

/** The surfaces App arbitrates as modal owners (v5 §7 priority order). */
export type OwnedModal = 'disclosure' | 'help' | 'replace' | 'export' | 'settings'

/** The grid's in-flight query epoch (the existing `gridBusy` value). */
export type ReadyGestureBusy = 'sorting' | 'filtering'

/** Which gate row refused, in evaluation order G1–G5. */
export type ReadyGestureRefusal = 'modal' | 'intent' | 'editor' | 'settling' | 'cast' | 'busy'

export interface ReadyGestureInput {
  /** G1 — an owned surface already owns the modal position. */
  readonly openModal: OwnedModal | null
  /** G2 — another replacement intent is already in flight. */
  readonly intent: ReplacementIntent
  /** G3 — `editorStateRef.current.open` for ANY editor kind. */
  readonly editorOpen: boolean
  /** G4 — `mutationStateRef.current` (commits in flight, counted). */
  readonly mutations: number
  /** G4 — `castPendingColumnsRef.current.size` (aggregate, never one column). */
  readonly castPendingCount: number
  /** G5 — the existing filter/sort busy epoch. */
  readonly gridBusy: ReadyGestureBusy | null
  /** G6 — the settled active history (`historyRef.current`). */
  readonly history: TransformationHistory
}

export type ReadyGestureVerdict =
  | { readonly kind: 'refuse'; readonly reason: ReadyGestureRefusal }
  | { readonly kind: 'proceed'; readonly dirty: boolean }

/** Evaluate G1–G6 in the mandated order. Pure; no DOM, no engine, no state. */
export function evaluateReadyGesture(input: ReadyGestureInput): ReadyGestureVerdict {
  if (input.openModal !== null) return { kind: 'refuse', reason: 'modal' }
  if (input.intent.kind !== 'none') return { kind: 'refuse', reason: 'intent' }
  if (input.editorOpen) return { kind: 'refuse', reason: 'editor' }
  // C15 wins when a mutation is in flight: a cast pre-check may already have
  // turned into its commit, and the commit is the later stage (v5 §3.7).
  if (input.mutations > 0) return { kind: 'refuse', reason: 'settling' }
  if (input.castPendingCount > 0) return { kind: 'refuse', reason: 'cast' }
  if (input.gridBusy !== null) return { kind: 'refuse', reason: 'busy' }
  return { kind: 'proceed', dirty: hasAppliedChanges(input.history) }
}
