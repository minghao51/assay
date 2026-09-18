// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExportDialog } from './ExportDialog'
import type { ExportDialogProps } from './ExportDialog'

afterEach(cleanup)

function renderDialog(overrides: Partial<ExportDialogProps> = {}) {
  const props: ExportDialogProps = {
    rowCount: 6,
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

describe('ExportDialog — closing', () => {
  it('invokes onClose', () => {
    const props = renderDialog()
    fireEvent.click(screen.getByTestId('export-close'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
