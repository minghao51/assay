import type { EngineProfileColumn } from '@assay/engine-duckdb'

/**
 * Panel lifecycle state machine for the profile run (m2-6) — pure and
 * Node-tested, so the error/retry path is pinned without a DOM (the repo's
 * convention: thin components over tested pure modules, like m2-3's
 * `query-state.ts`).
 *
 * Delivery ordering is NOT this module's job: the run's promise tail is
 * guarded by `runGuarded` (generation guard, shared with the SQL pane), so
 * a cancelled or superseded run's late result/rejection never reaches the
 * reducer at all. The reducer only pins the observable states: a failed
 * profile is a readable, *retryable* error (never terminal), and a done
 * state always carries the delivered profile.
 */

/** The profile payload the panel keeps (structural slice of the engine's response). */
export interface ProfileData {
  readonly rowCount: number
  readonly columns: readonly EngineProfileColumn[]
}

export type ProfileState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly profile: ProfileData }
  | { readonly kind: 'error'; readonly message: string }

export type ProfileEvent =
  | { readonly type: 'started' }
  | { readonly type: 'succeeded'; readonly profile: ProfileData }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'reset' }

export function reduceProfileState(_state: ProfileState, event: ProfileEvent): ProfileState {
  switch (event.type) {
    case 'started':
      return { kind: 'running' }
    case 'succeeded':
      return { kind: 'done', profile: event.profile }
    case 'failed':
      return { kind: 'error', message: event.message }
    case 'reset':
      return { kind: 'idle' }
  }
}
