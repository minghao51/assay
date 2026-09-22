// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { DiffReport } from '@assay/diff'
import type { EngineRowDiffResult } from '@assay/engine-duckdb'
import { buildDiffPanelReport } from './diff-model'
import type { DiffPanelReport } from './diff-model'
import {
  buildDiffReportBytes,
  buildDiffReportCsv,
  buildDiffReportJson,
  csvFormulaSanitize,
  DIFF_EXPORT_CANCELLED_MESSAGE,
  DIFF_EXPORT_SAME_SOURCE_MESSAGE,
  diffExportFailureMessage,
  diffExportSuccessMessage,
  diffReportFileName,
  requestDiffReportDestination,
  writeDiffReportCopy,
} from './diff-export'

/**
 * Unit pins for the m6-4 report export: the JSON envelope mirrors the CLI's
 * `assay diff --format json` reference shape (same aspects, same rounded
 * numbers, same field order) while carrying no file names and no anchor
 * tokens; the CSV is formula-injection-sanitized and anchor-free; the m4-5
 * delivery patterns (same-source refusal before any byte write, download-only
 * without provable identity, honest result copy). The happy-dom environment
 * exists only for the anchor-download path in `writeDiffReportCopy`.
 */

function fixtureReport(): DiffPanelReport {
  const diff: DiffReport = {
    schemaDrift: [
      { kind: 'column-added', column: 'region', typeB: 'VARCHAR', familyB: 'textual' },
      {
        kind: 'nullability-changed',
        column: 'amount',
        nullShareA: 1 / 3,
        nullShareB: 2 / 3,
      },
    ],
    columnDeltas: [
      {
        column: 'id',
        typeA: 'BIGINT',
        typeB: 'BIGINT',
        kindA: 'numeric',
        kindB: 'numeric',
        numeric: {
          meanShiftStandardized: 0.5059644256269407,
          varianceShiftStandardized: 1.68,
          p50Shift: 0,
          p90Shift: 2,
          bins: { edges: [3, 4.6, 4.8, 4.96] },
        },
      },
      {
        column: 'name',
        typeA: 'VARCHAR',
        typeB: 'VARCHAR',
        kindA: 'categorical',
        kindB: 'categorical',
        categorical: {
          totalVariation: 0.6,
          newCategories: [{ value: '=SUM(A1)', count: 1 }],
          vanishedCategories: [{ value: 'gone', count: 1 }],
        },
      },
    ],
    issues: [],
  }
  const result: EngineRowDiffResult = {
    rowCountA: 5,
    rowCountB: 5,
    aspects: [
      {
        aspect: 'added',
        count: 2,
        samples: [
          { side: 'B', rowKey: 'b:3' },
          { side: 'B', rowKey: 'b:4' },
        ],
      },
      {
        aspect: 'removed',
        count: 2,
        samples: [
          { side: 'A', rowKey: 'base:anchor-x#3' },
          { side: 'A', rowKey: 'base:anchor-x#4' },
        ],
      },
      {
        aspect: 'changed',
        count: 2,
        samples: [
          { side: 'A', rowKey: 'base:anchor-x#1', changedColumns: ['name'] },
          { side: 'A', rowKey: 'base:anchor-x#2', changedColumns: ['amount'] },
        ],
      },
    ],
  }
  return buildDiffPanelReport({
    diff,
    result,
    keys: ['id'],
    keySource: 'inferred',
    inference: {
      columns: ['id'],
      candidateDisclosure: "key candidate: column 'id' is unique and non-null on both sides",
      outcomeDisclosure: '1 key candidate proposed',
      evidence: {
        column: 'id',
        typeA: 'BIGINT',
        typeB: 'BIGINT',
        rowCountA: 5,
        rowCountB: 5,
        nullCountA: 0,
        nullCountB: 0,
        distinctCountA: 5,
        distinctCountB: 5,
      },
    },
    sharedColumns: ['name', 'amount'],
    sampleLimitRequested: 100,
    sampleLimitEffective: 100,
    baseViewOnly: true,
    revision: 3,
  })
}

function decodeJson(bytes: Uint8Array<ArrayBuffer>): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

