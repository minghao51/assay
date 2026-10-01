// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { quoteIdentifier } from '@assay/validation'
import { canonicalNodeOrder } from '../ast.js'
import type { PipelineNode, PipelineValue, PipelineV1 } from '../ast.js'
import { parsePipeline } from '../parse.js'
import { makeTestRng } from '../property-testing.js'
import { COMPILED_TRANSFORM_OPERATIONS, compilePipeline } from './compile.js'
import type { PipelineCompilePlan } from './compile.js'
import { classifyVerbatimSql } from './sql-safety.js'

/** Build a canonically ordered pipeline from nodes. */
function pipeline(nodes: PipelineNode[]): PipelineV1 {
  return { version: 1, pipeline: 'demo', nodes: canonicalNodeOrder(nodes) }
}

function source(id: string): PipelineNode {
  return { id, type: 'source', source: { kind: 'file' } }
}

function transform(
  id: string,
  input: string,
  operation: string,
  args: Record<string, PipelineValue>,
): PipelineNode {
  return { id, type: 'transform', inputs: [input], operation: { operation, args } }
}

function okPlan(value: PipelineV1): PipelineCompilePlan {
  const result = compilePipeline(value)
  if (!result.ok) {
    throw new Error(`expected a plan, got: ${result.errors.map((error) => error.code).join(', ')}`)
  }
  return result.plan
}

function sqlOf(value: PipelineV1, nodeId: string): string {
  const entry = okPlan(value).nodes.find((node) => node.nodeId === nodeId)
  if (entry === undefined || entry.sql === null) throw new Error(`no SQL for ${nodeId}`)
  return entry.sql
}

function errorsOf(value: PipelineV1) {
  const result = compilePipeline(value)
  if (result.ok) throw new Error('expected a compile failure')
  return result.errors
}

const GOLDEN = pipeline([
  source('raw'),
  transform('picked', 'raw', 'select-columns', { columns: ['id', 'name'] }),
  transform('renamed', 'picked', 'rename', { columns: { name: 'full_name' } }),
  transform('typed', 'renamed', 'cast', { columns: { amount: 'DECIMAL' } }),
  transform('filtered', 'typed', 'filter', {
    predicates: [
      { column: 'country', operator: 'equals', value: 'SG' },
      { column: 'id', operator: 'greater-than', value: 10 },
    ],
  }),
  { id: 'final', type: 'sql', inputs: ['filtered'], sql: 'SELECT * FROM filtered' },
])

const GOLDEN_SQL: Readonly<Record<string, string>> = {
  raw: 'null-source',
  picked: 'SELECT\n  "id",\n  "name"\nFROM "raw"',
  renamed: 'SELECT\n  * EXCLUDE ("name"),\n  "name" AS "full_name"\nFROM "picked"',
  typed: 'SELECT\n  * REPLACE (\n    CAST("amount" AS DECIMAL) AS "amount"\n  )\nFROM "renamed"',
  filtered: 'SELECT\n  *\nFROM "typed"\nWHERE ("country" = \'SG\') AND ("id" > 10)',
  final: 'SELECT * FROM filtered',
}

