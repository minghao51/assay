import { describe, expect, it } from 'vitest'
import {
  EXPORT_CANCELLED_MESSAGE,
  exportErrorSummary,
  exportFailureMessage,
  exportSuccessMessage,
  formatBytes,
  formatRowCount,
} from './messages'

describe('formatBytes — honest binary sizes', () => {
  it('renders bytes, KB with one decimal, and larger units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('never fabricates a size for non-finite or negative input', () => {
    expect(formatBytes(Number.NaN)).toBe('unknown size')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('unknown size')
    expect(formatBytes(-1)).toBe('unknown size')
  })
})

describe('formatRowCount — honest pluralization', () => {
  it('distinguishes one row from many', () => {
    expect(formatRowCount(1)).toBe('1 row')
    expect(formatRowCount(0)).toBe('0 rows')
    expect(formatRowCount(6)).toBe('6 rows')
  })
})

describe('exportSuccessMessage — copy, never rewrite (ADR 0012)', () => {
  it('names the engine format/rows/bytes for a File System Access write', () => {
    const message = exportSuccessMessage(
      { path: 'assay-exports/x.csv', format: 'csv', rowCount: 6, bytes: 1536 },
      'file-system-access',
    )
    expect(message).toBe(
      'Exported 6 rows as CSV (1.5 KB) to a new file. The opened file is unchanged.',
    )
  })

  it('states the browser is downloading a NEW file on the fallback path', () => {
    const message = exportSuccessMessage(
      { path: 'assay-exports/x.jsonl', format: 'jsonl', rowCount: 1, bytes: 20 },
      'download',
    )
    expect(message).toBe(
      'Exported 1 row as JSON Lines (20 B) — your browser is downloading it as a new file. The opened file is unchanged.',
    )
  })

  it('never implies an in-place rewrite', () => {
    const messages = [
      exportSuccessMessage(
        { path: 'p', format: 'parquet', rowCount: 5, bytes: 10 },
        'file-system-access',
      ),
      exportSuccessMessage({ path: 'p', format: 'json', rowCount: 5, bytes: 10 }, 'download'),
      EXPORT_CANCELLED_MESSAGE,
      exportFailureMessage(new Error('boom')),
    ]
    for (const message of messages) {
      expect(message).not.toMatch(/overwrit|in place|in-place|update the source/i)
    }
    expect(EXPORT_CANCELLED_MESSAGE).toContain('no new file was written')
  })
})

describe('exportErrorSummary / exportFailureMessage — readable, never glue', () => {
  it('keeps only the first line of a multi-line engine error', () => {
    expect(exportErrorSummary(new Error('COPY failed\nline two\nline three'))).toBe('COPY failed')
  })

  it('degrades the opaque glue error and empty messages to a neutral summary', () => {
    expect(exportErrorSummary(new Error('_setThrew is not defined'))).toBe(
      'the engine could not write the copy',
    )
    expect(exportErrorSummary(new Error(''))).toBe('the engine could not write the copy')
    expect(exportErrorSummary('plain string failure')).toBe('plain string failure')
  })

  it('always states the source is unchanged', () => {
    expect(exportFailureMessage(new Error('disk full'))).toBe(
      'Export failed: disk full. No copy was written, and the opened file is unchanged.',
    )
  })
})
