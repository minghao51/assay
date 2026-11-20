// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single-slot CSV preview registry (EW-03I; ADR 0049 decision 4), extracted
 * from the executor as an engine-local module (D04a) alongside the existing
 * `table-registry.ts` / `comparison-registry.ts` peers. It is pure bookkeeping —
 * DuckDB calls live with the handlers — so it stays unit-testable under Node,
 * and the executor remains its ONE owner (one instance, never module-level
 * mutable state, never a global service locator).
 */

/** One staged preview candidate (EW-03I; ADR 0049 decision 4). */
export interface StagedPreview {
  readonly previewId: string
  readonly viewName: string
  readonly registeredFileName: string
}

/** View names are the preview id with a namespaced prefix: `assay_preview_p1`. */
export function viewNameForPreviewId(previewId: string): string {
  return `assay_preview_${previewId}`
}

/** The only view name shape the preview slot may ever drop (allowlist guard). */
const PREVIEW_VIEW_NAME_SHAPE = /^assay_preview_p\d+$/

/**
 * Structural allowlist for the preview slot's release: the interpolated name
 * must be the registry's own engine-generated shape (`assay_preview_pN`) —
 * nothing host-reachable can reach the DROP (DuckDB's binding has no
 * parameterized DDL; the repo rule is engine-generated identifiers only,
 * quoted via `quotedIdentifier` before composition).
 */
export function assertPreviewViewName(viewName: string): void {
  if (!PREVIEW_VIEW_NAME_SHAPE.test(viewName)) {
    throw new Error('preview slot release refused a non-preview view name')
  }
}

/**
 * Worker-side SINGLE-SLOT preview registry (ADR 0049 decision 4): its own id
 * sequence (`p1`, `p2`, …), its own view name (`assay_preview_p1`) and its own
 * DuckDB file-registration name (`preview_p1`). It NEVER inserts into the
 * `TableRegistry` — a preview never creates a session relation, never sets a
 * ready phase, never adopts (adoption is exactly a fresh `engine/open`).
 *
 * Bare registration is the default: the acquisition probe proved the shipped
 * build scans `read_csv('preview_pN')` / `sniff_csv('preview_pN')` with NO
 * view and no catalog object, so the preview path creates no view at all. The
 * view name is still owned (and its release still attempted first, view-then-
 * file, both swallowed — the `runDiffStage` ordering), which keeps the slot's
 * release contract uniform if a future slice ever creates a view.
 *
 * Like `ComparisonRegistry` this class is pure bookkeeping — DuckDB calls
 * live in the executor — so it is unit-testable under Node. Monotonic ids
 * mean a re-stage never reuses names (the probe: reusing a LIVE file name
 * degrades silently, and a live view name fails loudly — neither is needed).
 *
 * Cross-lane race discipline: previews run on the query lane, but
 * `engine/open` and `engine/dispose` run on the registry lane — and a preview
 * accepted while query-lane work is in flight QUEUES behind it, so its op
 * body may start long after acceptance. The registry therefore tracks a live
 * slot plus a supersede generation, and the INTENT IS CAPTURED
 * SYNCHRONOUSLY AT REQUEST ACCEPTANCE (EngineOpExecutor.accept calls
 * {@linkcode PreviewRegistry.reserve reserve} +
 * {@linkcode PreviewRegistry.beginIntent beginIntent} before enqueueing):
 *
 * - `staged` — the live slot (installed post-registration; released by the
 *   next slot event or dispose);
 * - the reserved slot name — held by the queued op itself (reserve() is
 *   synchronous and monotonic, so acceptance-time capture reserves the name);
 * - `generation` — captured at acceptance and bumped by every
 *   {@linkcode PreviewRegistry.supersede supersede} (open/dispose). An open
 *   that completes while a preview sits queued advances the generation past
 *   the captured one, so when the op finally runs, its checkpoints see it
 *   stale: it never touches the engine, self-releases whatever landed, and
 *   is answered with the typed supersession error instead of a result.
 *
 * No method awaits, so generation transitions have no interleaving window
 * inside this class; multiple queued previews are each invalidated by the
 * one bump because each holds its own captured generation.
 */
export class PreviewRegistry {
  private nextSequence = 1
  private staged: StagedPreview | null = null
  private generation = 1

  /** Reserve the next preview id; pair with `beginIntent()` immediately (synchronously, at acceptance). */
  reserve(): StagedPreview {
    const previewId = `p${this.nextSequence++}`
    return {
      previewId,
      viewName: viewNameForPreviewId(previewId),
      registeredFileName: `preview_${previewId}`,
    }
  }

  /**
   * Capture the supersede generation for an intent taken SYNCHRONOUSLY at
   * request acceptance. The reserved slot name is held by the queued op; the
   * returned generation is what the op re-checks at every checkpoint — an
   * open/dispose supersede after acceptance moves it past the captured
   * value, making the op stale before it ever runs.
   */
  beginIntent(): number {
    return this.generation
  }

  /** True while no supersede (open/dispose) has invalidated the captured generation. */
  isCurrent(generation: number): boolean {
    return this.generation === generation
  }

  /**
   * Supersede ALL preview state (open/dispose, other lanes): clears the live
   * slot (the CALLER releases its view/file) and bumps the generation,
   * invalidating every intent captured before this call — queued or in-
   * flight, each stale op self-releases at its checkpoints and never
   * installs. Synchronous, and it bumps even when no live slot exists (a
   * queued preview is invalidated by the generation alone). Returns the live
   * slot that needs releasing, if any.
   */
  supersede(): StagedPreview | null {
    const staged = this.staged
    this.staged = null
    this.generation += 1
    return staged
  }

  /**
   * Sequential drop-before-restage (same lane — no other preview op can be
   * running): clears the live slot WITHOUT bumping the generation. The
   * caller releases what is returned.
   */
  clearStaged(): StagedPreview | null {
    const staged = this.staged
    this.staged = null
    return staged
  }

  /**
   * Commit the reservation as the single live slot. Called only after the
   * op's staleness checkpoints pass (an intent that queued behind an open is
   * stale at its first checkpoint and NEVER reaches confirm — it self-
   * releases instead). Also called on a non-superseded failure: the slot
   * then tracks a name whose registration may not exist, which is harmless
   * (the probe: `dropFile` on a missing name does not throw) and keeps every
   * reserved name reachable by the NEXT slot event (re-stage, open) or
   * `engine/dispose` — the ADR's "+1 retained until the next slot event or
   * dispose" row is exactly this bookkeeping.
   */
  confirm(entry: StagedPreview): void {
    this.staged = entry
  }

  /** The current staged preview, if any. */
  current(): StagedPreview | null {
    return this.staged
  }
}