describe('compilePipeline: golden SQL pins (byte-stable)', () => {
  it('emits one statement per executable node in topological order', () => {
    const plan = okPlan(GOLDEN)
    expect(plan.order).toEqual(['raw', 'picked', 'renamed', 'typed', 'filtered', 'final'])
    expect(plan.nodes.map((node) => node.nodeId)).toEqual(plan.order)
    expect(plan.nodes.map((node) => node.kind)).toEqual([
      'source',
      'transform',
      'transform',
      'transform',
      'transform',
      'sql',
    ])
  })

  it('pins the compiled SQL byte-for-byte', () => {
    const plan = okPlan(GOLDEN)
    for (const node of plan.nodes) {
      if (node.nodeId === 'raw') {
        expect(node.sql).toBeNull()
        continue
      }
      expect(node.sql).toBe(GOLDEN_SQL[node.nodeId])
    }
  })

  it('names relations by node id through quoteIdentifier (no generated names)', () => {
    const plan = okPlan(GOLDEN)
    const picked = plan.nodes.find((node) => node.nodeId === 'picked')
    expect(picked).toMatchObject({ relation: 'picked', quotedRelation: '"picked"' })
  })

  it('is deterministic: compiling the same AST twice is byte-identical', () => {
    const first = compilePipeline(GOLDEN)
    const second = compilePipeline(GOLDEN)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('canonicalizes argument mapping-key order (same AST meaning ⇒ same bytes)', () => {
    const nestedA = pipeline([
      source('raw'),
      transform('r', 'raw', 'rename', { columns: { a: 'x', b: 'y', c: 'z' } }),
    ])
    const nestedB = pipeline([
      source('raw'),
      transform('r', 'raw', 'rename', { columns: { c: 'z', a: 'x', b: 'y' } }),
    ])
    expect(sqlOf(nestedA, 'r')).toBe(sqlOf(nestedB, 'r'))
    expect(sqlOf(nestedA, 'r')).toBe(
      'SELECT\n  * EXCLUDE ("a", "b", "c"),\n  "a" AS "x",\n  "b" AS "y",\n  "c" AS "z"\nFROM "raw"',
    )
  })

  it('compiles a parsed YAML document to the same plan as the AST', () => {
    const text = `version: 1
pipeline: demo
nodes:
  raw:
    type: source
    source: {kind: file}
  picked:
    type: transform
    inputs: [raw]
    operation:
      select-columns:
        columns: [id, name]
  final:
    type: sql
    inputs: [picked]
    sql: SELECT * FROM picked
`
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(okPlan(parsed.pipeline).nodes.map((node) => node.sql)).toEqual([
      null,
      'SELECT\n  "id",\n  "name"\nFROM "raw"',
      'SELECT * FROM picked',
    ])
  })
})

describe('compilePipeline: transform vocabulary', () => {
  it('exports exactly the seven documented operations', () => {
    expect(COMPILED_TRANSFORM_OPERATIONS).toEqual([
      'select-columns',
      'rename',
      'cast',
      'filter',
      'join',
      'aggregate',
      'window',
    ])
  })

  it('compiles every filter operator', () => {
    const cases: readonly [Record<string, PipelineValue>, string][] = [
      [{ column: 'a', operator: 'equals', value: 'x' }, `"a" = 'x'`],
      [{ column: 'a', operator: 'not-equals', value: 'x' }, `"a" <> 'x'`],
      [{ column: 'a', operator: 'less-than', value: 1 }, '"a" < 1'],
      [{ column: 'a', operator: 'less-than-or-equal', value: 1 }, '"a" <= 1'],
      [{ column: 'a', operator: 'greater-than', value: 1 }, '"a" > 1'],
      [{ column: 'a', operator: 'greater-than-or-equal', value: 1 }, '"a" >= 1'],
      [{ column: 'a', operator: 'is-null' }, '"a" IS NULL'],
      [{ column: 'a', operator: 'is-not-null' }, '"a" IS NOT NULL'],
      [{ column: 'a', operator: 'in', values: [1, 2] }, '"a" IN (1, 2)'],
      [{ column: 'a', operator: 'not-in', values: ['x', true] }, `"a" NOT IN ('x', TRUE)`],
    ]
    for (const [predicate, expected] of cases) {
      const sql = sqlOf(
        pipeline([source('raw'), transform('f', 'raw', 'filter', { predicates: [predicate] })]),
        'f',
      )
      expect(sql).toBe(`SELECT\n  *\nFROM "raw"\nWHERE (${expected})`)
    }
  })

  it('renders boolean and string literals through the shared helpers', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'flag', operator: 'equals', value: true }],
        }),
      ]),
      'f',
    )
    expect(sql).toBe(`SELECT\n  *\nFROM "raw"\nWHERE ("flag" = TRUE)`)
  })

  it('compiles in/not-in with multiple literals', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'c', operator: 'not-in', values: ['x', 'y'] }],
        }),
      ]),
      'f',
    )
    expect(sql).toBe(`SELECT\n  *\nFROM "raw"\nWHERE ("c" NOT IN ('x', 'y'))`)
  })

  it('refuses an unknown operation, citing the escape hatch', () => {
    const errors = errorsOf(
      pipeline([source('raw'), transform('j', 'raw', 'flatten', { on: 'id' })]),
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('unknown-operation')
    expect(errors[0]?.message).toContain('sql node')
    expect(errors[0]?.message).toContain('select-columns')
  })
})

