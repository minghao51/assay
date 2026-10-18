// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type {
  ColumnDistributionDelta,
  DiffInferenceInput,
  DiffIssue,
  SchemaDriftFinding,
} from './index'
import {
  columnDeltaDiffers,
  diffReportIdentical,
  diffSampleDisplayKey,
  diffSampleExportKey,
  divergentColumnDeltas,
  projectAspect,
  projectColumnDelta,
  projectInference,
  projectIssue,
  projectSample,
  projectSchemaFinding,
  roundReportMetric,
} from './report-projection'

const schema = {
  kind: 'nullability-changed',
  column: 'value',
  typeA: 'INTEGER',
  typeB: 'INTEGER',
  familyA: 'numeric',
  familyB: 'numeric',
  nullShareA: -0.0000001,
  nullShareB: null,
} as SchemaDriftFinding
const delta: ColumnDistributionDelta = {
  column: 'value',
  typeA: 'DOUBLE',
  typeB: 'DOUBLE',
  kindA: 'numeric',
  kindB: 'numeric',
  numeric: {
    meanShiftStandardized: -0.0000001,
    varianceShiftStandardized: null,
    p50Shift: 1.2345678,
    p90Shift: 0,
    bins: { edges: [] },
  },
}
const issue: DiffIssue = { code: 'invalid-input', message: 'bad', side: 'A', column: 'value' }
const inference: DiffInferenceInput = {
  columns: ['id'],
  candidateDisclosure: 'candidate',
  outcomeDisclosure: 'selected',
  evidence: {
    column: 'id',
    typeA: 'INTEGER',
    typeB: 'INTEGER',
    rowCountA: 1,
    rowCountB: 2,
    nullCountA: 0,
    nullCountB: 0,
    distinctCountA: 1,
    distinctCountB: 2,
  },
}

describe('shared diff report projections', () => {
  it('rounds, normalizes negative zero, and propagates absent metrics as null', () => {
    expect(roundReportMetric(1.2345678)).toBe(1.234568)
    expect(Object.is(roundReportMetric(-0.0000001), -0)).toBe(false)
    expect(roundReportMetric(-0.0000001)).toBe(0)
    expect(roundReportMetric(null)).toBeNull()
    expect(roundReportMetric(undefined)).toBeNull()
  })

  it('pins every projector key order and nested projection bytes', () => {
    expect(JSON.stringify(projectSchemaFinding(schema))).toBe(
      '{"kind":"nullability-changed","column":"value","typeA":"INTEGER","typeB":"INTEGER","familyA":"numeric","familyB":"numeric","nullShareA":0,"nullShareB":null}',
    )
    expect(JSON.stringify(projectColumnDelta(delta))).toBe(
      '{"column":"value","typeA":"DOUBLE","typeB":"DOUBLE","kindA":"numeric","kindB":"numeric","numeric":{"meanShiftStandardized":0,"varianceShiftStandardized":null,"p50Shift":1.234568,"p90Shift":0},"categorical":null}',
    )
    expect(JSON.stringify(projectIssue(issue))).toBe(
      '{"code":"invalid-input","message":"bad","side":"A","column":"value"}',
    )
    expect(
      JSON.stringify(projectSample({ side: 'B', exportKey: 'b:3', changedColumns: ['x'] })),
    ).toBe('{"side":"B","rowKey":"b:3","changedColumns":["x"]}')
    expect(
      JSON.stringify(
        projectAspect({
          count: 1,
          samplesReturned: 1,
          samplesComplete: true,
          samples: [{ side: 'B', exportKey: 'b:3' }],
        }),
      ),
    ).toBe(
      '{"count":1,"samplesReturned":1,"samplesComplete":true,"samples":[{"side":"B","rowKey":"b:3"}]}',
    )
    expect(JSON.stringify(projectInference(inference))).toBe(
      '{"columns":["id"],"candidateDisclosure":"candidate","outcomeDisclosure":"selected","evidence":{"column":"id","typeA":"INTEGER","typeB":"INTEGER","rowCountA":1,"rowCountB":2,"nullCountA":0,"nullCountB":0,"distinctCountA":1,"distinctCountB":2}}',
    )
    expect(projectInference(null)).toBeNull()
  })

  it('collapses undefined and null changedColumns to the same sample key set', () => {
    const absent = projectSample({ side: 'A', exportKey: 'base:12' })
    const explicitNull = projectSample({ side: 'A', exportKey: 'base:12', changedColumns: null })
    expect(JSON.stringify(absent)).toBe('{"side":"A","rowKey":"base:12"}')
    expect(Object.keys(absent)).toEqual(Object.keys(explicitNull))
    expect(JSON.stringify(explicitNull)).toBe(JSON.stringify(absent))
  })

  it('uses every aspect in the identical verdict and detects mixed profile changes', () => {
    const identity = {
      schemaDrift: [],
      columnDeltas: [],
      addedCount: 0,
      removedCount: 0,
      changedCount: 0,
    }
    expect(diffReportIdentical(identity)).toBe(true)
    expect(diffReportIdentical({ ...identity, schemaDrift: [schema] })).toBe(false)
    expect(diffReportIdentical({ ...identity, columnDeltas: [delta] })).toBe(false)
    expect(diffReportIdentical({ ...identity, addedCount: 1 })).toBe(false)
    expect(diffReportIdentical({ ...identity, removedCount: 1 })).toBe(false)
    expect(diffReportIdentical({ ...identity, changedCount: 1 })).toBe(false)
    const flat: ColumnDistributionDelta = {
      ...delta,
      numeric: {
        meanShiftStandardized: 0,
        varianceShiftStandardized: 0,
        p50Shift: 0,
        p90Shift: 0,
        bins: { edges: [] },
      },
    }
    expect(columnDeltaDiffers(flat)).toBe(false)
    expect(divergentColumnDeltas([flat, delta])).toEqual([delta])
  })

  it('projects diff-sample key grammar without exposing anchors', () => {
    expect(diffSampleExportKey('base:anchor#12')).toBe('base:12')
    expect(diffSampleExportKey('ins:anchor#3')).toBe('insert:3')
    expect(diffSampleExportKey('b:3')).toBe('b:3')
    expect(diffSampleExportKey('unknown')).toBe('unknown')
    expect(diffSampleDisplayKey('base:anchor#12')).toBe('base #12')
    expect(diffSampleDisplayKey('ins:anchor#3')).toBe('insert #3')
    expect(diffSampleDisplayKey('b:3')).toBe('b #3')
    expect(diffSampleDisplayKey('unknown')).toBe('unknown row')
  })
})
