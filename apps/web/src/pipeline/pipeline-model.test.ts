// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compilePipeline, isDataNode, parsePipeline, validatePipeline } from '@assay/pipeline'
import type { PipelineCompilePlan, PipelineV1 } from '@assay/pipeline'
import { advanceNodeStatuses, initialNodeStatuses } from './pipeline-state'
import type { PipelineRunOutcome, PipelineRunState } from './pipeline-state'
import {
  buildLineage,
  buildNodeViews,
  gateVerdictForRun,
  isPreviewable,
  isSchemaDeltaEmpty,
  nodeStatusesForRun,
  previewableNodeIds,
  schemaDelta,
  viewableRelationsForRun,
} from './pipeline-model'
import { sanitizePipelineText } from './sanitize'

/**
 * Pure pins for the pipeline panel model (p-5; p2-6 gates/lineage/delta).
 * The fixtures are the REAL p-1/p-2 surfaces (parse → validate → compile)
 * over golden-shaped documents — the same 4-node shape as
 * `fixtures/pipeline/cli_run.yaml` and the gated `reserved-nodes.yaml`
 * shape — so the model is pinned against the IR the compiler actually
 * produces, not a hand-typed shadow of it.
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

/** The reserved-nodes-shaped document (source → sql → validate → publish). */
const GATED_DOC = `version: 1
pipeline: gated_pin
nodes:
  clean:
    type: sql
    inputs: [ raw ]
    sql: SELECT * FROM raw
  gate:
    type: validate
    input: clean
    contract: contracts/clean.yaml
  out:
    type: publish
    input: clean
    requires: [ gate ]
  raw:
    type: source
    source:
      kind: file
      path: raw.parquet
`

/** An ephemeral-mode transform (the p2-6 fix-round badge pin). */
const EPHEMERAL_DOC = `version: 1
pipeline: ephemeral_pin
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  scratch:
    type: transform
    inputs: [ customers ]
    materialization: ephemeral
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

function load(text = DOC): {
  pipeline: PipelineV1
  plan: PipelineCompilePlan
  order: readonly string[]
} {
  const parsed = parsePipeline(text)
  if (!parsed.ok) throw new Error('fixture must parse')
  const validation = validatePipeline(parsed.pipeline)
  if (!validation.ok) throw new Error('fixture must validate')
  const compiled = compilePipeline({
    ...parsed.pipeline,
    nodes: parsed.pipeline.nodes.filter((node) => isDataNode(node)),
  })
  if (!compiled.ok) throw new Error('fixture must compile')
  return { pipeline: parsed.pipeline, plan: compiled.plan, order: validation.order }
}

/** An executed data node's outcome (counts known). */
function outcome(
  nodeId: string,
  rowCount: number,
  materialization: PipelineRunOutcome['materialization'] = 'view',
): PipelineRunOutcome {
  return { nodeId, relation: nodeId, rowCount, materialization }
}

describe('buildNodeViews', () => {
  it('lists nodes in the validated order with kinds, badges, SQL, and output flags', () => {
    const { pipeline, plan, order } = load()
    expect(order).toEqual(['customers', 'renamed', 'sg_only', 'by_country'])
    const views = buildNodeViews(pipeline, order, plan)
    expect(views.map((view) => view.nodeId)).toEqual(order)
    expect(views.map((view) => view.kind)).toEqual(['source', 'transform', 'transform', 'sql'])
    expect(views.map((view) => view.materialization)).toEqual(['source', 'view', 'view', 'view'])
    expect(views[0]?.sql).toBeNull()
    expect(views[1]?.sql).toContain('customer_ref')
    expect(views[3]?.sql).toContain('GROUP BY')
    expect(views[3]?.isOutput).toBe(true)
    expect(views[0]?.isOutput).toBe(false)
  })

  it('flags every unreferenced node as an output (multi-output pipelines)', () => {
    const { pipeline, plan, order } = load(`version: 1
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
    const outputs = buildNodeViews(pipeline, order, plan)
      .filter((view) => view.isOutput)
      .map((view) => view.nodeId)
      .sort()
    expect(outputs).toEqual(['b', 'joined'])
  })

  it('shows an ephemeral node from its plan mode, not the view statement kind', () => {
    const { pipeline, plan, order } = load(EPHEMERAL_DOC)
    const views = buildNodeViews(pipeline, order, plan)
    expect(views.find((view) => view.nodeId === 'scratch')?.materialization).toBe('ephemeral')
    // A source base relation has no statement and stays `source`.
    expect(views.find((view) => view.nodeId === 'customers')?.materialization).toBe('source')
  })

  it('includes gate nodes from the IR order with a `gate` badge and no SQL', () => {
    const { pipeline, plan, order } = load(GATED_DOC)
    const views = buildNodeViews(pipeline, order, plan)
    expect(views.map((view) => view.nodeId)).toEqual(order)
    const gate = views.find((view) => view.nodeId === 'gate')
    const out = views.find((view) => view.nodeId === 'out')
    expect(gate?.kind).toBe('validate')
    expect(gate?.materialization).toBe('gate')
    expect(gate?.sql).toBeNull()
    expect(gate?.inputs).toEqual(['clean'])
    expect(gate?.contract).toBe('contracts/clean.yaml')
    expect(out?.kind).toBe('publish')
    expect(out?.requires).toEqual(['gate'])
    expect(out?.inputs).toEqual(['clean'])
  })
})