describe('compilePipeline: argument validation', () => {
  it('refuses a non-unary transform input list', () => {
    const errors = errorsOf(
      pipeline([
        source('a'),
        source('b'),
        {
          id: 't',
          type: 'transform',
          inputs: ['a', 'b'],
          operation: { operation: 'filter', args: { predicates: [] } },
        },
      ]),
    )
    expect(errors[0]?.code).toBe('invalid-operation-args')
    expect(errors[0]?.message).toContain('unary')
  })

  it('refuses duplicate select-columns and empty projections', () => {
    const duplicate = errorsOf(
      pipeline([source('raw'), transform('s', 'raw', 'select-columns', { columns: ['a', 'a'] })]),
    )
    expect(duplicate[0]?.code).toBe('invalid-operation-args')
    expect(duplicate[0]?.message).toContain('duplicate')

    const empty = errorsOf(
      pipeline([source('raw'), transform('s', 'raw', 'select-columns', { columns: [] })]),
    )
    expect(empty[0]?.code).toBe('invalid-operation-args')
  })

  it('refuses unexpected argument keys', () => {
    const errors = errorsOf(
      pipeline([source('raw'), transform('f', 'raw', 'filter', { expression: "country = 'SG'" })]),
    )
    expect(errors.map((error) => error.code)).toContain('invalid-operation-args')
    expect(errors.some((error) => error.message.includes('sql node'))).toBe(true)
  })

  it('refuses unknown cast types with a vocabulary hint, and non-string spellings', () => {
    const unknown = errorsOf(
      pipeline([source('raw'), transform('c', 'raw', 'cast', { columns: { a: 'STRIN' } })]),
    )
    expect(unknown[0]?.code).toBe('invalid-cast-type')
    expect(unknown[0]?.message).toContain('VARCHAR')

    const wrong = errorsOf(
      pipeline([source('raw'), transform('c', 'raw', 'cast', { columns: { a: 3 } })]),
    )
    expect(wrong[0]?.code).toBe('invalid-cast-type')
  })

  it('refuses malformed filter predicates and null literals', () => {
    const nullValue = errorsOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'a', operator: 'equals', value: null }],
        }),
      ]),
    )
    expect(nullValue[0]?.code).toBe('invalid-filter')

    const nullOperatorValue = errorsOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'a', operator: 'is-null', value: 1 }],
        }),
      ]),
    )
    expect(nullOperatorValue[0]?.code).toBe('invalid-filter')

    const unknownOperator = errorsOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'a', operator: 'matches', value: 'x' }],
        }),
      ]),
    )
    expect(unknownOperator[0]?.code).toBe('invalid-filter')

    const emptyIn = errorsOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'a', operator: 'in', values: [] }],
        }),
      ]),
    )
    expect(emptyIn[0]?.code).toBe('invalid-filter')
  })

  it('collects independent refusals across nodes', () => {
    const errors = errorsOf(
      pipeline([
        source('raw'),
        transform('a', 'raw', 'flatten', {}),
        transform('b', 'raw', 'cast', { columns: { x: 'NOPE' } }),
      ]),
    )
    expect(errors.map((error) => error.code).sort()).toEqual([
      'invalid-cast-type',
      'unknown-operation',
    ])
  })

  it('points each operation/filter/cast refusal at the sql-node escape hatch', () => {
    const cases: readonly (readonly [string, PipelineNode[]])[] = [
      ['unknown-operation', [source('raw'), transform('x', 'raw', 'flatten', { on: 'id' })]],
      [
        'invalid-operation-args',
        [source('raw'), transform('s', 'raw', 'select-columns', { columns: [] })],
      ],
      [
        'invalid-cast-type',
        [source('raw'), transform('c', 'raw', 'cast', { columns: { a: 'STRIN' } })],
      ],
      [
        'invalid-filter',
        [
          source('raw'),
          transform('f', 'raw', 'filter', {
            predicates: [{ column: 'a', operator: 'equals', value: null }],
          }),
        ],
      ],
    ]
    for (const [code, nodes] of cases) {
      const errors = errorsOf(pipeline(nodes))
      expect(errors[0]?.code, code).toBe(code)
      expect(errors[0]?.message, code).toContain('sql node')
      expect(errors[0]?.message, code).toContain('verbatim SQL with declared inputs')
    }
  })
})

describe('compilePipeline: reserved and verbatim SQL', () => {
  it('refuses validate/diff/publish as reserved until P2', () => {
    const forType = (node: PipelineNode) => errorsOf(pipeline([source('raw'), node]))
    for (const [type, node] of [
      ['validate', { id: 'v', type: 'validate', input: 'raw', contract: 'c.yaml' } as PipelineNode],
      ['diff', { id: 'd', type: 'diff', input: 'raw', against: 'raw' } as PipelineNode],
      ['publish', { id: 'p', type: 'publish', input: 'raw' } as PipelineNode],
    ] as const) {
      const errors = forType(node)
      expect(errors[0]?.code, type).toBe('reserved-node-class')
      expect(errors[0]?.message, type).toContain('P2')
    }
  })

  it('accepts a single read-only verbatim sql node and carries it verbatim', () => {
    const sql = 'WITH x AS (SELECT 1)\nSELECT * FROM x'
    const plan = okPlan(pipeline([{ id: 'q', type: 'sql', inputs: [], sql }]))
    expect(plan.nodes[0]?.sql).toBe(sql)
  })

  it('refuses a multi-statement verbatim sql body', () => {
    const errors = errorsOf(
      pipeline([{ id: 'q', type: 'sql', inputs: [], sql: 'SELECT 1; DROP TABLE t' }]),
    )
    expect(errors[0]?.code).toBe('invalid-sql')
  })

  it('refuses a verbatim sql body with a forbidden keyword', () => {
    const errors = errorsOf(
      pipeline([
        {
          id: 'q',
          type: 'sql',
          inputs: [],
          sql: 'WITH x AS (DELETE FROM t RETURNING 1) SELECT * FROM x',
        },
      ]),
    )
    expect(errors[0]?.code).toBe('invalid-sql')
    // Value-free: the message never echoes the SQL or the forbidden keyword.
    expect(errors[0]?.message).not.toContain('DELETE')
  })
})

