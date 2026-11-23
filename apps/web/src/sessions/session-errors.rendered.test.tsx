// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyHistory } from '@assay/domain'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import type { EngineComparisonHandle, EngineDatasetProfile } from '@assay/engine-duckdb'
import type { GridViewportModel } from '@assay/grid'
import { DiffPanel } from '../diff/DiffPanel'
import { ValidationPanel } from '../validation/ValidationPanel'
import type { SaveStrategy } from '../export/save-destination'
import { useDiffSession } from './useDiffSession'
import { useValidationSession } from './useValidationSession'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * UG-25 rendered-text pins (reviewer item 3). `session-errors.test.tsx` pins
 * the message each hook hands its panel, but the panel JSX adds static
 * prefixes/suffixes around it. These tests render the REAL panels (driven by
 * the REAL hooks, with only the engine boundary faked) and assert the final
 * rendered alert text: no "edit" wording and no newline survive into the DOM.
 */

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
  beginSession: () => ({ token: 1, faults: [] }),
  registerReset: () => () => {},
}

const HISTORY_REF: { current: TransformationHistory } = { current: emptyHistory() }

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

const CONTRACT_YAML = 'format: v1\nname: rendered-pin\nversion: 1\ndataset:\n  min-rows: 1\n'

const h = vi.hoisted(() => ({
  validate: vi.fn(),
  stageComparison: vi.fn(),
  open: vi.fn(),
  profile: vi.fn(),
  profileComparison: vi.fn(),
  diff: vi.fn(),
}))

vi.mock('../lib/engine', () => ({
  engineClient: {
    validate: h.validate,
    stageComparison: h.stageComparison,
    open: h.open,
    profile: h.profile,
    profileComparison: h.profileComparison,
    diff: h.diff,
  },
}))

const deliverReportCopy = async (): Promise<SaveStrategy> => 'download'

/**
 * Resolve the status element once it has become this state's `role="alert"`.
 * The running state reuses the same testid with `role="status"`, so a bare
 * `findByTestId` can hand back the element that is about to be replaced.
 */
async function findByRoleAlert(testId: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByTestId(testId).getAttribute('role')).toBe('alert')
  })
  return screen.getByTestId(testId)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** The real validation hook + the real validation panel, no prop fakes. */
function ValidationHarness(): React.ReactElement {
  const session = useValidationSession({
    phase: PHASE,
    session: SESSION,
    historyRef: HISTORY_REF,
    overlayRef: { current: null },
    overlayRevision: 0,
    sourceIdentityRef: { current: null },
    navigateToRow: () => {},
  })
  return (
    <ValidationPanel
      contractState={session.contractState}
      runState={session.validationRun}
      stale={session.validationStale}
      jumpError={session.jumpError}
      filterError={session.filterToFailuresError}
      datasetColumns={[]}
      activeFilterCount={0}
      onContractFile={session.handleContractFile}
      onValidate={session.handleValidate}
      onCancelValidate={session.handleCancelValidate}
      onJumpToSample={session.handleJumpToSample}
      onFilterToFailures={session.handleFilterToFailures}
      requestReportDestination={session.requestReportDestinationForPanel}
      deliverReportCopy={deliverReportCopy}
    />
  )
}

/** The real diff hook + the real diff panel, no prop fakes. */
function DiffHarness(): React.ReactElement {
  const session = useDiffSession({
    phase: PHASE,
    session: SESSION,
    historyRef: HISTORY_REF,
    overlayRef: { current: null },
    overlayRevision: 0,
    sourceIdentityRef: { current: null },
    navigateToRow: () => {},
  })
  return (
    <DiffPanel
      comparison={session.comparisonState}
      runState={session.diffRun}
      stale={session.diffStale}
      jumpError={session.diffJumpError}
      onComparisonFile={session.handleComparisonFile}
      onRunDiff={session.handleRunDiff}
      onCancelDiff={session.handleCancelDiff}
      onJumpToSample={session.handleJumpToDiffSample}
      requestReportDestination={session.requestDiffReportDestinationForPanel}
      deliverReportCopy={deliverReportCopy}
    />
  )
}

describe('UG-25 rendered pins — the panel alert text is edit-free and single-line', () => {
  it('renders a failed validation run without the edit wording or a newline', async () => {
    h.validate.mockRejectedValue(MULTILINE)
    render(<ValidationHarness />)

    // Import a contract through the panel's own picker, then run it through
    // the panel's own Validate control — the rendered path end to end.
    act(() => {
      fireEvent.change(screen.getByTestId('validation-contract-input'), {
        target: { files: [new File([CONTRACT_YAML], 'rendered-pin.contract.yaml')] },
      })
    })
    await screen.findByTestId('validation-contract-info')

    act(() => {
      fireEvent.click(screen.getByTestId('validation-run'))
    })

    const alert = await findByRoleAlert('validation-status')
    expect(alert.textContent).toBe(
      'Validation failed: the validation row-key query failed to execute. ' +
        'The previous validation view is unchanged. No verdict was changed.',
    )
    // The rendered DOM text, not just the hook message: no "edit" wording, no
    // newline/separator (every break shape), no composed-SQL tail.
    const rendered = alert.textContent ?? ''
    expect(rendered).not.toMatch(/edit/i)
    expect(rendered).not.toMatch(/\r|\n|\v|\f|\u0085|\u2028|\u2029/)
    expect(rendered).not.toContain('LINE 1')
    expect(rendered).not.toContain('rejected this edit')
  })

  it('renders a failed row diff without the edit wording or a newline', async () => {
    h.stageComparison.mockResolvedValue(COMPARISON)
    h.profile.mockResolvedValue(PROFILE)
    h.profileComparison.mockResolvedValue(PROFILE)
    h.diff.mockRejectedValue(MULTILINE)
    render(<DiffHarness />)

    // Stage the comparison through the panel's own picker.
    act(() => {
      fireEvent.change(screen.getByTestId('diff-comparison-input'), {
        target: { files: [new File(['id\n1\n'], 'rendered-pin.csv')] },
      })
    })
    await screen.findByTestId('diff-comparison-info')

    // Confirm explicit keys through the panel's own key control, then run.
    act(() => {
      fireEvent.change(screen.getByTestId('diff-key-manual-input'), {
        target: { value: 'id' },
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('diff-run').hasAttribute('disabled')).toBe(false)
    })

    act(() => {
      fireEvent.click(screen.getByTestId('diff-run'))
    })

    const alert = await findByRoleAlert('diff-status')
    expect(alert.textContent).toBe(
      'The row diff failed: the validation row-key query failed to execute. ' +
        'The previous comparison view is unchanged. No result was changed.',
    )
    const rendered = alert.textContent ?? ''
    expect(rendered).not.toMatch(/edit/i)
    expect(rendered).not.toMatch(/\r|\n|\v|\f|\u0085|\u2028|\u2029/)
    expect(rendered).not.toContain('LINE 1')
    expect(rendered).not.toContain('rejected this edit')
  })
})
