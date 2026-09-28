// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import { compileContract } from '@assay/validation'
import { parseContract } from '@assay/contracts'
import type { ContractV1 } from '@assay/contracts'
import type { EngineValidationPlan, EngineValidationResult } from '@assay/engine-duckdb'
import { buildValidationReport } from './report-model'
import {
  buildReportBytes,
  buildReportCsv,
  buildReportExportRows,
  buildReportJson,
  csvFormulaSanitize,
  reportExportFailureMessage,
  reportExportSuccessMessage,
  reportFileName,
  REPORT_EXPORT_CANCELLED_MESSAGE,
  REPORT_EXPORT_SAME_SOURCE_MESSAGE,
  requestReportDestination,
  writeReportCopy,
} from './report-export'

/**
 * Unit pins for the m5-3 failure-report export: the file content (severity
 * order + the SAME counts the panel shows), the CSV formula-injection
 * sanitization (the client-side mirror of the engine's export guard), the
 * JSON envelope's raw typed values, and the m4-5 delivery patterns (same-
 * source refusal before any byte write; download-only without provable
 * identity; honest result copy).
 *
 * The happy-dom environment (per-file docblock, the m4-0 pattern) exists for
 * the download path's anchor delivery; the destination logic itself is
 * exercised with injected fakes and never opens a native dialog.
 */

const CONTRACT_A_YAML = `format: v1
name: orders-basic
version: 1
columns:
  - name: order_id
    type: BIGINT
    required: true
    unique: true
  - name: region
    type: VARCHAR
    required: true
    allowed-values: [EMEA, APAC, US]
  - name: amount
    type: BIGINT
    max: 500
dataset:
  min-rows: 5
`

const SCHEMA_A = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'amount', type: 'BIGINT' },
]

