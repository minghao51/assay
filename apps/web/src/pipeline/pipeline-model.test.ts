// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compilePipeline, parsePipeline, validatePipeline } from '@assay/pipeline'
import type { PipelineCompilePlan, PipelineV1 } from '@assay/pipeline'
import { advanceNodeStatuses, initialNodeStatuses } from './pipeline-state'
import type { PipelineRunState } from './pipeline-state'
import {
  buildNodeViews,
  inspectRelationSql,
  nodeStatusesForRun,
  viewableRelationsForRun,
} from './pipeline-model'
import { sanitizePipelineText } from './sanitize'

/**
 * Pure pins for the pipeline panel model (p-5). The fixtures are the REAL
 * p-1/p-2 surfaces (parse → validate → compile) over a golden-shaped
 * document — the same 4-node shape as fixtures/pipeline/cli_run.yaml — so
 * the model is pinned against the IR the compiler actually produces, not a
 * hand-typed shadow of it.
 */

/** The cli_run-shaped document (source → rename → filter → sql aggregate). */
const DOC = `version: 1
pipeline: web_pin
nodes:
  by_country:
    type: sql
    inputs: [ sg_only ]
    sql: |
      SELECT country, count(*) AS customers
      FROM sg_only
      GROUP BY country
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  renamed:
    type: transform
    inputs: [ customers ]
    operation:
      rename:
        columns:
          customer_id: customer_ref
  sg_only:
    type: transform
    inputs: [ renamed ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

function load(): { pipeline: PipelineV1; plan: PipelineCompilePlan } {
  const parsed = parsePipeline(DOC)
  if (!parsed.ok) throw new Error('fixture must parse')
  const validation = validatePipeline(parsed.pipeline)
  if (!validation.ok) throw new Error('fixture must validate')
  const compiled = compilePipeline(parsed.pipeline)
  if (!compiled.ok) throw new Error('fixture must compile')
  return { pipeline: parsed.pipeline, plan: compiled.plan }
}

describe('buildNodeViews', () => {
  it('lists nodes in the plan’s topological order with kinds, relations, and output flags', () => {
    const { pipeline, plan } = load()
    expect(plan.order).toEqual(['customers', 'renamed', 'sg_only', 'by_country'])
    expect(buildNodeViews(pipeline, plan)).toEqual([
      { nodeId: 'customers', kind: 'source', relation: 'customers', isOutput: false },
      { nodeId: 'renamed', kind: 'transform', relation: 'renamed', isOutput: false },
      { nodeId: 'sg_only', kind: 'transform', relation: 'sg_only', isOutput: false },
      { nodeId: 'by_country', kind: 'sql', relation: 'by_country', isOutput: true },
    ])
  })

  it('flags every unreferenced node as an output (multi-output pipelines)', () => {
    const parsed = parsePipeline(`version: 1
pipeline: two_outputs
nodes:
  a:
    type: source
    source:
      kind: file
      path: a.parquet
  b:
    type: source
    source:
      kind: file
      path: b.parquet
  joined:
    type: sql
    inputs: [ a ]
    sql: SELECT * FROM a
