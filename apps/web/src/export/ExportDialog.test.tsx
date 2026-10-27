// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EngineExportResult } from '@assay/engine-duckdb'
import { ExportDialog } from './ExportDialog'
import type { ExportDialogProps } from './ExportDialog'

afterEach(cleanup)

function renderDialog(overrides: Partial<ExportDialogProps> = {}) {
  const props: ExportDialogProps = {
    rowCount: 6,
    activeOperationCount: 0,
    viewFiltered: false,
    viewSorted: false,
    runEngineExport: vi.fn(async (format) => ({
      path: `assay-exports/assay-export-1.${format}`,
      format,
      rowCount: 6,
      bytes: 1536,
    })),
    requestDestination: vi.fn(async () => ({ via: 'download' }) as const),
    writeCopy: vi.fn(async () => 'download' as const),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<ExportDialog {...props} />)
  return props
}

describe('ExportDialog — copy-vs-rewrite wording (ADR 0012)', () => {
  it('says it writes a new file and that the opened file is not changed', () => {
    renderDialog()
    const notice = screen.getByTestId('export-copy-notice')
    expect(notice.textContent).toContain('new file')
    expect(notice.textContent).toContain('The opened file is not changed')
    expect(document.body.textContent ?? '').not.toMatch(/overwrit|in place|in-place/i)
  })

  it('omits the staged-operation line when the active history prefix is empty', () => {
    renderDialog({ activeOperationCount: 0 })
    expect(screen.queryByTestId('export-staged-count')).toBeNull()
  })

  it('uses singular grammar for one staged operation', () => {
    renderDialog({ activeOperationCount: 1 })
    expect(screen.getByTestId('export-staged-count').textContent).toBe(
      'Includes 1 staged change — review in History',
    )
  })

  it('uses plural grammar for multiple staged operations', () => {
    renderDialog({ activeOperationCount: 7 })
    expect(screen.getByTestId('export-staged-count').textContent).toBe(
      'Includes 7 staged changes — review in History',
    )
  })

  it('describes the current edited view using the engine-backed row count', () => {
    renderDialog({ rowCount: 6 })
    expect(screen.getByTestId('export-view-rows').textContent).toBe('6 rows')
  })

  it('states honestly that the engine exposes no user-adjustable options', () => {
    renderDialog()
    expect(screen.getByTestId('export-options-note').textContent).toContain(
      'no user-adjustable options',
    )
  })

  it('says the export is the complete dataset, in natural order, without filters or sorting', () => {
    renderDialog({ rowCount: 5 })
    const note = screen.getByTestId('export-view-note').textContent ?? ''
    expect(note).toContain('complete edited dataset')
    expect(note).toContain('all 5 rows')
    expect(note).toContain('natural order')
    expect(note).toContain('filters and sorting are not applied')
    expect(screen.queryByTestId('export-filtered-note')).toBeNull()
  })
})

describe('ExportDialog — view-state copy describes filters and sorting separately (m4-5 fix round 2)', () => {
  it('names the filtered subset when only a filter is active', () => {
    // The grid may show a filtered subset while the export holds every row;
    // the dialog must never let the two be conflated (m4-5 review finding).
    renderDialog({ rowCount: 5, viewFiltered: true, viewSorted: false })
    expect(screen.getByTestId('export-view-rows').textContent).toBe('5 rows')
    const note = screen.getByTestId('export-filtered-note').textContent ?? ''
    expect(note).toContain('filtered subset')
    expect(note).toContain('contains every row')
    expect(note).toMatch(/filters/)
    // Filter-only: no claim about sorting.
    expect(note).not.toMatch(/sort/i)
    expect(document.body.textContent ?? '').not.toMatch(/overwrit|in place|in-place/i)
  })

  it('says the sorting is not applied — and never mentions filters — when only a sort is active', () => {
    // Round-2 pin: a sort-only view used to claim a "filtered/sorted
    // subset" and refer to active filters that do not exist.
    renderDialog({ rowCount: 5, viewFiltered: false, viewSorted: true })
    expect(screen.getByTestId('export-view-rows').textContent).toBe('5 rows')
    const note = screen.getByTestId('export-filtered-note').textContent ?? ''
    expect(note).toContain('sorted')
    expect(note).toContain('not applied to the copy')
    expect(note).toContain('contains every row')
    expect(note).not.toMatch(/filter/i)
    expect(document.body.textContent ?? '').not.toMatch(/overwrit|in place|in-place/i)
  })

  it('names the filtered/sorted subset when both are active', () => {
    renderDialog({ rowCount: 5, viewFiltered: true, viewSorted: true })
    expect(screen.getByTestId('export-view-rows').textContent).toBe('5 rows')
    const note = screen.getByTestId('export-filtered-note').textContent ?? ''
    expect(note).toContain('filtered/sorted subset')
    expect(note).toContain('contains every row')
  })
})

