// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the repair surface's state: plan capture → preview → Apply.
 *
 * Everything the surface knows fits in one hook so the states are explicit and
 * testable, and so the two refusal paths that matter can be pinned:
 *
 * - **Stale at render (U2, host half).** The preview carries the capture tag it
 *   was read under; every render compares it with the live session
 *   (`captureIsStale`). A drifted tag disables Apply and says why. The
 *   authoritative re-check happens at publication (`useEditingSession`), so a
 *   stale plan cannot be committed even if a render was missed — the render
 *   check is the honest *surface*, the commit check is the guarantee.
 * - **Out-of-order results (U3).** The preview read spans an `await`, so every
 *   dispatch takes a monotonic `requestId` and a settled result is accepted
 *   only when it is still the newest (`requestSeq`). A superseded read — a
 *   slower earlier one, or one that settles after the surface was closed —
 *   never paints over a newer preview and never becomes applicable. The
 *   protocol half of U3 is the client's own `requestId` correlation
 *   (`packages/engine-duckdb/src/client.ts`: pending responses are matched by
 *   `requestId`, so a worker reply can never cross to another request); this
 *   guard is the host half, and both are pinned (`useRepairPreview.test.tsx`
 *   settles the reads out of order).
 *
 * The Apply gate is a *set of* conditions, each with its own sentence, in this
 * order: no preview yet → the plan changed after the preview (fingerprint) →
 * the session changed after the preview (tag) → zero affected rows (U1).
 * Refusing through the hook (rather than only by disabling the button) is what
 * makes "apply without a fresh preview" unreachable from the surface, and the
 * session's commit path refuses the same cases again.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { engineErrorMessage } from '../session'
import { captureIsStale } from './capture'
import type { RepairApplyGuard, RepairCaptureTag } from './capture'
import { repairBudgetRefusalFor } from './budget'
import {
  REPAIR_PREVIEW_LOADING,
  REPAIR_PREVIEW_OUTDATED,
  REPAIR_PREVIEW_STALE,
  REPAIR_REFUSAL_NO_PREVIEW,
  REPAIR_REFUSAL_ZERO_AFFECTED,
} from './copy'
import {
  EMPTY_REPAIR_DRAFT,
  parseRepairPlan,
  repairPlanFingerprint,
  type RepairPlan,
  type RepairPlanDraft,
  type RepairPlanParse,
} from './plan'
import type { RepairOutcomeRefusal } from './refusal'
import { assembleRepairPreview, type RepairPreview, type RepairPreviewRead } from './preview'

/** Live session facts the budget projection needs (null before a table is ready). */
export interface RepairSessionFacts {
  /** Effective live rows (base − tombstones + live inserts). */
  readonly liveRows: number
  /** Mapping pairs already in the active repair chain (the engine sums the prefix). */
  readonly repairPairs: number
}

export type { RepairApplyGuard }

/**
 * The seam to the live editing session. Injected (built in `App`) so the hook
 * is testable without an engine or a session, and so every read below is
 * answered from the same immutable snapshot the surface displays.
 */
export interface RepairSeam {
  /** Live session facts, read at dispatch/render time (never cached). */
  facts(): RepairSessionFacts | null
  /** The capture tag for `column`, or null when it is not in the schema. */
  captureTag(column: string): RepairCaptureTag | null
  /** The domain's own typed refusal for `plan` (no engine call). */
  validatePlan(plan: RepairPlan): RepairOutcomeRefusal | null
  /** Counts + ≤10 examples over one snapshot of the effective relation. */
  readPreview(plan: RepairPlan): Promise<RepairPreviewRead>
  /** Publish through the editing session's commit boundary (one history entry). */
  apply(plan: RepairPlan, guard: RepairApplyGuard): void
}

/** The preview lifecycle. */
export type RepairPreviewState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'loading'
      readonly plan: RepairPlan
      readonly fingerprint: string
      readonly requestId: number
    }
  | { readonly kind: 'ready'; readonly preview: RepairPreview }
  | {
      readonly kind: 'failed'
      readonly plan: RepairPlan
      readonly fingerprint: string
      readonly message: string
    }

/** Everything the dialog renders, plus the actions it calls. */
export interface RepairSurface {
  readonly open: boolean
  readonly draft: RepairPlanDraft
  readonly parsed: RepairPlanParse
  /** The capture-time refusal (parse or the domain's typed one), or null. */
  readonly refusal: { readonly code: string; readonly message: string } | null
  /** The pre-apply export-budget refusal, or null (D4 option (a)). */
  readonly budgetRefusal: string | null
  readonly preview: RepairPreviewState
  /** The shown preview predates a session change (U2 render half). */
  readonly previewStale: boolean
  /** The shown preview is for a plan the draft no longer describes. */
  readonly previewOutdated: boolean
  /** Why Apply is unavailable right now, or null when it is available. */
  readonly applyBlockedReason: string | null
  /** The last refused apply/action, announced once (role=alert). */
  readonly message: string | null
  readonly canPreview: boolean
  readonly canApply: boolean
  /** Pair and code-point counts for the read-outs (plan shape only). */
  readonly pairCount: number
  readonly trimCodePoints: number
  openDialog(): void
  closeDialog(): void
  update(patch: Partial<RepairPlanDraft>): void
  runPreview(): void
  applyPreview(): void
}

/** The empty capture surface's starting state. */
const IDLE: RepairPreviewState = { kind: 'idle' }

/**
 * The repair surface hook. `seam` is rebuilt by the composition root as the
 * session changes; every fact is read through it at call time, so no closure
 * here can serve a stale row count, tag or plan refusal.
 */
