// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the p-4 pipeline report model + renderers: the control-
 * character sanitizer (the p-2 carry-over boundary), the validate/run report
 * builders, and byte-pinned human/JSON rendering. The JSON envelopes are
 * pinned on shape and key ORDER (the reportVersion is the package version,
 * read at module load); the integration suite pins the spawned CLI's full
 * bytes end-to-end.
 */
import { parsePipeline, compilePipeline, validatePipeline } from '@assay/pipeline'
import type { PipelineV1 } from '@assay/pipeline'
import { describe, expect, it } from 'vitest'
import { createReportStyle } from './style.js'
import {
  buildPipelineRunReport,
  buildPipelineValidateReport,
  describePipelineErrorLine,
  pipelineOutputNodeIds,
  renderHumanPipelineRunReport,
  renderHumanPipelineValidateReport,
  renderJsonPipelineRunReport,
  renderJsonPipelineValidateReport,
  sanitizePipelineText,
} from './report-pipeline.js'

/** Parse a pipeline from YAML text (the tests' IR source). */
function parse(text: string): PipelineV1 {
  const parsed = parsePipeline(text)
  if (!parsed.ok) throw new Error(`test pipeline must parse: ${JSON.stringify(parsed.errors)}`)
  return parsed.pipeline
}

/**
 * True when the text carries a RAW C0 control byte other than the renderer's
 * own line separator (the sanitizer must have escaped every embedded control
 * character). Written as a code-point scan, not a regex, so the lint rule
 * against control characters IN regexes stays clean while the assertion
 * stays exact.
 */
function hasRawControlByte(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x0a) continue // the report's own line breaks
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

describe('sanitizePipelineText', () => {
  it('passes ordinary text (and backslashes) through verbatim', () => {
    expect(sanitizePipelineText('plain id_1 "quoted" \\n literal')).toBe(
      'plain id_1 "quoted" \\n literal',
    )
  })

  it('escapes ANSI escapes, newlines, tabs, NUL, DEL, and C1 as visible \\uXXXX', () => {
    expect(sanitizePipelineText('\u001b[31mred')).toBe('\\u001b[31mred')
    expect(sanitizePipelineText('a\nb')).toBe('a\\u000ab')
    expect(sanitizePipelineText('a\tb')).toBe('a\\u0009b')
    expect(sanitizePipelineText('a\u0000b')).toBe('a\\u0000b')
    expect(sanitizePipelineText('a\u007fb')).toBe('a\\u007fb')
    expect(sanitizePipelineText('a\u009fb')).toBe('a\\u009fb')
    expect(sanitizePipelineText('a\u001fb')).toBe('a\\u001fb')
  })

  it('leaves non-control unicode (incl. astral plane) untouched', () => {
    expect(sanitizePipelineText('ünï — 😀')).toBe('ünï — 😀')
  })
})

describe('describePipelineErrorLine', () => {
  it('renders the canonical located one-liner, sanitized', () => {
    const line = describePipelineErrorLine({
      code: 'yaml-syntax',
      message: 'YAML syntax error: excerpt\u001b[31mwith escapes\u000a',
      path: 'document',
      line: 4,
      column: 1,
    })
    expect(line).toBe('document:4:1: YAML syntax error: excerpt\\u001b[31mwith escapes\\u000a')
  })

  it('drops the location for AST-position errors and accepts the row projection', () => {
    const line = describePipelineErrorLine({
      code: 'unresolved-reference',
      message: 'nodes.a: data input "ghost" names no declared node',
      path: 'nodes.a',
      line: null,
      column: null,
      nodeId: 'a',
    })
    expect(line).toBe('nodes.a: nodes.a: data input "ghost" names no declared node')
  })
})

const VALID_PIPELINE = parse(`version: 1
pipeline: unit_pipeline
nodes:
  aggregated:
    type: sql
    inputs: [filtered]
    sql: SELECT country, count(*) AS n FROM filtered GROUP BY country
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  filtered:
    type: transform
    inputs: [customers]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`)