describe('compilePipeline: injection safety for hostile identifiers', () => {
  it('quotes hostile column names through the shared helper', () => {
    const hostile = 'a" ; DROP TABLE t; --'
    const sql = sqlOf(
      pipeline([source('raw'), transform('s', 'raw', 'select-columns', { columns: [hostile] })]),
      's',
    )
    expect(sql).toBe(`SELECT\n  "a"" ; DROP TABLE t; --"\nFROM "raw"`)
  })

  it('quotes hostile relation ids and filter columns', () => {
    const plan = okPlan(
      pipeline([
        { id: 'weird "quoted" key', type: 'source', source: { kind: 'file' } },
        transform('f', 'weird "quoted" key', 'filter', {
          predicates: [{ column: 'c" ; DROP', operator: 'equals', value: "o'brien" }],
        }),
      ]),
    )
    const filtered = plan.nodes.find((node) => node.nodeId === 'f')
    expect(filtered?.sql).toBe(
      `SELECT\n  *\nFROM "weird ""quoted"" key"\nWHERE ("c"" ; DROP" = 'o''brien')`,
    )
  })

  it('renders string literals with single-quote doubling', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', {
          predicates: [{ column: 'a', operator: 'equals', value: "x''y" }],
        }),
      ]),
      'f',
    )
    expect(sql).toContain(`'x''''y'`)
  })
})

describe('compilePipeline: validated input and totality', () => {
  it('reports unresolved references through DAG validation instead of emitting SQL', () => {
    const errors = errorsOf(
      pipeline([transform('t', 'missing', 'select-columns', { columns: ['a'] })]),
    )
    expect(errors[0]?.code).toBe('unresolved-reference')
  })

  it('reports a cycle through DAG validation', () => {
    const a: PipelineNode = {
      id: 'a',
      type: 'transform',
      inputs: ['b'],
      operation: { operation: 'filter', args: { predicates: [] } },
    }
    const b: PipelineNode = {
      id: 'b',
      type: 'transform',
      inputs: ['a'],
      operation: { operation: 'filter', args: { predicates: [] } },
    }
    expect(errorsOf(pipeline([a, b]))[0]?.code).toBe('cycle')
  })

  it('never throws on a hostile value behind a cast', () => {
    const hostile = {
      version: 1,
      pipeline: 'demo',
      nodes: [
        {
          get id(): string {
            throw new Error('boom')
          },
          type: 'source',
          source: { kind: 'file' },
        },
      ],
    } as unknown as PipelineV1
    expect(() => compilePipeline(hostile)).not.toThrow()
    const result = compilePipeline(hostile)
    expect(result.ok).toBe(false)
  })

  it('refuses a node type outside the class vocabulary (defensive)', () => {
    const errors = errorsOf(
      pipeline([{ id: 'x', type: 'mystery', source: { kind: 'file' } } as unknown as PipelineNode]),
    )
    expect(errors[0]?.code).toBe('invalid-node')
  })
})

describe('compilePipeline: defensive argument branches', () => {
  const filterErrors = (predicates: unknown) =>
    errorsOf(
      pipeline([
        source('raw'),
        transform('f', 'raw', 'filter', { predicates: predicates as PipelineValue }),
      ]),
    )

  it('refuses a non-mapping predicate', () => {
    expect(filterErrors(['not-a-map'])[0]?.code).toBe('invalid-filter')
  })

  it('refuses a binary predicate that also carries values', () => {
    expect(
      filterErrors([{ column: 'a', operator: 'equals', value: 1, values: [1] }])[0]?.code,
    ).toBe('invalid-filter')
  })

  it('refuses a list operator without values and with a null entry', () => {
    expect(filterErrors([{ column: 'a', operator: 'in' }])[0]?.code).toBe('invalid-filter')
    expect(filterErrors([{ column: 'a', operator: 'in', values: ['x', null] }])[0]?.code).toBe(
      'invalid-filter',
    )
  })

  it('refuses a non-string operator and a predicate without a column', () => {
    expect(filterErrors([{ column: 'a', operator: 3 }])[0]?.code).toBe('invalid-filter')
    expect(filterErrors([{ operator: 'is-null' }])[0]?.code).toBe('invalid-filter')
  })

  it('refuses empty rename/cast mappings and a non-list projection', () => {
    expect(
      errorsOf(pipeline([source('raw'), transform('r', 'raw', 'rename', { columns: {} })]))[0]
        ?.code,
    ).toBe('invalid-operation-args')
    expect(
      errorsOf(pipeline([source('raw'), transform('c', 'raw', 'cast', { columns: {} })]))[0]?.code,
    ).toBe('invalid-operation-args')
    expect(
      errorsOf(
        pipeline([source('raw'), transform('s', 'raw', 'select-columns', { columns: 'a' })]),
      )[0]?.code,
    ).toBe('invalid-operation-args')
  })
})