describe('ExportDialog — format selection state machine', () => {
  it('defaults to Parquet and passes the chosen format to the engine', async () => {
    const props = renderDialog()
    expect((screen.getByTestId('export-format-parquet') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByTestId('export-format-csv'))
    expect((screen.getByTestId('export-format-csv') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('export-format-description').textContent).toContain('apostrophe')

    fireEvent.click(screen.getByTestId('export-confirm'))
    await screen.findByTestId('export-result')
    expect(props.runEngineExport).toHaveBeenCalledWith('csv')
    expect(props.requestDestination).toHaveBeenCalledWith('csv')
    expect(props.writeCopy).toHaveBeenCalledTimes(1)
  })

  it('reports the engine numbers — format, rows, and size — for the copy', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('export-format-csv'))
    fireEvent.click(screen.getByTestId('export-confirm'))
    const result = await screen.findByTestId('export-result')
    expect(result.textContent).toBe(
      'Exported 6 rows as CSV (1.5 KB) — your browser is downloading it as a new file. The opened file is unchanged.',
    )
    expect(screen.getByTestId('export-reopen-hint')).toBeTruthy()
  })

  it('offers the re-open journey for csv, which the engine can read back', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('export-format-csv'))
    fireEvent.click(screen.getByTestId('export-confirm'))
    const hint = await screen.findByTestId('export-reopen-hint')
    expect(hint.textContent).toContain('Open a data file')
  })

  it('never promises a re-open for arrow — it is an interchange format for other tools', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('export-format-arrow'))
    fireEvent.click(screen.getByTestId('export-confirm'))
    const hint = await screen.findByTestId('export-reopen-hint')
    expect(hint.textContent).toContain('interchange format for other tools')
    expect(hint.textContent).toContain('.parquet, .csv, .jsonl and .json')
    expect(hint.textContent).not.toContain('Open a data file')
    expect(hint.textContent).not.toContain('choose the file you wrote')
  })
})

describe('ExportDialog — cancel and failure paths leave the app usable', () => {
  it('reports cancellation and never runs the engine when the save picker is dismissed', async () => {
    const props = renderDialog({
      requestDestination: vi.fn(async () => null),
    })
    fireEvent.click(screen.getByTestId('export-confirm'))
    const cancelled = await screen.findByTestId('export-cancelled')
    expect(cancelled.textContent).toContain('no new file was written')
    expect(props.runEngineExport).not.toHaveBeenCalled()
    expect((screen.getByTestId('export-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('surfaces a scratch/save failure readably and keeps the controls usable', async () => {
    renderDialog({
      writeCopy: vi.fn(async () => {
        throw new Error('scratch entry missing')
      }),
    })
    fireEvent.click(screen.getByTestId('export-confirm'))
    const error = await screen.findByTestId('export-error')
    expect(error.textContent).toContain('Export failed: scratch entry missing')
    expect(error.textContent).toContain('the opened file is unchanged')
    expect((screen.getByTestId('export-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('surfaces an engine export rejection readably', async () => {
    renderDialog({
      runEngineExport: vi.fn(async () => {
        throw new Error('COPY failed')
      }),
    })
    fireEvent.click(screen.getByTestId('export-confirm'))
    expect((await screen.findByTestId('export-error')).textContent).toContain(
      'Export failed: COPY failed',
    )
  })
})

describe('ExportDialog — same-source refusal (m4-5 fix round)', () => {
  it('refuses before any engine work when the destination is the opened source', async () => {
    const props = renderDialog({
      requestDestination: vi.fn(async () => ({ via: 'refused-source' }) as const),
    })
    fireEvent.click(screen.getByTestId('export-confirm'))
    const refused = await screen.findByTestId('export-refused')
    expect(refused.textContent).toContain('That is the opened file')
    expect(refused.textContent).toContain('would change the source')
    expect(refused.textContent).toContain('Choose a different name or location')
    expect(refused.textContent).toContain('Nothing was written')
    // Refusal precedes engine work and byte writes: no export op, no copy.
    expect(props.runEngineExport).not.toHaveBeenCalled()
    expect(props.writeCopy).not.toHaveBeenCalled()
    // The dialog stays usable — the user can pick a different destination.
    expect((screen.getByTestId('export-confirm') as HTMLButtonElement).disabled).toBe(false)
    expect(document.body.textContent ?? '').not.toMatch(/overwrit|in place|in-place/i)
  })

  it('renders no refusal when the destination is a different file', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('export-confirm'))
    await screen.findByTestId('export-result')
    expect(screen.queryByTestId('export-refused')).toBeNull()
  })
})

describe('ExportDialog — closing', () => {
  it('invokes onClose', () => {
    const props = renderDialog()
    fireEvent.click(screen.getByTestId('export-close'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ExportDialog — Escape during an in-flight export (au3-9/S6)', () => {
  it('ignores Escape while working, lets the export finish, and shows the result line', async () => {
    // Deferred engine call: the dialog stays in `working` while Escape is
    // pressed, exactly the audit drill (Escape used to unmount the dialog
    // while the in-flight run() kept writing the export).
    let settleExport: (result: EngineExportResult) => void = () => {}
    const runEngineExport = vi.fn(
      () =>
        new Promise<EngineExportResult>((resolve) => {
          settleExport = resolve
        }),
    )
    const props = renderDialog({ runEngineExport })

    fireEvent.click(screen.getByTestId('export-confirm'))
    // Wait until the engine call is actually in flight (past the save picker).
    await waitFor(() => {
      expect(runEngineExport).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('export-progress')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    // Escape was ignored: the dialog is still mounted and was not closed.
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('export-dialog')).toBeTruthy()

    // The in-flight export still settles, the byte write still runs, and the
    // result line becomes visible.
    settleExport({
      path: 'assay-exports/assay-export-1.parquet',
      format: 'parquet',
      rowCount: 6,
      bytes: 1536,
    })
    const result = await screen.findByTestId('export-result')
    expect(result.textContent).toContain('Exported 6 rows as Parquet')
    expect(props.writeCopy).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('still closes immediately on Escape when no export is running', () => {
    const props = renderDialog()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