`)
    if (!parsed.ok) throw new Error('fixture must parse')
    const validation = validatePipeline(parsed.pipeline)
    if (!validation.ok) throw new Error('fixture must validate')
    const compiled = compilePipeline(parsed.pipeline)
    if (!compiled.ok) throw new Error('fixture must compile')
    const views = buildNodeViews(parsed.pipeline, compiled.plan)
    const outputs = views.filter((view) => view.isOutput).map((view) => view.nodeId)
    // `joined` and `b` are both unconsumed: `joined` because nothing reads
    // it, `b` because no node declares it as an input (a source with no
    // consumer is itself a terminal output of the DAG).
    expect(outputs.sort()).toEqual(['b', 'joined'])
  })
})

describe('inspectRelationSql', () => {
  it('quotes the relation through the shared identifier helper (hostile ids safe)', () => {
    expect(inspectRelationSql('by_country')).toBe('SELECT * FROM "by_country"')
    // Quotes inside the id are doubled, never interpolated raw (the m4-2
    // lesson: never hand-roll quoting).
    expect(inspectRelationSql('weird "quoted" key')).toBe('SELECT * FROM "weird ""quoted"" key"')
  })
})

describe('node statuses', () => {
  const ORDER = ['customers', 'renamed', 'sg_only', 'by_country']

  it('starts every node pending and advances the boundary honestly', () => {
    const initial = initialNodeStatuses(ORDER)
    expect(initial).toEqual({
      customers: 'pending',
      renamed: 'pending',
      sg_only: 'pending',
      by_country: 'pending',
    })
    // onNode(sg_only): earlier nodes are materialized, sg_only is running.
    expect(advanceNodeStatuses(initial, ORDER, 'sg_only')).toEqual({
      customers: 'done',
      renamed: 'done',
      sg_only: 'running',
      by_country: 'pending',
    })
    // An unknown node id leaves the map untouched (no guessing).
    expect(advanceNodeStatuses(initial, ORDER, 'nope')).toEqual(initial)
    // A second boundary without a settle: the previously-running node is
    // materialized (the runner awaits each op), so it flips to done.
    const afterFirst = advanceNodeStatuses(initial, ORDER, 'sg_only')
    expect(advanceNodeStatuses(afterFirst, ORDER, 'by_country')).toEqual({
      customers: 'done',
      renamed: 'done',
      sg_only: 'done',
      by_country: 'running',
    })
  })

  it('derives display statuses for every run state', () => {
    const running: PipelineRunState = {
      kind: 'running',
      statuses: advanceNodeStatuses(initialNodeStatuses(ORDER), ORDER, 'sg_only'),
      cancelRequested: false,
    }
    expect(nodeStatusesForRun(running, ORDER)['sg_only']).toBe('running')

    const completed: PipelineRunState = {
      kind: 'completed',
      results: Object.fromEntries(
        ORDER.map((nodeId) => [nodeId, { relation: nodeId, rowCount: 1 }]),
      ),
    }
    expect(Object.values(nodeStatusesForRun(completed, ORDER)).every((s) => s === 'done')).toBe(
      true,
    )

    const failed: PipelineRunState = {
      kind: 'failed',
      nodeId: 'sg_only',
      partial: [
        { nodeId: 'customers', relation: 'customers' },
        { nodeId: 'renamed', relation: 'renamed' },
      ],
      message: 'the pipeline node could not be materialized',
    }
    expect(nodeStatusesForRun(failed, ORDER)).toEqual({
      customers: 'done',
      renamed: 'done',
      sg_only: 'failed',
      by_country: 'pending',
    })

    const canceled: PipelineRunState = {
      kind: 'canceled',
      partial: [{ nodeId: 'customers', relation: 'customers' }],
      nextNodeId: 'renamed',
    }
    expect(nodeStatusesForRun(canceled, ORDER)).toEqual({
      customers: 'done',
      renamed: 'pending',
      sg_only: 'pending',
      by_country: 'pending',
    })

    expect(nodeStatusesForRun({ kind: 'idle' }, ORDER)['customers']).toBe('pending')
  })
})

describe('viewableRelationsForRun', () => {
  it('exposes counts only for a completed run; partial state carries rowCount null', () => {
    expect(viewableRelationsForRun({ kind: 'idle' })).toEqual({})

    const completed: PipelineRunState = {
      kind: 'completed',
      results: {
        customers: { relation: 'customers', rowCount: 5 },
        by_country: { relation: 'by_country', rowCount: 1 },
      },
    }
    expect(viewableRelationsForRun(completed)).toEqual({
      customers: { relation: 'customers', rowCount: 5 },
      by_country: { relation: 'by_country', rowCount: 1 },
    })

    // The p-4 carry-over: a failed run's partial materializations exist as
    // views but carry NO counts — inspectable, honestly uncounted.
    const failed: PipelineRunState = {
      kind: 'failed',
      nodeId: 'sg_only',
      partial: [{ nodeId: 'customers', relation: 'customers' }],
      message: 'the pipeline node could not be materialized',
    }
    expect(viewableRelationsForRun(failed)).toEqual({
      customers: { relation: 'customers', rowCount: null },
    })
  })
})

describe('sanitizePipelineText (web render discipline)', () => {
  it('rewrites C0/C1 control characters as visible \\uXXXX escapes (CLI-parity)', () => {
    expect(sanitizePipelineText('plain-id')).toBe('plain-id')
    expect(sanitizePipelineText('a\u001b[31mb')).toBe('a\\u001b[31mb')
    expect(sanitizePipelineText('x\u007fy')).toBe('x\\u007fy')
    expect(sanitizePipelineText('q\u009fw')).toBe('q\\u009fw')
    // Tab/newline are C0 and are escaped too — the CLI parity contract.
    expect(sanitizePipelineText('a\tb')).toBe('a\\u0009b')
    expect(sanitizePipelineText('ünï')).toBe('ünï')
  })
})