describe('compilePipeline: materialization → local statements (p2-3; ADR 0033)', () => {
  const QUERY = 'SELECT\n  "id"\nFROM "raw"'

  /** A `raw` source plus one `out` transform declaring the given mode. */
  function materializedNode(materialization: unknown): PipelineNode {
    return {
      id: 'out',
      type: 'transform',
      inputs: ['raw'],
      operation: { operation: 'select-columns', args: { columns: ['id'] } },
      ...(materialization !== undefined ? { materialization } : {}),
    } as unknown as PipelineNode
  }

  function entry(materialization: unknown) {
    const plan = okPlan(pipeline([source('raw'), materializedNode(materialization)]))
    const node = plan.nodes.find((candidate) => candidate.nodeId === 'out')
    if (node === undefined) throw new Error('no out node')
    return node
  }

  it('maps view (the absent default) to CREATE OR REPLACE VIEW', () => {
    for (const materialization of [undefined, 'view']) {
      expect(entry(materialization)).toMatchObject({
        materialization: 'view',
        statement: `CREATE OR REPLACE VIEW "out" AS ${QUERY}`,
        statementKind: 'view',
        sql: QUERY,
      })
    }
  })

  it('maps ephemeral to the view mechanism (DuckDB views are lazy/session-bound)', () => {
    expect(entry('ephemeral')).toMatchObject({
      materialization: 'ephemeral',
      statement: `CREATE OR REPLACE VIEW "out" AS ${QUERY}`,
      statementKind: 'view',
    })
  })

  it('maps table to CREATE OR REPLACE TABLE AS', () => {
    expect(entry('table')).toMatchObject({
      materialization: 'table',
      statement: `CREATE OR REPLACE TABLE "out" AS ${QUERY}`,
      statementKind: 'table',
    })
  })

  it('maps export to a deterministic COPY with the pinned Parquet options', () => {
    expect(entry('export')).toMatchObject({
      materialization: 'export',
      statement: `COPY (${QUERY}) TO 'assay-exports/assay-export-out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`,
      statementKind: 'export',
    })
  })

  it('leaves a source statement-free but carries its effective mode', () => {
    const plan = okPlan(pipeline([source('raw')]))
    expect(plan.nodes[0]).toMatchObject({
      materialization: 'view',
      statement: null,
      statementKind: 'source',
    })
  })

  it('refuses cache/incremental/publish with a typed, value-free refusal citing ADR 0033', () => {
    for (const mode of ['cache', 'incremental', 'publish'] as const) {
      const errors = errorsOf(pipeline([source('raw'), materializedNode(mode)]))
      expect(errors).toHaveLength(1)
      expect(errors[0]?.code, mode).toBe('unsupported-materialization')
      expect(errors[0]?.message, mode).toContain('ADR 0033')
      expect(errors[0]?.message, mode).toContain(mode)
      expect(errors[0]?.message, mode).not.toContain('SELECT')
    }
  })

  it('refuses an unrecognized mode spelling programmatically (defensive)', () => {
    const errors = errorsOf(pipeline([source('raw'), materializedNode('CACHE')]))
    expect(errors[0]?.code).toBe('unsupported-materialization')
    expect(errors[0]?.message).toContain('ephemeral')
  })

  it('applies the refusal to a source node too', () => {
    const node = {
      id: 'raw',
      type: 'source',
      materialization: 'incremental',
      source: { kind: 'file' },
    } as unknown as PipelineNode
    expect(errorsOf(pipeline([node]))[0]?.code).toBe('unsupported-materialization')
  })
})

