// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { canonicalNodeOrder } from '../ast.js'
import type { PipelineNode, PipelineValue, PipelineV1 } from '../ast.js'
import { parsePipeline } from '../parse.js'
import { COMPILED_TRANSFORM_OPERATIONS, compilePipeline } from './compile.js'
import type { PipelineCompilePlan } from './compile.js'

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
  it('exports exactly the four documented operations', () => {
    expect(COMPILED_TRANSFORM_OPERATIONS).toEqual(['select-columns', 'rename', 'cast', 'filter'])
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
    const errors = errorsOf(pipeline([source('raw'), transform('j', 'raw', 'join', { on: 'id' })]))
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
        transform('a', 'raw', 'aggregate', {}),
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
      ['unknown-operation', [source('raw'), transform('x', 'raw', 'join', { on: 'id' })]],
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
      ['diff', { id: 'd', type: 'diff', config: {} } as PipelineNode],
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