const DAG_ERROR_PIPELINE = parse(`version: 1
pipeline: dag_error
nodes:
  a:
    type: sql
    inputs: [ghost]
    sql: SELECT 1
`)

const COMPILE_REFUSAL_PIPELINE = parse(`version: 1
pipeline: compile_refusal
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./x.csv
  gate:
    type: validate
    input: a
    contract: contracts/x.yaml
`)

describe('buildPipelineValidateReport', () => {
  it('the valid case lists the compiled plan in order with IR disclosures', () => {
    const validation = validatePipeline(VALID_PIPELINE)
    if (!validation.ok) throw new Error('fixture must validate')
    const compile = compilePipeline(VALID_PIPELINE)
    if (!compile.ok) throw new Error('fixture must compile')
    const report = buildPipelineValidateReport({
      pipeline: VALID_PIPELINE,
      validation,
      compile,
    })
    expect(report.pipeline).toBe('unit_pipeline')
    expect(report.valid).toBe(true)
    expect(report.order).toEqual(['customers', 'filtered', 'aggregated'])
    expect(report.errors).toEqual([])
    expect(report.nodes.map((node) => [node.nodeId, node.kind])).toEqual([
      ['customers', 'source'],
      ['filtered', 'transform'],
      ['aggregated', 'sql'],
    ])
    const customers = report.nodes.find((node) => node.nodeId === 'customers')
    expect(customers?.sourceKind).toBe('file')
    expect(customers?.sourcePath).toBe('../csv/customers.csv')
    expect(customers?.operation).toBe(null)
    const filtered = report.nodes.find((node) => node.nodeId === 'filtered')
    expect(filtered?.operation).toBe('filter')
  })

  it('a DAG failure reports empty order/nodes and the located errors', () => {
    const validation = validatePipeline(DAG_ERROR_PIPELINE)
    expect(validation.ok).toBe(false)
    const report = buildPipelineValidateReport({
      pipeline: DAG_ERROR_PIPELINE,
      validation,
      compile: null,
    })
    expect(report.valid).toBe(false)
    expect(report.order).toEqual([])
    expect(report.nodes).toEqual([])
    expect(report.errors.map((error) => error.code)).toEqual(['unresolved-reference'])
  })

  it('a compile refusal keeps the IR-derived plan listing and reports the refusals', () => {
    const validation = validatePipeline(COMPILE_REFUSAL_PIPELINE)
    if (!validation.ok) throw new Error('fixture must validate')
    const compile = compilePipeline(COMPILE_REFUSAL_PIPELINE)
    expect(compile.ok).toBe(false)
    const report = buildPipelineValidateReport({
      pipeline: COMPILE_REFUSAL_PIPELINE,
      validation,
      compile,
    })
    expect(report.valid).toBe(false)
    expect(report.order).toEqual(['a', 'gate'])
    expect(report.nodes.map((node) => node.kind)).toEqual(['source', 'validate'])
    expect(report.errors.map((error) => error.code)).toEqual(['reserved-node-class'])
  })
})

describe('pipelineOutputNodeIds', () => {
  it('selects the terminal nodes of a diamond (nothing consumes them)', () => {
    const pipeline = parse(`version: 1
pipeline: diamond
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./a.csv
  b:
    type: sql
    inputs: [a]
    sql: SELECT * FROM a
  c:
    type: sql
    inputs: [a]
    sql: SELECT * FROM a
  d:
    type: sql
    inputs: [b, c]
    sql: SELECT * FROM b
`)
    expect(pipelineOutputNodeIds(pipeline, ['a', 'b', 'c', 'd'])).toEqual(['d'])
  })

  it('counts gate references (publish/validate consume too)', () => {
    const pipeline = parse(`version: 1
pipeline: gated
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./a.csv
  gate:
    type: validate
    input: a
    contract: contracts/x.yaml
`)
    expect(pipelineOutputNodeIds(pipeline, ['a', 'gate'])).toEqual(['gate'])
  })
})