describe('compilePipeline: join / aggregate / window golden SQL', () => {
  it('compiles an inner join as USING over the two inputs', () => {
    const sql = sqlOf(
      pipeline([
        source('customers'),
        source('policies'),
        {
          id: 'joined',
          type: 'transform',
          inputs: ['customers', 'policies'],
          operation: {
            operation: 'join',
            args: { left: 'customers', right: 'policies', on: ['customer_id'] },
          },
        },
      ]),
      'joined',
    )
    expect(sql).toBe('SELECT\n  *\nFROM "customers"\nINNER JOIN "policies" USING ("customer_id")')
  })

  it('honours the declared left/right order and multi-column USING keys', () => {
    const sql = sqlOf(
      pipeline([
        source('customers'),
        source('policies'),
        {
          id: 'joined',
          type: 'transform',
          inputs: ['customers', 'policies'],
          operation: {
            operation: 'join',
            args: { left: 'policies', right: 'customers', on: ['a', 'b'] },
          },
        },
      ]),
      'joined',
    )
    expect(sql).toBe('SELECT\n  *\nFROM "policies"\nINNER JOIN "customers" USING ("a", "b")')
  })

  it('compiles a grouped aggregate with SUM and COUNT(*)', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('agg', 'raw', 'aggregate', {
          group_by: ['country'],
          aggregations: [
            { op: 'sum', column: 'income', as: 'total' },
            { op: 'count', as: 'n' },
          ],
        }),
      ]),
      'agg',
    )
    expect(sql).toBe(
      'SELECT\n  "country",\n  SUM("income") AS "total",\n  COUNT(*) AS "n"\nFROM "raw"\nGROUP BY "country"',
    )
  })

  it('compiles a global aggregate when group_by is empty', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('agg', 'raw', 'aggregate', {
          group_by: [],
          aggregations: [{ op: 'avg', column: 'x', as: 'mean' }],
        }),
      ]),
      'agg',
    )
    expect(sql).toBe('SELECT\n  AVG("x") AS "mean"\nFROM "raw"')
  })

  it('compiles a window function with partition and ordered terms', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('w', 'raw', 'window', {
          function: 'row_number',
          partition_by: ['country'],
          order_by: [
            { column: 'income', direction: 'desc' },
            { column: 'id', direction: 'asc' },
          ],
          as: 'rank',
        }),
      ]),
      'w',
    )
    expect(sql).toBe(
      'SELECT\n  *,\n  ROW_NUMBER() OVER (PARTITION BY "country" ORDER BY "income" DESC, "id" ASC) AS "rank"\nFROM "raw"',
    )
  })

  it('compiles a window function without a partition', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('w', 'raw', 'window', {
          function: 'dense_rank',
          order_by: [{ column: 'id', direction: 'asc' }],
          as: 'dr',
        }),
      ]),
      'w',
    )
    expect(sql).toBe('SELECT\n  *,\n  DENSE_RANK() OVER (ORDER BY "id" ASC) AS "dr"\nFROM "raw"')
  })

  it('is byte-deterministic across the new ops and modes', () => {
    const value = pipeline([
      source('customers'),
      source('policies'),
      {
        id: 'joined',
        type: 'transform',
        inputs: ['customers', 'policies'],
        operation: {
          operation: 'join',
          args: { left: 'customers', right: 'policies', on: ['customer_id'] },
        },
      },
      {
        id: 'agg',
        type: 'transform',
        materialization: 'table',
        inputs: ['joined'],
        operation: {
          operation: 'aggregate',
          args: { group_by: ['customer_id'], aggregations: [{ op: 'count', as: 'n' }] },
        },
      },
      {
        id: 'ranked',
        type: 'transform',
        materialization: 'export',
        inputs: ['agg'],
        operation: {
          operation: 'window',
          args: {
            function: 'rank',
            partition_by: ['customer_id'],
            order_by: [{ column: 'n', direction: 'desc' }],
            as: 'rank',
          },
        },
      },
    ])
    const first = compilePipeline(value)
    const second = compilePipeline(value)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})