describe('diff report JSON export', () => {
  it('mirrors the CLI reference envelope per aspect, rounded, with no names or anchors', () => {
    const report = fixtureReport()
    const payload = decodeJson(buildDiffReportJson(report, { stale: false }))
    expect(payload['report']).toBe('assay-diff-report')
    expect(payload['baseViewOnly']).toBe(true)
    expect(payload['stale']).toBe(false)
    expect(payload['identical']).toBe(false)
    expect(payload['keys']).toEqual(['id'])
    expect(payload['keySource']).toBe('inferred')
    expect(payload['sampleLimitRequested']).toBe(100)
    expect(payload['sampleLimitEffective']).toBe(100)

    const drift = payload['schemaDrift'] as Record<string, unknown>[]
    expect(drift[1]).toMatchObject({
      kind: 'nullability-changed',
      nullShareA: 0.333333,
      nullShareB: 0.666667,
    })
    const deltas = payload['columnDeltas'] as Record<string, unknown>[]
    expect((deltas[0]!['numeric'] as Record<string, unknown>)['meanShiftStandardized']).toBe(
      0.505964,
    )
    const rowDiff = payload['rowDiff'] as Record<string, unknown>
    expect(rowDiff['rowCountA']).toBe(5)
    expect(rowDiff['rowCountB']).toBe(5)
    expect(rowDiff['changedComparable']).toBe(true)
    expect((rowDiff['added'] as Record<string, unknown>)['count']).toBe(2)
    expect((rowDiff['removed'] as Record<string, unknown>)['samplesComplete']).toBe(true)
    const changed = rowDiff['changed'] as { samples: Record<string, unknown>[] }
    expect(changed.samples.map((sample) => sample['rowKey'])).toEqual(['base:1', 'base:2'])
    expect(changed.samples.map((sample) => sample['changedColumns'])).toEqual([
      ['name'],
      ['amount'],
    ])

    const text = JSON.stringify(payload)
    expect(text).not.toContain('anchor')
    // No file names anywhere (the panel never receives them).
    expect(text).not.toContain('.jsonl')
    expect(text).not.toContain('.parquet')
  })

  it('reports identical only when every aspect is flat', () => {
    const flat = buildDiffPanelReport({
      diff: { schemaDrift: [], columnDeltas: [], issues: [] },
      result: {
        rowCountA: 5,
        rowCountB: 5,
        aspects: [
          { aspect: 'added', count: 0, samples: [] },
          { aspect: 'removed', count: 0, samples: [] },
          { aspect: 'changed', count: 0, samples: [] },
        ],
      },
      keys: ['id'],
      keySource: 'explicit',
      inference: null,
      sharedColumns: ['name'],
      sampleLimitRequested: 100,
      sampleLimitEffective: 100,
      baseViewOnly: true,
      revision: 0,
    })
    const payload = decodeJson(buildDiffReportJson(flat, { stale: true }))
    expect(payload['identical']).toBe(true)
    expect(payload['stale']).toBe(true)
    expect(payload['inference']).toBeNull()
  })
})

describe('diff report CSV export', () => {
  it('is anchor-free and formula-injection-sanitized', () => {
    const csv = new TextDecoder().decode(buildDiffReportCsv(fixtureReport(), { stale: false }))
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('section,column,kind,field,value')
    expect(csv).toContain('row-diff,,added,count,2')
    expect(csv).toContain('row-diff,,removed,count,2')
    expect(csv).toContain('row-diff,,changed,count,2')
    // The categorical bait carries the guard apostrophe.
    expect(csv).toContain("'=SUM(A1)")
    expect(csv).not.toContain('anchor')
    expect(csv).toContain('verdict,,,identical,false')
    expect(csv).toContain('verdict,,,stale,false')
  })

  it('exports negative numeric metrics as numbers, never as apostrophe-prefixed text', () => {
    // AR-W3: `csvRow` sanitized every cell, so a negative metric like
    // `-0.5059…` gained the formula-guard apostrophe and exported as text.
    // Only STRING cells may be sanitized; numeric metrics pass through raw.
    const base = fixtureReport()
    const negative: DiffPanelReport = {
      ...base,
      drift: [
        { kind: 'nullability-changed', column: 'amount', nullShareA: 1 / 3, nullShareB: -0.5 },
      ],
      deltas: base.deltas.map((delta) =>
        delta.numeric === undefined
          ? delta
          : {
              ...delta,
              numeric: {
                ...delta.numeric,
                meanShiftStandardized: -0.5059644256269407,
                varianceShiftStandardized: -1.68,
                p50Shift: -0.25,
                p90Shift: -2,
              },
            },
      ),
    }
    const csv = new TextDecoder().decode(buildDiffReportCsv(negative, { stale: false }))
    // Byte-pinned as a number: no leading apostrophe anywhere.
    expect(csv).toContain('column-delta,id,numeric,meanShiftStandardized,-0.505964')
    expect(csv).toContain('column-delta,id,numeric,varianceShiftStandardized,-1.68')
    expect(csv).toContain('column-delta,id,numeric,p50Shift,-0.25')
    expect(csv).toContain('column-delta,id,numeric,p90Shift,-2')
    expect(csv).toContain('schema-drift,amount,finding,nullShareB,-0.5')
    expect(csv).not.toContain("'-0.505964")
    expect(csv).not.toContain("'-1.68")
    // String sample cells are still sanitized (the guard is intact).
    expect(csv).toContain("'=SUM(A1)")
  })
})