function fixtureReport(): {
  report: ReturnType<typeof buildValidationReport>
  plan: EngineValidationPlan
  contract: ContractV1
} {
  const parsed = parseContract(CONTRACT_A_YAML)
  if (!parsed.ok) throw new Error('fixture contract failed to parse')
  const compiled = compileContract(parsed.contract, SCHEMA_A, {
    relation: 'assay_validation_target',
    sampleLimit: 100,
  })
  if (!compiled.ok) throw new Error('fixture contract failed to compile')
  const sample = (rowKey: string, value: string | number | boolean | null) => ({ rowKey, value })
  const result: EngineValidationResult = {
    valid: false,
    rowCount: 7,
    rules: [
      {
        outcome: 'row-samples',
        ruleId: 'columns[0].type',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[0].required',
        failCount: 1,
        failPercent: 14,
        sampleFailures: [sample('base:anchor#6', null)],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[0].unique',
        failCount: 2,
        failPercent: 29,
        sampleFailures: [sample('base:anchor#0', 1001), sample('base:anchor#5', 1001)],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[1].type',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[1].required',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[1].allowed-values',
        failCount: 1,
        failPercent: 14,
        sampleFailures: [sample('base:anchor#2', '=SUM(A1)')],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[2].type',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[2].max',
        failCount: 1,
        failPercent: 14,
        sampleFailures: [sample('base:anchor#1', 999)],
      },
      {
        outcome: 'dataset-fact',
        ruleId: 'dataset.min-rows',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
    ],
  }
  return {
    report: buildValidationReport(compiled.plan, result, parsed.contract),
    plan: compiled.plan,
    contract: parsed.contract,
  }
}

const META = {
  contractName: 'orders-basic',
  contractVersion: 1,
  valid: false,
  stale: false,
  datasetRows: 7,
}

describe('report rows', () => {
  it('projects the panel rows in severity order with anchor-free keys', () => {
    const { report } = fixtureReport()
    const rows = buildReportExportRows(report)
    expect(rows.map((row) => row.ruleId)).toEqual([
      'columns[0].unique',
      'columns[0].required',
      'columns[1].allowed-values',
      'columns[2].max',
      'columns[0].type',
      'columns[1].type',
      'columns[2].type',
      'dataset.min-rows',
      'columns[1].required',
    ])
    const unique = rows[0]
    expect(unique?.sampleRowKeys).toEqual(['base:0', 'base:5'])
    expect(unique?.sampleValues).toEqual([1001, 1001])
    expect(unique?.failCount).toBe(2)
    expect(unique?.failPercent).toBe(29)
    expect(unique?.samplesComplete).toBe(true)
    expect(rows.find((row) => row.ruleId === 'columns[0].required')?.sampleValues).toEqual([null])
  })

  it('suggests new-file names that are never derived from the source', () => {
    expect(reportFileName('csv')).toBe('assay-validation-report.csv')
    expect(reportFileName('json')).toBe('assay-validation-report.json')
  })
})

describe('CSV report content', () => {
  it('carries the exact header and the on-screen counts per rule', () => {
    const { report } = fixtureReport()
    const text = new TextDecoder().decode(buildReportCsv(buildReportExportRows(report), META))
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toBe(
      'rule_id,column,rule,fail_count,fail_percent,dataset_rows,valid,stale,samples_returned,samples_complete,sample_row_keys,sample_values',
    )
    expect(lines[1]).toBe(
      'columns[0].unique,order_id,unique,2,29,7,false,false,2,true,"[""base:0"",""base:5""]","[1001,1001]"',
    )
    expect(lines).toHaveLength(10) // header + 9 rules
    expect(text.endsWith('\n')).toBe(true)
  })

  it('sanitizes formula-bait string values inside the array cell (and the cell still starts with [)', () => {
    const { report } = fixtureReport()
    const text = new TextDecoder().decode(buildReportCsv(buildReportExportRows(report), META))
    // The bait is apostrophe-prefixed (the engine guard's marker)…
    expect(text).toContain("'=SUM(A1)")
    // …and no UNSANITIZED bait reaches the file.
    expect(text).not.toContain('"=SUM(A1)"')
    // The composed array cell is quoted (RFC 4180) with the inner JSON
    // quotes doubled, and it always opens with '[': no spreadsheet reads
    // it as a formula. The bait itself is apostrophe-prefixed inside.
    expect(text).toContain('"[""\'=SUM(A1)""]"')
  })

  it('renders NULL samples explicitly and quotes cells that need it', () => {
    const { report } = fixtureReport()
    const text = new TextDecoder().decode(buildReportCsv(buildReportExportRows(report), META))
    expect(text).toContain(
      'columns[0].required,order_id,required,1,14,7,false,false,1,true,"[""base:6""]",[null]',
    )
  })

  it('sanitizes the documented trigger set exactly (the engine guard mirror)', () => {
    expect(csvFormulaSanitize('=cmd')).toBe("'=cmd")
    expect(csvFormulaSanitize('+1')).toBe("'+1")
    expect(csvFormulaSanitize('-5')).toBe("'-5")
    expect(csvFormulaSanitize('@x')).toBe("'@x")
    expect(csvFormulaSanitize('a\tb')).toBe("'a\tb")
    expect(csvFormulaSanitize('a\rb')).toBe("'a\rb")
    // S1: LF is a documented trigger (OWASP) — a leading-LF `=cmd` must be
    // prefixed exactly like its tab/CR twins, and an embedded LF anywhere too.
    expect(csvFormulaSanitize('a\nb')).toBe("'a\nb")
    expect(csvFormulaSanitize('\n=cmd')).toBe("'\n=cmd")
    expect(csvFormulaSanitize('plain')).toBe('plain')
    expect(csvFormulaSanitize('EMEA')).toBe('EMEA')
  })

  it('embeds staleness honestly when the verdict is stale', () => {
    const { report } = fixtureReport()
    const text = new TextDecoder().decode(
      buildReportCsv(buildReportExportRows(report), { ...META, stale: true }),
    )
    expect(text).toContain(',false,true,')
    expect(text).not.toContain(',false,false,')
  })
})

describe('JSON report content', () => {
  it('carries the envelope and the SAME counts, with raw typed values', () => {
    const { report } = fixtureReport()
    const text = new TextDecoder().decode(buildReportJson(buildReportExportRows(report), META))
    const payload = JSON.parse(text) as {
      report: string
      contract: { name: string; version: number }
      valid: boolean
      stale: boolean
      datasetRows: number
      rules: {
        ruleId: string
        failCount: number
        failPercent: number
        sampleValues: (string | number | boolean | null)[]
        sampleRowKeys: string[]
      }[]
    }
    expect(payload.report).toBe('assay-validation-report')
    expect(payload.contract).toEqual({ name: 'orders-basic', version: 1 })
    expect(payload.valid).toBe(false)
    expect(payload.stale).toBe(false)
    expect(payload.datasetRows).toBe(7)
    expect(payload.rules).toHaveLength(9)
    const allowed = payload.rules.find((rule) => rule.ruleId === 'columns[1].allowed-values')
    // JSON is deliberately unguarded (the m4-5 precedent): the bait is raw,
    // typed exactly as the engine normalized it.
    expect(allowed?.sampleValues).toEqual(['=SUM(A1)'])
    expect(allowed?.failCount).toBe(1)
    expect(allowed?.failPercent).toBe(14)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('builds both formats through one entry point', () => {
    const { report } = fixtureReport()
    const bytes = buildReportBytes('json', report, META)
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow()
    const csv = new TextDecoder().decode(buildReportBytes('csv', report, META))
    expect(csv.startsWith('rule_id,column,rule,')).toBe(true)
  })
})

describe('destination + delivery (the m4-5 patterns)', () => {
  it('never offers the picker without a provable source identity', async () => {
    const picker = vi.fn()
    const destination = await requestReportDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: picker,
    })
    expect(destination).toEqual({ via: 'download' })
    expect(picker).not.toHaveBeenCalled()
  })

  it('resolves a picked handle and refuses the opened source before any write', async () => {
    const handle = { createWritable: vi.fn() }
    const sameEntry = vi.fn(
      async (other: FileSystemHandle) => other === (handle as unknown as FileSystemHandle),
    )
    const destination = await requestReportDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => handle,
      sourceIdentity: { isSameEntry: sameEntry },
    })
    expect(destination).toEqual({ via: 'refused-source' })
    expect(handle.createWritable).not.toHaveBeenCalled()

    const otherHandle = { createWritable: vi.fn() }
    const fresh = await requestReportDestination('json', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => otherHandle,
      sourceIdentity: { isSameEntry: async () => false },
    })
    expect(fresh).toEqual({ via: 'file-system-access', handle: otherHandle })
  })

  it('treats a dismissed picker as cancellation, not failure', async () => {
    const abort = new DOMException('user cancelled', 'AbortError')
    const destination = await requestReportDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => {
        throw abort
      },
      sourceIdentity: { isSameEntry: async () => false },
    })
    expect(destination).toBeNull()
  })

  it('writes FSA bytes through the picked handle; download path delivers a Blob', async () => {
    const written: Uint8Array[] = []
    const handle = {
      createWritable: async () => ({
        write: async (chunk: Uint8Array) => {
          written.push(chunk)
        },
        close: async () => {},
      }),
    }
    const strategy = await writeReportCopy(
      { via: 'file-system-access', handle },
      { bytes: new TextEncoder().encode('a,b\n1,2\n'), format: 'csv' },
    )
    expect(strategy).toBe('file-system-access')
    expect(new TextDecoder().decode(written[0])).toBe('a,b\n1,2\n')

    // The download path is browser-delivered; assert it produces the strategy
    // without throwing under happy-dom (the anchor click is fire-and-forget).
    const downloadStrategy = await writeReportCopy(
      { via: 'download' },
      { bytes: new TextEncoder().encode('{}\n'), format: 'json' },
    )
    expect(downloadStrategy).toBe('download')
  })
})

describe('honest copy', () => {
  it('success names the counts, the format, a NEW file, and the unchanged source', () => {
    const line = reportExportSuccessMessage(9, 'csv', 'download')
    expect(line).toContain('9 rules')
    expect(line).toContain('CSV')
    expect(line).toContain('new file')
    expect(line).toContain('The opened file is unchanged')
    expect(line).not.toMatch(/overwrit|in place|in-place|save in/i)
  })

  it('cancel/refusal/failure all say nothing was written and the source is unchanged', () => {
    expect(REPORT_EXPORT_CANCELLED_MESSAGE).toContain('no new file was written')
    expect(REPORT_EXPORT_CANCELLED_MESSAGE).toContain('the opened file is unchanged')
    expect(REPORT_EXPORT_SAME_SOURCE_MESSAGE).toContain('would change the source')
    expect(REPORT_EXPORT_SAME_SOURCE_MESSAGE).toContain('Nothing was written')
    const failure = reportExportFailureMessage(new Error('boom\nSQL: select secret'))
    expect(failure).toContain('No file was written')
    expect(failure).toContain('the opened file is unchanged')
    expect(failure).toContain('boom')
    // Only the first line of a raw error is shown (SQL can echo values).
    expect(failure).not.toContain('select secret')
  })
})
