import { describe, expect, it } from 'vitest'
import {
  EXPORT_CANCELLED_MESSAGE,
  EXPORT_SAME_SOURCE_MESSAGE,
  exportErrorSummary,
  exportFailureMessage,
  exportReopenGuidance,
  exportSuccessMessage,
  exportViewSubsetNote,
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

describe('exportReopenGuidance — per-format honesty (m4-5 fix round)', () => {
  it('offers the re-open journey only for the formats the engine can read back', () => {
    // The engine opens .parquet, .csv, .jsonl and .json — exactly these may
    // suggest the open flow as the way to view the copy.
    for (const format of ['parquet', 'csv', 'jsonl', 'json'] as const) {
      const guidance = exportReopenGuidance(format)
      expect(guidance).toContain('Open a data file')
      expect(guidance).toContain('choose the file you wrote')
    }
  })

  it('does not promise a re-open for arrow; names it an interchange format for other tools', () => {
    // The engine rejects .arrow on open ("unsupported dataset format"), so
    // the previous unconditional hint promised a journey that could not
    // happen. The arrow guidance must be honest instead.
    const guidance = exportReopenGuidance('arrow')
    expect(guidance).toContain('interchange format for other tools')
    expect(guidance).toContain('Assay opens .parquet, .csv, .jsonl and .json files')
    expect(guidance).not.toContain('Open a data file')
    expect(guidance).not.toContain('view it here')
    expect(guidance).not.toContain('choose the file you wrote')
  })
})

describe('EXPORT_SAME_SOURCE_MESSAGE — same-source refusal (m4-5 fix round)', () => {
  it('names the problem and the way out, and states nothing was written', () => {
    expect(EXPORT_SAME_SOURCE_MESSAGE).toContain('That is the opened file')
    expect(EXPORT_SAME_SOURCE_MESSAGE).toContain('would change the source')
    expect(EXPORT_SAME_SOURCE_MESSAGE).toContain('Choose a different name or location')
    expect(EXPORT_SAME_SOURCE_MESSAGE).toContain('Nothing was written')
    expect(EXPORT_SAME_SOURCE_MESSAGE).toContain('the opened file is unchanged')
  })

  it('never implies an in-place rewrite', () => {
    expect(EXPORT_SAME_SOURCE_MESSAGE).not.toMatch(/overwrit|in place|in-place/i)
  })
})

describe('exportViewSubsetNote — filters and sorting described separately (m4-5 fix round 2)', () => {
  it('is null for a plain view — no subset claim without a subset', () => {
    expect(exportViewSubsetNote(false, false)).toBeNull()
  })

  it('describes only the filter for a filter-only view', () => {
    const note = exportViewSubsetNote(true, false)
    expect(note).toContain('filtered subset')
    expect(note).toContain('the copy ignores the view’s filters')
    expect(note).toContain('contains every row')
    // Filter-only: no claim about sorting.
    expect(note).not.toMatch(/sort/i)
  })

  it('describes only the sorting for a sort-only view — filters are not mentioned', () => {
    // Round-2 pin: a sort-only view used to produce the "filtered/sorted
    // subset" wording and refer to active filters that do not exist.
    const note = exportViewSubsetNote(false, true)
    expect(note).toContain('The grid is currently sorted')
    expect(note).toContain('not applied to the copy')
    expect(note).toContain('every row in natural order')
    expect(note).not.toMatch(/filter/i)
  })

  it('names the filtered/sorted subset when both are active', () => {
    const note = exportViewSubsetNote(true, true)
    expect(note).toContain('filtered/sorted subset')
    expect(note).toContain('ignores the view’s filters and sorting')
    expect(note).toContain('contains every row')
  })
})
