// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContractV1 } from '@assay/contracts'
import type { ValidationReport, ValidationReportRow } from './report-model'
import { buildStarterContract } from './starter-contract'
import { filterReplacementCopy, ValidationPanel } from './ValidationPanel'
import type { ContractState, ValidationPanelProps, ValidationRunState } from './ValidationPanel'

/**
 * ug-20 component pins:
 * - the validation zero state offers a starter-contract download built from
 *   the open schema, disabled with no schema, absent in every non-none
 *   contract state, and delivered as a new file through the injected seam;
 * - an ENABLED "Show only failing rows" control discloses that it replaces
 *   the active filters (singular/plural), absent at 0 and absent on the
 *   disabled partial/not-expressible variants.
 */

const COLUMNS = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'region', type: 'VARCHAR' },
]

const CONTRACT: ContractV1 = {
  format: 'v1',
  metadata: { name: 'orders-basic', version: 1 },
  columns: [{ name: 'order_id', type: 'BIGINT' }],
  dataset: { minRows: 1 },
}

function row(
  ruleId: string,
  filter: ValidationReportRow['filter'],
  column = 'order_id',
): ValidationReportRow {
  return {
    ruleId,
    column,
    kind: 'required',
    label: 'Required (no NULLs)',
    failCount: 1,
    failPercent: 14,
    failing: true,
    outcome: 'row-samples',
    samples: [],
    samplesComplete: filter.kind !== 'partial',
    filter,
  }
}

function report(): ValidationReport {
  return {
    valid: false,
    rowCount: 7,
    rows: [
      row('columns[0].required', { kind: 'ready', predicate: 'IS NULL' }),
      row('columns[1].required', { kind: 'ready', predicate: 'IS NULL' }, 'region'),
      row('columns[0].unique', {
        kind: 'partial',
        samplesReturned: 100,
        failCount: 110,
      }),
      row('columns[0].min-distinct-share', { kind: 'not-expressible' }),
    ],
  }
}

interface Overrides {
  readonly contractState?: ContractState
  readonly runState?: ValidationRunState
  readonly datasetColumns?: readonly { readonly name: string; readonly type: string }[]
  readonly activeFilterCount?: number
  readonly deliverStarterContract?: ValidationPanelProps['deliverStarterContract']
}

function renderPanel(overrides: Overrides = {}): void {
  const contractState = overrides.contractState ?? { kind: 'none' }
  const runState = overrides.runState ?? { kind: 'idle' }
  render(
    <ValidationPanel
      contractState={contractState}
      runState={runState}
      stale={false}
      jumpError={null}
      filterError={null}
      datasetColumns={overrides.datasetColumns ?? COLUMNS}
      activeFilterCount={overrides.activeFilterCount ?? 0}
      onContractFile={() => {}}
      onValidate={() => {}}
      onCancelValidate={() => {}}
      onJumpToSample={() => {}}
      onFilterToFailures={() => {}}
      requestReportDestination={async () => null}
      deliverReportCopy={async () => 'download'}
      deliverStarterContract={overrides.deliverStarterContract}
    />,
  )
}

afterEach(cleanup)