describe('buildPipelineRunReport', () => {
  const order = ['customers', 'filtered', 'aggregated']

  it('a completed run maps every node with its row count and computes outputs', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order,
      result: {
        status: 'completed',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5 },
          { nodeId: 'filtered', relation: 'filtered', rowCount: 2 },
          { nodeId: 'aggregated', relation: 'aggregated', rowCount: 1 },
        ],
      },
      error: null,
    })
    expect(report.status).toBe('completed')
    expect(report.failingNode).toBe(null)
    expect(report.nextNodeId).toBe(null)
    expect(report.nodes.map((node) => [node.nodeId, node.status, node.rowCount])).toEqual([
      ['customers', 'materialized', 5],
      ['filtered', 'materialized', 2],
      ['aggregated', 'materialized', 1],
    ])
    expect(report.outputs).toEqual([{ nodeId: 'aggregated', relation: 'aggregated', rowCount: 1 }])
  })

  it('a failed run names the failing node and marks the untouched tail not-run', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order,
      result: null,
      error: {
        name: 'PipelineRunError',
        message: 'the pipeline node could not be materialized',
        nodeId: 'filtered',
        partial: [{ nodeId: 'customers', relation: 'customers' }],
      } as InstanceType<typeof import('@assay/engine-duckdb/node').PipelineRunError>,
    })
    expect(report.status).toBe('failed')
    expect(report.failingNode).toBe('filtered')
    expect(report.outputs).toEqual([])
    expect(report.nodes.map((node) => [node.nodeId, node.status, node.rowCount])).toEqual([
      ['customers', 'materialized', null],
      ['filtered', 'failed', null],
      ['aggregated', 'not-run', null],
    ])
  })

  it('a canceled run keeps the named partial state and the next node', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order,
      result: {
        status: 'canceled',
        nodes: [{ nodeId: 'customers', relation: 'customers', rowCount: 5 }],
        nextNodeId: 'filtered',
      },
      error: null,
    })
    expect(report.status).toBe('canceled')
    expect(report.nextNodeId).toBe('filtered')
    expect(report.nodes.map((node) => node.status)).toEqual(['materialized', 'not-run', 'not-run'])
  })

  it('the defensive zero state (no outcome passed) is an empty canceled shape', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order,
      result: null,
      error: null,
    })
    expect(report.status).toBe('canceled')
    expect(report.nodes).toEqual([])
    expect(report.outputs).toEqual([])
  })
})

