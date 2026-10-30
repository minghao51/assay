// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseContract } from '@assay/contracts'
import { emptyHistory } from '@assay/domain'
import type { EngineComparisonHandle, EngineDatasetProfile } from '@assay/engine-duckdb'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { useDiffSession } from './useDiffSession'
import { useValidationSession } from './useValidationSession'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * UG-25 / UG-30 call-site pins for the read-only sessions.
 *
 * `engineRejectionMessage` says "The engine rejected this **edit**…" — copy
 * that is honest for the editing session and nonsense in Validation/Compare
 * (the m5-3/m6-4 panels reused it, producing "Validation failed: The engine
 * rejected this edit…"). These tests drive the REAL hooks with only the engine
 * boundary faked and pin the framed, single-line, edit-free message each
 * session hands its panel.
 */

const h = vi.hoisted(() => ({
  validate: vi.fn(),
  stageComparison: vi.fn(),
  open: vi.fn(),
  profile: vi.fn(),
  diff: vi.fn(),
}))

vi.mock('../lib/engine', () => ({
  engineClient: {
    validate: h.validate,
    stageComparison: h.stageComparison,
    open: h.open,
    profile: h.profile,
    diff: h.diff,
  },
}))

/** A realistic multi-line engine diagnostic (summary + composed SQL tail). */
const MULTILINE = new Error(
  'the validation row-key query failed to execute\n' +
    'LINE 1: SELECT * FROM "assay_validation_target" WHERE "country" = \'SG\'',
)

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [{ name: 'id', type: 'BIGINT' }],
  baseRowCount: 2,
}

const PHASE: Phase = {
  kind: 'ready',
  model: {} as unknown as GridViewportModel,
  tableId: 't1',
  handle: { kind: 'table', id: 't1' },
  base: BASE,
  provider: {} as never,
}

const SESSION: DatasetSession = {
  tokenRef: { current: 1 },
  beginSession: () => 1,
  registerReset: () => () => {},
}

const HISTORY_REF: { current: TransformationHistory } = { current: emptyHistory() }

/** The committed-shape native contract (dataset.min-rows needs no column). */
const CONTRACT = parseContract(
  'format: v1\nname: session-pin\nversion: 1\ndataset:\n  min-rows: 1\n',
)
if (!CONTRACT.ok) throw new Error('the session-pin contract fixture must parse')

const PROFILE: EngineDatasetProfile = {
  rowCount: 2,
  columns: [
    {
      name: 'id',
      type: 'BIGINT',
      kind: 'numeric',
      nullCount: 0,
      distinctCount: 2,
    },
  ],
}

const COMPARISON: EngineComparisonHandle = {
  kind: 'comparison',
  id: 'c1',
  schema: [{ name: 'id', type: 'BIGINT' }],
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UG-25 — validation session error copy', () => {
  it('frames a failed validation run without the edit-domain wording', async () => {
    h.validate.mockRejectedValue(MULTILINE)
    const { result } = renderHook(() =>
      useValidationSession({
        phase: PHASE,
        session: SESSION,
        historyRef: HISTORY_REF,
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )

    act(() => {
      result.current.handleContractDocument(CONTRACT.contract)
    })
    act(() => {
      result.current.handleValidate()
    })

    await waitFor(() => {
      expect(result.current.validationRun.kind).toBe('failed')
    })
    const run = result.current.validationRun
    if (run.kind !== 'failed') throw new Error('expected a failed validation run')
    expect(run.message).toBe(
      'the validation row-key query failed to execute. The previous validation view is unchanged.',
    )
    expect(run.message).not.toContain('edit')
    expect(run.message).not.toMatch(/\r|\n/)
    expect(run.message).not.toContain('LINE 1')
  })
})

describe('UG-25 — diff session error copy', () => {
  function renderDiff() {
    return renderHook(() =>
      useDiffSession({
        phase: PHASE,
        session: SESSION,
        historyRef: HISTORY_REF,
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )
  }

  it('frames a failed comparison staging without the edit-domain wording', async () => {
    h.stageComparison.mockRejectedValue(MULTILINE)
    const { result } = renderDiff()

    act(() => {
      result.current.handleComparisonFile(new File(['id\n1\n'], 'comparison.csv'))
    })

    await waitFor(() => {
      expect(result.current.comparisonState.kind).toBe('failed')
    })
    const staging = result.current.comparisonState
    if (staging.kind !== 'failed') throw new Error('expected a failed comparison stage')
    expect(staging.message).toBe(
      'the validation row-key query failed to execute. The previous comparison view is unchanged.',
    )
    expect(staging.message).not.toContain('edit')
    expect(staging.message).not.toMatch(/\r|\n/)
  })

  it('frames a failed row diff without the edit-domain wording', async () => {
    h.stageComparison.mockResolvedValue(COMPARISON)
    h.open.mockResolvedValue({ kind: 'table', id: 't2' })
    h.profile.mockResolvedValue(PROFILE)
    h.diff.mockRejectedValue(MULTILINE)
    const { result } = renderDiff()

    act(() => {
      result.current.handleComparisonFile(new File(['id\n1\n'], 'comparison.csv'))
    })
    await waitFor(() => {
      expect(result.current.comparisonState.kind).toBe('staged')
    })

    act(() => {
      result.current.handleRunDiff(['id'], 'explicit', null)
    })

    await waitFor(() => {
      expect(result.current.diffRun.kind).toBe('failed')
    })
    const run = result.current.diffRun
    if (run.kind !== 'failed') throw new Error('expected a failed row diff')
    expect(run.message).toBe(
      'the validation row-key query failed to execute. The previous comparison view is unchanged.',
    )
    expect(run.message).not.toContain('edit')
    expect(run.message).not.toMatch(/\r|\n/)
  })
})