describe('starter contract zero state', () => {
  it('builds and delivers exactly the canonical starter through the injected seam', () => {
    const deliver = vi.fn()
    renderPanel({ deliverStarterContract: deliver })

    const button = screen.getByTestId('validation-starter-contract')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.textContent).toBe('Download a starter contract')
    expect(screen.getByTestId('validation-contract-none')).toBeTruthy()
    expect(
      screen.getByText('A starter contract is a starting point — edit it before validating.'),
    ).toBeTruthy()
    expect(screen.queryByTestId('validation-starter-contract-status')).toBeNull()

    fireEvent.click(button)

    const built = buildStarterContract(COLUMNS)
    if (built === null) throw new Error('starter contract was not built')
    expect(deliver).toHaveBeenCalledTimes(1)
    const [bytes, fileName] = deliver.mock.calls[0] as [Uint8Array<ArrayBuffer>, string]
    expect(fileName).toBe('assay-starter-contract.yaml')
    expect(new TextDecoder().decode(bytes)).toBe(built.text)
    expect(screen.getByTestId('validation-starter-contract-status').textContent).toBe(
      'Starter contract downloaded — edit it, then open it here.',
    )
    expect(screen.getByTestId('validation-starter-contract-status').getAttribute('role')).toBe(
      'status',
    )
  })

  it('disables the starter download when the open schema is unavailable', () => {
    const deliver = vi.fn()
    renderPanel({ datasetColumns: [], deliverStarterContract: deliver })
    const button = screen.getByTestId('validation-starter-contract')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(deliver).not.toHaveBeenCalled()
    expect(screen.queryByTestId('validation-starter-contract-status')).toBeNull()
  })

  it.each<[string, ContractState]>([
    ['loaded', { kind: 'loaded', contract: CONTRACT }],
    [
      'parse-error',
      {
        kind: 'parse-error',
        errors: [{ code: 'wrong-type', message: 'bad', path: 'document', line: 1, column: 1 }],
      },
    ],
    ['too-large', { kind: 'too-large' }],
    ['read-failed', { kind: 'read-failed', message: 'gone' }],
  ])('is absent in the %s contract state', (_label, contractState) => {
    renderPanel({ contractState })
    expect(screen.queryByTestId('validation-starter-contract')).toBeNull()
    expect(screen.queryByTestId('validation-starter-contract-status')).toBeNull()
  })

  it('retires the downloaded status when a contract is loaded', () => {
    const deliver = vi.fn()
    const view = render(
      <ValidationPanel
        contractState={{ kind: 'none' }}
        runState={{ kind: 'idle' }}
        stale={false}
        jumpError={null}
        filterError={null}
        datasetColumns={COLUMNS}
        activeFilterCount={0}
        onContractFile={() => {}}
        onValidate={() => {}}
        onCancelValidate={() => {}}
        onJumpToSample={() => {}}
        onFilterToFailures={() => {}}
        requestReportDestination={async () => null}
        deliverReportCopy={async () => 'download'}
        deliverStarterContract={deliver}
      />,
    )
    fireEvent.click(screen.getByTestId('validation-starter-contract'))
    expect(screen.getByTestId('validation-starter-contract-status')).toBeTruthy()

    view.rerender(
      <ValidationPanel
        contractState={{ kind: 'loaded', contract: CONTRACT }}
        runState={{ kind: 'idle' }}
        stale={false}
        jumpError={null}
        filterError={null}
        datasetColumns={COLUMNS}
        activeFilterCount={0}
        onContractFile={() => {}}
        onValidate={() => {}}
        onCancelValidate={() => {}}
        onJumpToSample={() => {}}
        onFilterToFailures={() => {}}
        requestReportDestination={async () => null}
        deliverReportCopy={async () => 'download'}
        deliverStarterContract={deliver}
      />,
    )
    expect(screen.queryByTestId('validation-starter-contract')).toBeNull()
    expect(screen.queryByTestId('validation-starter-contract-status')).toBeNull()
  })
})

describe('filter-replacement disclosure', () => {
  function renderVerdict(activeFilterCount: number): void {
    renderPanel({
      contractState: { kind: 'loaded', contract: CONTRACT },
      runState: { kind: 'verdict', report: report(), revision: 0 },
      activeFilterCount,
    })
  }

  it('is absent when no filters are active', () => {
    renderVerdict(0)
    expect(screen.queryByTestId('validation-filter-replacement')).toBeNull()
    expect(screen.getAllByTestId('validation-filter-failures')).toHaveLength(4)
  })

  it('states the singular replacement on every enabled control at 1', () => {
    renderVerdict(1)
    const notes = screen.getAllByTestId('validation-filter-replacement')
    expect(notes).toHaveLength(2)
    for (const note of notes) {
      expect(note.textContent).toBe('Replaces the current 1 filter')
      expect(note.getAttribute('role')).toBe('note')
    }
  })

  it('states the plural replacement on every enabled control at 2', () => {
    renderVerdict(2)
    const notes = screen.getAllByTestId('validation-filter-replacement')
    expect(notes).toHaveLength(2)
    for (const note of notes) {
      expect(note.textContent).toBe('Replaces the current 2 filters')
    }
    // The disabled partial/not-expressible variants never carry the note.
    const controls = screen.getAllByTestId('validation-filter-failures')
    expect(controls.filter((control) => (control as HTMLButtonElement).disabled)).toHaveLength(2)
    expect(filterReplacementCopy(1)).toBe('Replaces the current 1 filter')
    expect(filterReplacementCopy(2)).toBe('Replaces the current 2 filters')
  })

  it('keeps the button accessible name unchanged', () => {
    renderVerdict(2)
    for (const button of screen.getAllByRole('button', { name: 'Show only failing rows' })) {
      expect(button).toBeTruthy()
    }
  })
})