describe('diff report destination and delivery', () => {
  it('falls back to download when identity cannot be proven (input-fallback session)', async () => {
    expect(await requestDiffReportDestination('json')).toEqual({ via: 'download' })
    expect(
      await requestDiffReportDestination('json', { capabilities: { fileSavePicker: true } }),
    ).toEqual({ via: 'download' })
  })

  it('refuses the opened source entry before writing, and allows a different file', async () => {
    const handle = { createWritable: vi.fn() }
    const destination = await requestDiffReportDestination('json', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => handle,
      sourceIdentity: { isSameEntry: async () => true },
    })
    expect(destination).toEqual({ via: 'refused-source' })
    expect(handle.createWritable).not.toHaveBeenCalled()

    const other = { createWritable: vi.fn() }
    const fresh = await requestDiffReportDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => other,
      sourceIdentity: { isSameEntry: async () => false },
    })
    expect(fresh).toEqual({ via: 'file-system-access', handle: other })
  })

  it('treats a dismissed picker as cancellation, not failure', async () => {
    const abort = new DOMException('user cancelled', 'AbortError')
    expect(
      await requestDiffReportDestination('json', {
        capabilities: { fileSavePicker: true },
        showSaveFilePicker: async () => {
          throw abort
        },
        sourceIdentity: { isSameEntry: async () => false },
      }),
    ).toBeNull()
  })

  it('writes FSA bytes through the picked handle and delivers a download otherwise', async () => {
    const written: Uint8Array[] = []
    const handle = {
      createWritable: async () => ({
        write: async (chunk: Uint8Array) => {
          written.push(chunk)
        },
        close: async () => {},
      }),
    }
    const strategy = await writeDiffReportCopy(
      { via: 'file-system-access', handle },
      { bytes: new TextEncoder().encode('a\n1\n'), format: 'csv' },
    )
    expect(strategy).toBe('file-system-access')
    expect(new TextDecoder().decode(written[0])).toBe('a\n1\n')

    const download = await writeDiffReportCopy(
      { via: 'download' },
      { bytes: buildDiffReportBytes('json', fixtureReport(), { stale: false }), format: 'json' },
    )
    expect(download).toBe('download')
  })

  it('names a NEW report file and never either source file', () => {
    expect(diffReportFileName('csv')).toBe('assay-diff-report.csv')
    expect(diffReportFileName('json')).toBe('assay-diff-report.json')
  })
})

describe('honest diff report copy', () => {
  it('success states the counts, a NEW file, and the unchanged source', () => {
    const line = diffExportSuccessMessage(fixtureReport(), 'json', 'download')
    expect(line).toContain('2 schema findings')
    expect(line).toContain('2 columns')
    expect(line).toContain('2 added / 2 removed / 2 changed rows')
    expect(line).toContain('JSON')
    expect(line).toContain('new file')
    expect(line).toContain('The opened file is unchanged')
    expect(line).not.toMatch(/overwrit|in place|in-place|save in/i)
  })

  it('cancel/refusal/failure all say nothing was written and the source is unchanged', () => {
    for (const message of [
      DIFF_EXPORT_CANCELLED_MESSAGE,
      DIFF_EXPORT_SAME_SOURCE_MESSAGE,
      diffExportFailureMessage(new Error('boom\nmore SQL')),
    ]) {
      expect(message).toContain('unchanged')
      expect(message).not.toMatch(/overwrit|in place|in-place|save in/i)
    }
    expect(diffExportFailureMessage(new Error('boom\nmore SQL'))).not.toContain('more SQL')
  })
  it('sanitizes every documented formula trigger and leaves plain text alone', () => {
    for (const trigger of ['=SUM(A1)', '+1', '-1', '@x', 'a\tb', 'a\rb']) {
      expect(csvFormulaSanitize(trigger)).toBe(`'${trigger}`)
    }
    expect(csvFormulaSanitize('plain')).toBe('plain')
    expect(csvFormulaSanitize('')).toBe('')
  })
})