describe('compilePipeline: new-op refusals cite the escape hatch', () => {
  const joinWith = (inputs: string[], args: Record<string, PipelineValue>): PipelineNode[] => [
    source('a'),
    source('b'),
    { id: 'j', type: 'transform', inputs, operation: { operation: 'join', args } },
  ]

  it('refuses a join without exactly two inputs', () => {
    const errors = errorsOf(pipeline(joinWith(['a'], { left: 'a', right: 'a', on: ['id'] })))
    expect(errors[0]?.code).toBe('invalid-operation-args')
    expect(errors[0]?.message).toContain('binary')
    expect(errors[0]?.message).toContain('sql node')
  })

  it('refuses a join whose left/right are not the node inputs or are equal', () => {
    const notInputs = errorsOf(
      pipeline(joinWith(['a', 'b'], { left: 'c', right: 'b', on: ['id'] })),
    )
    expect(notInputs[0]?.code).toBe('invalid-operation-args')
    const equal = errorsOf(pipeline(joinWith(['a', 'b'], { left: 'a', right: 'a', on: ['id'] })))
    expect(equal[0]?.code).toBe('invalid-operation-args')
  })

  it('refuses join/aggregate/window argument shapes with the escape hatch appended', () => {
    const cases: readonly (readonly [string, PipelineNode])[] = [
      [
        'j',
        {
          id: 'j',
          type: 'transform',
          inputs: ['a', 'b'],
          operation: { operation: 'join', args: { left: 'a', right: 'b', on: [] } },
        } as PipelineNode,
      ],
      [
        'agg',
        {
          id: 'agg',
          type: 'transform',
          inputs: ['a'],
          operation: {
            operation: 'aggregate',
            args: { group_by: [], aggregations: [{ op: 'nope', column: 'x', as: 'y' }] },
          },
        } as PipelineNode,
      ],
      [
        'agg2',
        {
          id: 'agg2',
          type: 'transform',
          inputs: ['a'],
          operation: {
            operation: 'aggregate',
            args: { group_by: [], aggregations: [{ op: 'sum', as: 'y' }] },
          },
        } as PipelineNode,
      ],
      [
        'w',
        {
          id: 'w',
          type: 'transform',
          inputs: ['a'],
          operation: {
            operation: 'window',
            args: { function: 'ntile', order_by: [{ column: 'x', direction: 'asc' }], as: 'y' },
          },
        } as PipelineNode,
      ],
      [
        'w2',
        {
          id: 'w2',
          type: 'transform',
          inputs: ['a'],
          operation: {
            operation: 'window',
            args: { function: 'rank', order_by: [{ column: 'x', direction: 'sideways' }], as: 'y' },
          },
        } as PipelineNode,
      ],
    ]
    for (const [label, node] of cases) {
      const errors = errorsOf(pipeline([source('a'), source('b'), node]))
      expect(errors[0]?.code, label).toBe('invalid-operation-args')
      expect(errors[0]?.message, label).toContain('sql node')
      expect(errors[0]?.message, label).toContain('verbatim SQL with declared inputs')
    }
  })

  it('refuses malformed aggregate arguments', () => {
    const cases: PipelineValue[] = [
      { group_by: 'x', aggregations: [{ op: 'sum', column: 'c', as: 'a' }] },
      { group_by: [], aggregations: 'nope' },
      { group_by: [], aggregations: ['nope'] },
      {
        group_by: [],
        aggregations: [
          { op: 'sum', column: 'c', as: 'a' },
          { op: 'max', column: 'c', as: 'a' },
        ],
      },
      { group_by: [], aggregations: [{ op: 'sum', as: 'a' }] },
      { group_by: ['a', 'a'], aggregations: [{ op: 'count', as: 'n' }] },
      { group_by: [], aggregations: [{ op: 'sum', column: '', as: 'a' }] },
      { group_by: [], aggregations: [{ op: 'sum', column: 'c', as: '' }] },
      { group_by: [], aggregations: [{ op: 'sum', column: 'c', as: 'a', extra: 1 }] },
      { group_by: [], aggregations: [{ op: 'sum', column: 'c' }] },
      { group_by: [3], aggregations: [{ op: 'count', as: 'n' }] },
    ]
    for (const args of cases) {
      const errors = errorsOf(
        pipeline([
          source('raw'),
          transform('agg', 'raw', 'aggregate', args as Record<string, PipelineValue>),
        ]),
      )
      expect(errors.length, JSON.stringify(args)).toBeGreaterThan(0)
      expect(errors.every((error) => error.code === 'invalid-operation-args')).toBe(true)
    }
  })

  it('refuses malformed window arguments', () => {
    const cases: PipelineValue[] = [
      { function: 'rank', order_by: 'x', as: 'r' },
      { function: 'rank', order_by: [], as: 'r' },
      { function: 'rank', order_by: ['nope'], as: 'r' },
      { function: 'rank', order_by: [{}], as: 'r' },
      { function: 'rank', order_by: [{ column: 'a' }], as: 'r' },
      {
        function: 'rank',
        order_by: [
          { column: 'a', direction: 'asc' },
          { column: 'a', direction: 'desc' },
        ],
        as: 'r',
      },
      { function: 'rank', order_by: [{ column: 'a', direction: 'asc', extra: 1 }], as: 'r' },
      { function: 'rank', order_by: [{ column: 'a', direction: 'asc' }], as: '' },
      {
        function: 'rank',
        order_by: [{ column: 'a', direction: 'asc' }],
        partition_by: [],
        as: 'r',
      },
      {
        function: 'rank',
        order_by: [{ column: 'a', direction: 'asc' }],
        partition_by: ['p', 'p'],
        as: 'r',
      },
      { function: 'rank', order_by: [{ column: 'a', direction: 'asc' }], as: 'r', extra: 1 },
    ]
    for (const args of cases) {
      const errors = errorsOf(
        pipeline([
          source('raw'),
          transform('w', 'raw', 'window', args as Record<string, PipelineValue>),
        ]),
      )
      expect(errors.length, JSON.stringify(args)).toBeGreaterThan(0)
      expect(errors.every((error) => error.code === 'invalid-operation-args')).toBe(true)
    }
  })

  it('refuses malformed join arguments beyond arity', () => {
    const cases: Record<string, PipelineValue>[] = [
      { right: 'b', on: ['id'] },
      { left: 'a', on: ['id'] },
      { left: 'a', right: 'b', on: 'id' },
      { left: 'a', right: 'b', on: [] },
      { left: 'a', right: 'b', on: ['id'], extra: 1 },
      { left: 'a', right: 'b', on: [3] },
    ]
    for (const args of cases) {
      const errors = errorsOf(pipeline(joinWith(['a', 'b'], args)))
      expect(errors.length, JSON.stringify(args)).toBeGreaterThan(0)
      expect(errors.every((error) => error.code === 'invalid-operation-args')).toBe(true)
    }
  })
})

