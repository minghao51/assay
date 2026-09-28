// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffReport, KeyCandidate, KeyInferenceResult } from '@assay/diff'
import type { ComparisonState, DiffRunState } from './DiffPanel'
import { DiffPanel } from './DiffPanel'

/**
 * AU-3 au3-12 pin: the candidate list key must be injective over the rendered
 * items. Candidate evidence columns are not guaranteed unique (duplicate /
 * case-variant spellings can both be provable from hostile profiles), so a key
 * that is just the column name collides and React drops a row. The composite
 * `column:index` key keeps every candidate rendered and warning-free.
 */

const candidate = (column: string, disclosure: string): KeyCandidate => ({
  columns: [column],
  evidence: {
    column,
    typeA: 'BIGINT',
    typeB: 'BIGINT',
    rowCountA: 3,
    rowCountB: 3,
    nullCountA: 0,
    nullCountB: 0,
    distinctCountA: 3,
    distinctCountB: 3,
  },
  disclosure,
})

const EMPTY_DIFF: DiffReport = { schemaDrift: [], columnDeltas: [], issues: [] }

const staged = (candidates: readonly KeyCandidate[]): ComparisonState => {
  const inference: KeyInferenceResult = {
    candidates,
    disclosure: 'inference disclosure',
    issues: [],
  }
  return {
    kind: 'staged',
    schemaB: [],
    rowCountB: 3,
    baseColumnCount: 1,
    diff: EMPTY_DIFF,
    inference,
  }
}

const NOOP_RUN_STATE: DiffRunState = { kind: 'idle' }

function renderPanel(comparison: ComparisonState): void {
  render(
    <DiffPanel
      comparison={comparison}
      runState={NOOP_RUN_STATE}
      stale={false}
      jumpError={null}
      onComparisonFile={() => {}}
      onRunDiff={() => {}}
      onCancelDiff={() => {}}
      onJumpToSample={() => {}}
      requestReportDestination={async () => null}
      deliverReportCopy={async () => 'download'}
    />,
  )
}

afterEach(cleanup)

describe('DiffPanel key-candidate list', () => {
  it('renders every candidate without a duplicate-key warning when evidence columns collide', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderPanel(
        staged([
          candidate('dup', 'first disclosure'),
          // Same evidence column — the collision the key must survive.
          candidate('dup', 'second disclosure'),
        ]),
      )

      expect(screen.getAllByTestId('diff-key-candidate')).toHaveLength(2)
      expect(screen.getByText('first disclosure')).toBeTruthy()
      expect(screen.getByText('second disclosure')).toBeTruthy()
      const duplicateKeyWarnings = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes('same key'),
      )
      expect(duplicateKeyWarnings).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})
