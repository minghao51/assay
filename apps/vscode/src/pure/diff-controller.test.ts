// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { diffDatasets, inferRowDiffKeys } from '@assay/diff'
import {
  buildDiffReport,
  canRunDiff,
  cancelDiffGeneration,
  decideDiffRun,
  isCurrentDiffRequest,
  isDiffStale,
  makeKeyDisclosure,
  projectDiffReport,
  selectDiffSampleNavigation,
  validateConfirmedKeys,
} from './diff-controller'
import type { DiffProfile, EngineDiffResult } from './diff-controller'

describe('desktop staged-diff controller', () => {
  const schema = [
    { name: 'id,"part"', type: 'VARCHAR' },
    { name: 'value', type: 'VARCHAR' },
  ]
  const profile: DiffProfile = {
    rowCount: 2,
    columns: [
      {
        name: 'id,"part"',
        type: 'VARCHAR',
        kind: 'categorical',
        nullCount: 0,
        distinctCount: 2,
        categorical: { topK: [{ value: 'x', count: 2 }] },
      },
      {
        name: 'value',
        type: 'VARCHAR',
        kind: 'categorical',
        nullCount: 0,
        distinctCount: 2,
        categorical: { topK: [{ value: 'v', count: 2 }] },
      },
    ],
  }

  it('requires explicit confirmation and validates names as an array without comma splitting', () => {
    expect(validateConfirmedKeys([], schema)).toEqual({ ok: false, error: 'empty' })
    expect(validateConfirmedKeys([null], schema)).toEqual({ ok: false, error: 'null-key' })
    expect(validateConfirmedKeys(['id,"part"'], schema)).toEqual({ ok: true, keys: ['id,"part"'] })
    expect(validateConfirmedKeys(['id,"part"', 'ID,"PART"'], schema)).toEqual({
      ok: false,
      error: 'duplicate-key',
    })
    expect(validateConfirmedKeys(['missing'], schema)).toEqual({
      ok: false,
      error: 'unknown-column',
    })
  })

  it('discloses inference candidates and does not make a staged state runnable without confirmation', () => {
    const inference = inferRowDiffKeys(profile, profile)
    expect(inference.candidates.length).toBeGreaterThan(0)
    expect(
      makeKeyDisclosure(inference.candidates[0]!, inference.disclosure).candidateDisclosure,
    ).toBe(inference.candidates[0]!.disclosure)
    expect(canRunDiff({ kind: 'idle' }, true)).toBe(false)
    expect(canRunDiff({ kind: 'idle' }, false)).toBe(false)
  })

  it('correlates by id and generation, and retains old reports as stale after revision changes', () => {
    expect(isCurrentDiffRequest({ id: 'd1', generation: 4 }, { id: 'd1', generation: 4 })).toBe(
      true,
    )
    expect(isCurrentDiffRequest({ id: 'd1', generation: 4 }, { id: 'd1', generation: 5 })).toBe(
      false,
    )
    expect(cancelDiffGeneration(4)).toBe(5)
    expect(
      decideDiffRun({ kind: 'running', id: 'd1', generation: 4 }, true, ['id'], schema),
    ).toEqual({ kind: 'refused', reason: 'busy' })
    expect(decideDiffRun({ kind: 'idle' }, false, ['id'], schema)).toEqual({
      kind: 'refused',
      reason: 'unconfirmed',
    })
    const report = { revision: 2 } as Parameters<typeof isDiffStale>[0]
    expect(isDiffStale(report, 3)).toBe(true)
  })

  it('assembles aspects in order and projects comma-quoted keys without changing them', () => {
    const comparison = diffDatasets({
      schemaA: schema,
      schemaB: schema,
      profileA: profile,
      profileB: profile,
    })
    const result: EngineDiffResult = {
      rowCountA: 2,
      rowCountB: 1,
      aspects: [
        { aspect: 'added', count: 1, samples: [{ side: 'B', rowKey: 'b:1' }] },
        { aspect: 'removed', count: 0, samples: [] },
        { aspect: 'changed', count: 0, samples: [] },
      ],
    }
    const report = buildDiffReport({
      comparison,
      result,
      keys: ['id,"part"'],
      keySource: 'explicit',
      inference: null,
      sharedColumns: ['value'],
      baseViewOnly: false,
      stale: true,
      revision: 2,
    })
    expect(report.aspects.map((aspect) => aspect.aspect)).toEqual(['added', 'removed', 'changed'])
    expect(report.aspects[0]?.samples[0]?.displayKey).toBe('b #1')
    expect(selectDiffSampleNavigation(report.aspects[0]!.samples[0]!)).toEqual({
      kind: 'display-only',
    })
    expect(
      selectDiffSampleNavigation({
        side: 'A',
        rowKey: 'base:x#1',
        displayKey: 'base #1',
        exportKey: 'base:1',
      }),
    ).toEqual({ kind: 'navigate', rowKey: 'base:x#1' })
    const projected = projectDiffReport(report)
    expect(projected['keys']).toEqual(['id,"part"'])
    expect(projected['baseViewOnly']).toBe(false)
    expect(projected['stale']).toBe(true)
    expect(Object.keys(projected)).toEqual([
      'report',
      'baseViewOnly',
      'keys',
      'keySource',
      'inference',
      'sampleLimitRequested',
      'sampleLimitEffective',
      'schemaDrift',
      'columnDeltas',
      'issues',
      'rowDiff',
      'identical',
      'stale',
    ])
  })
})