describe('compilePipeline: injection probes through the new ops', () => {
  it('quotes hostile join refs and columns', () => {
    const hostile = 'a" ; DROP TABLE t; --'
    const sql = sqlOf(
      pipeline([
        { id: 'l"', type: 'source', source: { kind: 'file' } },
        { id: 'r"', type: 'source', source: { kind: 'file' } },
        {
          id: 'j',
          type: 'transform',
          inputs: ['l"', 'r"'],
          operation: { operation: 'join', args: { left: 'l"', right: 'r"', on: [hostile] } },
        },
      ]),
      'j',
    )
    expect(sql).toBe('SELECT\n  *\nFROM "l"""\nINNER JOIN "r""" USING ("a"" ; DROP TABLE t; --")')
  })

  it('quotes hostile aggregate columns and aliases', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('agg', 'raw', 'aggregate', {
          group_by: ['g"'],
          aggregations: [{ op: 'sum', column: 'c" ; DROP', as: 'x"' }],
        }),
      ]),
      'agg',
    )
    expect(sql).toBe('SELECT\n  "g""",\n  SUM("c"" ; DROP") AS "x"""\nFROM "raw"\nGROUP BY "g"""')
  })

  it('quotes hostile window partitions, order columns, and aliases', () => {
    const sql = sqlOf(
      pipeline([
        source('raw'),
        transform('w', 'raw', 'window', {
          function: 'rank',
          partition_by: ['p"'],
          order_by: [{ column: 'o"', direction: 'desc' }],
          as: 'w"',
        }),
      ]),
      'w',
    )
    expect(sql).toBe(
      'SELECT\n  *,\n  RANK() OVER (PARTITION BY "p""" ORDER BY "o""" DESC) AS "w"""\nFROM "raw"',
    )
  })

  it('encodes a traversal-shaped node id into a path-safe export stem', () => {
    const plan = okPlan(
      pipeline([
        source('raw'),
        {
          id: '../escape',
          type: 'transform',
          materialization: 'export',
          inputs: ['raw'],
          operation: { operation: 'select-columns', args: { columns: ['id'] } },
        },
      ]),
    )
    const node = plan.nodes.find((candidate) => candidate.nodeId === '../escape')
    expect(node?.statement).toBe(
      `COPY (SELECT\n  "id"\nFROM "raw") TO 'assay-exports/assay-export-~002e~002e~002fescape.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`,
    )
    expect(node?.statement).not.toContain("'../")
  })

  it('keeps a single quote out of the export destination string', () => {
    const plan = okPlan(
      pipeline([
        source('raw'),
        {
          id: "o'brien",
          type: 'transform',
          materialization: 'export',
          inputs: ['raw'],
          operation: { operation: 'select-columns', args: { columns: ['id'] } },
        },
      ]),
    )
    const node = plan.nodes.find((candidate) => candidate.nodeId === "o'brien")
    expect(node?.statement).toContain("'assay-exports/assay-export-o~0027brien.parquet'")
  })
})

describe('compilePipeline: property — generated ops stay quoted, classified, and deterministic', () => {
  const HOSTILE = ['a', 'a"b', "a'b", 'a b', '\u00fcn\u00ef', '../x', '1', 'a.b']

  it('holds for 240 seeded unary pipelines (seed 20261003)', () => {
    const rng = makeTestRng(20261003)
    for (let i = 0; i < 240; i++) {
      const column = rng.pick(HOSTILE)
      const alias = `out_${String(i)}`
      const templates: readonly (readonly [string, Record<string, PipelineValue>])[] = [
        ['filter', { predicates: [{ column, operator: 'equals', value: 'x' }] }],
        ['select-columns', { columns: [column] }],
        ['rename', { columns: { [column]: alias } }],
        ['aggregate', { group_by: [column], aggregations: [{ op: 'sum', column, as: alias }] }],
        ['window', { function: 'rank', order_by: [{ column, direction: 'desc' }], as: alias }],
      ]
      const [name, args] = rng.pick(templates) as readonly [string, Record<string, PipelineValue>]
      const value = pipeline([source('raw'), transform('t', 'raw', name, args)])
      const first = compilePipeline(value)
      const second = compilePipeline(value)
      expect(first.ok, `${name} ${column}`).toBe(true)
      if (!first.ok) continue
      expect(JSON.stringify(second), `${name} ${column}`).toBe(JSON.stringify(first))
      const entry = first.plan.nodes.find((node) => node.nodeId === 't')
      if (entry === undefined || entry.sql === null) throw new Error('missing compiled sql')
      expect(classifyVerbatimSql(entry.sql).ok, name).toBe(true)
      expect(entry.sql, name).toContain(quoteIdentifier(column))
    }
  })

  it('holds for 120 seeded joins (seed 20261004)', () => {
    const rng = makeTestRng(20261004)
    for (let i = 0; i < 120; i++) {
      const left = rng.pick(HOSTILE)
      const right = rng.pick(HOSTILE.filter((candidate) => candidate !== left))
      const on = rng.pick(HOSTILE)
      const value = pipeline([
        { id: left, type: 'source', source: { kind: 'file' } },
        { id: right, type: 'source', source: { kind: 'file' } },
        {
          id: 'joined',
          type: 'transform',
          inputs: [left, right],
          operation: { operation: 'join', args: { left, right, on: [on] } },
        },
      ])
      const first = compilePipeline(value)
      expect(first.ok, `${left} | ${right} | ${on}`).toBe(true)
      if (!first.ok) continue
      const entry = first.plan.nodes.find((node) => node.nodeId === 'joined')
      if (entry?.sql == null) throw new Error('missing join sql')
      expect(entry.sql).toContain(quoteIdentifier(left))
      expect(entry.sql).toContain(quoteIdentifier(right))
      expect(entry.sql).toContain(quoteIdentifier(on))
      expect(classifyVerbatimSql(entry.sql).ok).toBe(true)
    }
  })
})