export function useRepairPreview(seam: RepairSeam): RepairSurface {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<RepairPlanDraft>(EMPTY_REPAIR_DRAFT)
  const [preview, setPreview] = useState<RepairPreviewState>(IDLE)
  const [message, setMessage] = useState<string | null>(null)
  /**
   * Monotonic preview request id: the newest dispatch wins and everything else
   * is dropped on settle (U3). Bumped on close too, so a read that settles
   * after the surface is gone can neither paint nor become applicable.
   */
  const requestSeq = useRef(0)

  const parsed = useMemo(() => parseRepairPlan(draft), [draft])
  const plan = parsed.ok ? parsed.plan : null

  const refusal = useMemo(() => {
    if (!parsed.ok) return { code: parsed.refusal.code, message: parsed.refusal.message }
    return seam.validatePlan(parsed.plan)
  }, [parsed, seam])

  const facts = seam.facts()
  const budgetRefusal =
    plan !== null && facts !== null
      ? repairBudgetRefusalFor(facts.liveRows, facts.repairPairs, plan.mapping.size)
      : null

  const previewStale =
    preview.kind === 'ready' &&
    captureIsStale(preview.preview.tag, seam.captureTag(preview.preview.plan.column))

  const previewOutdated =
    plan !== null &&
    (preview.kind === 'ready'
      ? repairPlanFingerprint(plan) !== preview.preview.fingerprint
      : preview.kind === 'loading' || preview.kind === 'failed'
        ? repairPlanFingerprint(plan) !== preview.fingerprint
        : false)

  /** The one reason Apply is unavailable, in the order the user meets them. */
  let applyBlockedReason: string | null = null
  if (preview.kind !== 'ready') {
    applyBlockedReason =
      preview.kind === 'loading' ? REPAIR_PREVIEW_LOADING : REPAIR_REFUSAL_NO_PREVIEW
  } else if (plan === null || previewOutdated) {
    applyBlockedReason = REPAIR_PREVIEW_OUTDATED
  } else if (previewStale) {
    applyBlockedReason = REPAIR_PREVIEW_STALE
  } else if (preview.preview.counts.affected <= 0) {
    applyBlockedReason = REPAIR_REFUSAL_ZERO_AFFECTED
  }

  /**
   * Preview stays available while a read is in flight: a slow read must never
   * trap the surface, and the generation guard — not a disabled control — is
   * what decides whose result wins (the CSV review's rule, and the host half of
   * U3). A refusal or an over-envelope plan is the only thing that blocks it.
   */
  const canPreview = open && plan !== null && refusal === null && budgetRefusal === null

  const update = useCallback((patch: Partial<RepairPlanDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setMessage(null)
  }, [])

  const openDialog = useCallback((): void => {
    requestSeq.current += 1
    setOpen(true)
    setMessage(null)
  }, [])

  const closeDialog = useCallback((): void => {
    // Drop every in-flight read: nothing may land after the surface closes.
    requestSeq.current += 1
    setOpen(false)
    setMessage(null)
    setPreview(IDLE)
    setDraft(EMPTY_REPAIR_DRAFT)
  }, [])

  const runPreview = useCallback((): void => {
    if (plan === null || refusal !== null || budgetRefusal !== null) return
    const tag = seam.captureTag(plan.column)
    if (tag === null) return
    const fingerprint = repairPlanFingerprint(plan)
    requestSeq.current += 1
    const requestId = requestSeq.current
    setMessage(null)
    setPreview({ kind: 'loading', plan, fingerprint, requestId })
    void (async () => {
      try {
        const read = await seam.readPreview(plan)
        // U3: a superseded or cancelled read never publishes.
        if (requestSeq.current !== requestId) return
        setPreview({
          kind: 'ready',
          preview: assembleRepairPreview(plan, fingerprint, tag, read),
        })
      } catch (error) {
        if (requestSeq.current !== requestId) return
        // The operation's own framing: the engine's honest first line where the
        // bundle carries one, a value-free summary where it does not (never a
        // classification from glue text — ADR 0048).
        setPreview({
          kind: 'failed',
          plan,
          fingerprint,
          message: engineErrorMessage('repair-preview', error),
        })
      }
    })()
  }, [plan, refusal, budgetRefusal, seam])

  const applyPreview = useCallback((): void => {
    if (preview.kind !== 'ready') {
      setMessage(REPAIR_REFUSAL_NO_PREVIEW)
      return
    }
    if (plan === null || repairPlanFingerprint(plan) !== preview.preview.fingerprint) {
      setMessage(REPAIR_PREVIEW_OUTDATED)
      return
    }
    if (captureIsStale(preview.preview.tag, seam.captureTag(preview.preview.plan.column))) {
      setMessage(REPAIR_PREVIEW_STALE)
      return
    }
    if (preview.preview.counts.affected <= 0) {
      setMessage(REPAIR_REFUSAL_ZERO_AFFECTED)
      return
    }
    seam.apply(preview.preview.plan, {
      tag: preview.preview.tag,
      affected: preview.preview.counts.affected,
    })
    // The publication is one history entry; the surface closes with the
    // preview it just committed so a second click cannot re-send it.
    requestSeq.current += 1
    setOpen(false)
    setMessage(null)
    setPreview(IDLE)
    setDraft(EMPTY_REPAIR_DRAFT)
  }, [preview, plan, seam])

  return {
    open,
    draft,
    parsed,
    refusal,
    budgetRefusal,
    preview,
    previewStale,
    previewOutdated,
    applyBlockedReason,
    message,
    canPreview,
    canApply: open && applyBlockedReason === null,
    pairCount: plan === null ? 0 : plan.mapping.size,
    trimCodePoints: plan === null || plan.trim === undefined ? 0 : [...plan.trim].length,
    openDialog,
    closeDialog,
    update,
    runPreview,
    applyPreview,
  }
}