describe('schemaDelta', () => {
  it('reports added, removed, and type-changed columns by name', () => {
    const before = [
      { name: 'id', type: 'BIGINT' },
      { name: 'country', type: 'VARCHAR' },
      { name: 'gone', type: 'BIGINT' },
    ]
    const after = [
      { name: 'id', type: 'VARCHAR' },
      { name: 'country', type: 'VARCHAR' },
      { name: 'added', type: 'DOUBLE' },
    ]
    const delta = schemaDelta(before, after)
    expect(delta.added).toEqual([{ name: 'added', type: 'DOUBLE' }])
    expect(delta.removed).toEqual([{ name: 'gone', type: 'BIGINT' }])
    expect(delta.changed).toEqual([{ name: 'id', from: 'BIGINT', to: 'VARCHAR' }])
    expect(isSchemaDeltaEmpty(delta)).toBe(false)
    expect(isSchemaDeltaEmpty(schemaDelta(before, before))).toBe(true)
  })
})

describe('node statuses', () => {
  const ORDER = ['customers', 'renamed', 'sg_only', 'by_country']

  it('starts every node pending and advances the boundary honestly', () => {
    const initial = initialNodeStatuses(ORDER)
    expect(advanceNodeStatuses(initial, ORDER, 'sg_only')).toEqual({
      customers: 'done',
      renamed: 'done',
      sg_only: 'running',
      by_country: 'pending',
    })
    expect(advanceNodeStatuses(initial, ORDER, 'nope')).toEqual(initial)
  })

  it('derives display statuses for every run state (gated included)', () => {
    const running: PipelineRunState = {
      kind: 'running',
      statuses: advanceNodeStatuses(initialNodeStatuses(ORDER), ORDER, 'sg_only'),
      cancelRequested: false,
    }
    expect(nodeStatusesForRun(running, ORDER)['sg_only']).toBe('running')

    const completed: PipelineRunState = {
      kind: 'completed',
      outcomes: ORDER.map((nodeId) => outcome(nodeId, 1)),
    }
    expect(Object.values(nodeStatusesForRun(completed, ORDER)).every((s) => s === 'done')).toBe(
      true,
    )

    // The gated state: executed nodes are done, the stop node is `gated`,
    // everything downstream is pending.
    const gated: PipelineRunState = {
      kind: 'gated',
      gatedAt: 'sg_only',
      gate: 'validation-failed',
      outcomes: [outcome('customers', 5), outcome('renamed', 5), outcome('sg_only', 2)],
      nextNodeId: 'by_country',
    }
    expect(nodeStatusesForRun(gated, ORDER)).toEqual({
      customers: 'done',
      renamed: 'done',
      sg_only: 'gated',
      by_country: 'pending',
    })

    const failed: PipelineRunState = {
      kind: 'failed',
      nodeId: 'sg_only',
      partial: [outcome('customers', 5), outcome('renamed', 5)],
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
      partial: [outcome('customers', 5)],
      nextNodeId: 'renamed',
    }
    expect(nodeStatusesForRun(canceled, ORDER)).toEqual({
      customers: 'done',
      renamed: 'pending',
      sg_only: 'pending',
      by_country: 'pending',
    })
  })
})