describe('human renderers — byte pins (plain style)', () => {
  it('the validate report (valid case)', () => {
    const validation = validatePipeline(VALID_PIPELINE)
    if (!validation.ok) throw new Error('fixture must validate')
    const compile = compilePipeline(VALID_PIPELINE)
    if (!compile.ok) throw new Error('fixture must compile')
    const report = buildPipelineValidateReport({ pipeline: VALID_PIPELINE, validation, compile })
    expect(renderHumanPipelineValidateReport(report)).toBe(
      `pipeline: unit_pipeline
nodes: 3
plan:
  1. customers — source — relation "customers" (file: ../csv/customers.csv)
  2. filtered — transform — relation "filtered" (op: filter)
  3. aggregated — sql — relation "aggregated"
verdict: VALID — the DAG validates and the plan compiles (nothing was executed)
`,
    )
  })

  it('the validate report (DAG failure)', () => {
    const validation = validatePipeline(DAG_ERROR_PIPELINE)
    expect(validation.ok).toBe(false)
    const report = buildPipelineValidateReport({
      pipeline: DAG_ERROR_PIPELINE,
      validation,
      compile: null,
    })
    expect(renderHumanPipelineValidateReport(report)).toBe(
      `pipeline: dag_error
nodes: 0
errors: 1
  nodes.a: nodes.a: data input "ghost" names no declared node
verdict: INVALID — 1 error
`,
    )
  })

  it('the validate report (compile refusal lists the IR-derived plan)', () => {
    const validation = validatePipeline(COMPILE_REFUSAL_PIPELINE)
    if (!validation.ok) throw new Error('fixture must validate')
    const compile = compilePipeline(COMPILE_REFUSAL_PIPELINE)
    expect(compile.ok).toBe(false)
    const report = buildPipelineValidateReport({
      pipeline: COMPILE_REFUSAL_PIPELINE,
      validation,
      compile,
    })
    expect(renderHumanPipelineValidateReport(report)).toBe(
      `pipeline: compile_refusal
nodes: 2
plan:
  1. a — source — relation "a" (file: ./x.csv)
  2. gate — validate — relation "gate"
errors: 1
  nodes.gate: nodes.gate: the validate node is reserved until P2 — P1 compiles source/transform/sql only; use a sql node for behaviour the P1 vocabulary does not compile
verdict: INVALID — 1 error
`,
    )
  })

  it('the run report (completed)', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order: ['customers', 'filtered', 'aggregated'],
      result: {
        status: 'completed',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5 },
          { nodeId: 'filtered', relation: 'filtered', rowCount: 2 },
          { nodeId: 'aggregated', relation: 'aggregated', rowCount: 1 },
        ],
      },
      error: null,
    })
    expect(renderHumanPipelineRunReport(report)).toBe(
      `pipeline: unit_pipeline
nodes: 3
run:
  1. customers — source — materialized — 5 rows
  2. filtered — transform — materialized — 2 rows
  3. aggregated — sql — materialized — 1 row
outputs (addressable relations):
  aggregated — 1 row
note: relations live in this run's in-memory session and end when the process exits
verdict: COMPLETED — 3 of 3 nodes materialized
`,
    )
  })

  it('the run report (failed node)', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order: ['customers', 'filtered', 'aggregated'],
      result: null,
      error: {
        name: 'PipelineRunError',
        message: 'the pipeline node could not be materialized',
        nodeId: 'filtered',
        partial: [{ nodeId: 'customers', relation: 'customers' }],
      } as InstanceType<typeof import('@assay/engine-duckdb/node').PipelineRunError>,
    })
    expect(renderHumanPipelineRunReport(report)).toBe(
      `pipeline: unit_pipeline
nodes: 3
run:
  1. customers — source — materialized
  2. filtered — transform — FAILED
  3. aggregated — sql — not run
note: the failing node left no relation; earlier nodes left named relations in this run's in-memory session, which end when the process exits
verdict: FAILED — node "filtered" could not be materialized
`,
    )
  })

  it('the run report (canceled — unreachable from the CLI, renderer-honest)', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order: ['customers', 'filtered', 'aggregated'],
      result: { status: 'canceled', nodes: [], nextNodeId: 'customers' },
      error: null,
    })
    expect(renderHumanPipelineRunReport(report)).toBe(
      `pipeline: unit_pipeline
nodes: 3
run:
  1. customers — source — not run
  2. filtered — transform — not run
  3. aggregated — sql — not run
verdict: CANCELED — the run was abandoned before completion at node "customers"
`,
    )
  })

  it('hostile node ids are sanitized in every rendered line', () => {
    const hostile = parse(`version: 1
pipeline: "hostile\\u001b[31m"
nodes:
  "bad\\u0009id":
    type: source
    source:
      kind: file
      path: "x.csv\\u001b"
`)
    const validation = validatePipeline(hostile)
    if (!validation.ok) throw new Error('fixture must validate')
    const compile = compilePipeline(hostile)
    if (!compile.ok) throw new Error('fixture must compile')
    const report = buildPipelineValidateReport({ pipeline: hostile, validation, compile })
    const rendered = renderHumanPipelineValidateReport(report)
    expect(rendered).toContain('bad\\u0009id')
    expect(rendered).toContain('hostile\\u001b[31m')
    expect(rendered).toContain('x.csv\\u001b')
    // No raw control byte survives rendering.
    expect(hasRawControlByte(rendered)).toBe(false)
  })

  it('the enabled style wraps only the verdict/status words and counts', () => {
    const validation = validatePipeline(DAG_ERROR_PIPELINE)
    expect(validation.ok).toBe(false)
    const report = buildPipelineValidateReport({
      pipeline: DAG_ERROR_PIPELINE,
      validation,
      compile: null,
    })
    const styled = renderHumanPipelineValidateReport(report, createReportStyle(true))
    expect(styled).toContain('\u001b[31mINVALID\u001b[0m')
    expect(styled).toContain('\u001b[36m1\u001b[0m')
  })
})