describe('viewable relations, previewability, and gate verdicts', () => {
  it('exposes executed outcomes; export and gate relations are not previewable', () => {
    expect(viewableRelationsForRun({ kind: 'idle' })).toEqual({})

    const completed: PipelineRunState = {
      kind: 'completed',
      outcomes: [
        outcome('customers', 5, 'source'),
        outcome('by_country', 1),
        outcome('dump', 5, 'export'),
      ],
    }
    const viewable = viewableRelationsForRun(completed)
    expect(viewable['customers']).toEqual(outcome('customers', 5, 'source'))
    expect(isPreviewable(viewable['by_country'])).toBe(true)
    expect(isPreviewable(viewable['dump'])).toBe(false)
    expect(previewableNodeIds(completed, ['customers', 'by_country', 'dump'])).toEqual([
      'customers',
      'by_country',
    ])
  })

  it('reads a gate verdict from the run outcome and ignores non-gates', () => {
    const gated: PipelineRunState = {
      kind: 'gated',
      gatedAt: 'out',
      gate: 'publish-blocked',
      outcomes: [
        outcome('clean', 2),
        {
          ...outcome('gate', 2, 'gate'),
          gate: { class: 'validate', input: 'clean', valid: false, violatedRules: 1 },
        },
        {
          ...outcome('against', 2, 'gate'),
          gate: {
            class: 'diff',
            input: 'clean',
            against: 'prior',
            added: 1,
            removed: 0,
            changed: 2,
          },
        },
        {
          ...outcome('out', 2, 'gate'),
          gate: { class: 'publish', input: 'clean', blockedGates: ['gate'] },
        },
      ],
      nextNodeId: null,
    }
    expect(gateVerdictForRun(gated, 'gate')).toEqual({
      class: 'validate',
      input: 'clean',
      valid: false,
      violatedRules: 1,
    })
    expect(gateVerdictForRun(gated, 'out')).toEqual({
      class: 'publish',
      input: 'clean',
      blockedGates: ['gate'],
    })
    expect(gateVerdictForRun(gated, 'clean')).toBeNull()
    expect(gateVerdictForRun(gated, 'against')).toEqual({
      class: 'diff',
      input: 'clean',
      against: 'prior',
      added: 1,
      removed: 0,
      changed: 2,
    })
    // A gate relation is not previewable (it only inspects its input).
    expect(isPreviewable(viewableRelationsForRun(gated)['gate'])).toBe(false)
  })
})

describe('buildLineage', () => {
  it('derives dataset and node lineage in topological order', () => {
    const { pipeline, order } = load()
    const lineage = buildLineage(pipeline, order)
    expect(lineage.datasets).toEqual([
      { sourceId: 'customers', consumers: ['renamed', 'sg_only', 'by_country'] },
    ])
    const renamed = lineage.nodes.find((node) => node.nodeId === 'renamed')
    expect(renamed?.inputs).toEqual(['customers'])
    expect(renamed?.consumers).toEqual(['sg_only'])
    const byCountry = lineage.nodes.find((node) => node.nodeId === 'by_country')
    expect(byCountry?.inputs).toEqual(['sg_only'])
    expect(byCountry?.consumers).toEqual([])
  })

  it('includes gate consumers and publish requirements (dataset lineage is transitive)', () => {
    const { pipeline, order } = load(GATED_DOC)
    const lineage = buildLineage(pipeline, order)
    // `clean` is consumed by the gate and the publish, both downstream of raw.
    expect(lineage.datasets).toEqual([{ sourceId: 'raw', consumers: ['clean', 'gate', 'out'] }])
    const out = lineage.nodes.find((node) => node.nodeId === 'out')
    expect(out?.inputs).toEqual(['clean'])
    expect(out?.requires).toEqual(['gate'])
    expect(out?.consumers).toEqual([])
  })
})

describe('sanitizePipelineText (web render discipline)', () => {
  it('rewrites C0/C1 control characters as visible \\uXXXX escapes (CLI-parity)', () => {
    expect(sanitizePipelineText('plain-id')).toBe('plain-id')
    expect(sanitizePipelineText('a\u001b[31mb')).toBe('a\\u001b[31mb')
    expect(sanitizePipelineText('x\u007fy')).toBe('x\\u007fy')
    expect(sanitizePipelineText('q\u009fw')).toBe('q\\u009fw')
    expect(sanitizePipelineText('a\tb')).toBe('a\\u0009b')
    expect(sanitizePipelineText('ünï')).toBe('ünï')
  })
})