describe('json renderers — envelope shape and key order', () => {
  it('the validate envelope carries the fixed keys in the documented order', () => {
    const validation = validatePipeline(VALID_PIPELINE)
    if (!validation.ok) throw new Error('fixture must validate')
    const compile = compilePipeline(VALID_PIPELINE)
    if (!compile.ok) throw new Error('fixture must compile')
    const report = buildPipelineValidateReport({ pipeline: VALID_PIPELINE, validation, compile })
    const payload = JSON.parse(renderJsonPipelineValidateReport(report)) as Record<string, unknown>
    expect(Object.keys(payload)).toEqual([
      'report',
      'reportVersion',
      'pipeline',
      'nodeCount',
      'valid',
      'order',
      'nodes',
      'errors',
    ])
    expect(payload.report).toBe('assay-pipeline-validate-report')
    expect(typeof payload.reportVersion).toBe('string')
    expect(payload.nodeCount).toBe(3)
    expect(payload.valid).toBe(true)
    // Per-node fixed key order.
    const nodes = payload.nodes as Record<string, unknown>[]
    expect(Object.keys(nodes[1] ?? {})).toEqual([
      'nodeId',
      'kind',
      'relation',
      'sourceKind',
      'sourcePath',
      'operation',
    ])
    expect(renderJsonPipelineValidateReport(report).endsWith('\n')).toBe(true)
  })

  it('the run envelope carries the fixed keys in the documented order', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order: ['customers', 'filtered', 'aggregated'],
      result: {
        status: 'completed',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5 },
          { nodeId: 'filtered', relation: 'filtered', rowCount: 2 },
          { nodeId: 'aggregated', relation: 'aggregated', rowCount: 1 },
        ],
      },
      error: null,
    })
    const rendered = renderJsonPipelineRunReport(report)
    const payload = JSON.parse(rendered) as Record<string, unknown>
    expect(Object.keys(payload)).toEqual([
      'report',
      'reportVersion',
      'pipeline',
      'sessionLifetime',
      'nodeCount',
      'status',
      'order',
      'nodes',
      'outputs',
      'failingNode',
      'nextNodeId',
    ])
    expect(payload.report).toBe('assay-pipeline-run-report')
    expect(payload.sessionLifetime).toBe('process')
    expect(payload.status).toBe('completed')
    expect(payload.failingNode).toBe(null)
    expect(payload.nextNodeId).toBe(null)
    const nodes = payload.nodes as Record<string, unknown>[]
    expect(Object.keys(nodes[0] ?? {})).toEqual([
      'nodeId',
      'kind',
      'relation',
      'status',
      'rowCount',
    ])
    expect(rendered.endsWith('\n')).toBe(true)
  })

  it('the run envelope marks a failed run with failingNode and null rowCounts', () => {
    const report = buildPipelineRunReport({
      pipeline: VALID_PIPELINE,
      order: ['customers', 'filtered', 'aggregated'],
      result: null,
      error: {
        name: 'PipelineRunError',
        message: 'the pipeline node could not be materialized',
        nodeId: 'filtered',
        partial: [{ nodeId: 'customers', relation: 'customers' }],
      } as InstanceType<typeof import('@assay/engine-duckdb/node').PipelineRunError>,
    })
    const payload = JSON.parse(renderJsonPipelineRunReport(report)) as Record<string, unknown>
    expect(payload.status).toBe('failed')
    expect(payload.failingNode).toBe('filtered')
    expect(payload.outputs).toEqual([])
    const nodes = payload.nodes as { nodeId: string; status: string; rowCount: number | null }[]
    expect(nodes.map((node) => [node.nodeId, node.status, node.rowCount])).toEqual([
      ['customers', 'materialized', null],
      ['filtered', 'failed', null],
      ['aggregated', 'not-run', null],
    ])
  })
})
