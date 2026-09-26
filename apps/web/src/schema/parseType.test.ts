// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { DuckDbType } from './parseType'
import { formatDuckDbType, parseDuckDbType } from './parseType'

/**
 * The exact string DuckDB's DESCRIBE produces for fixtures/parquet/
 * nested.parquet (m1-4 e2e asserts it as the engine's passthrough; m1-6
 * parses it into the schema panel tree).
 */
const NESTED_PARQUET_PAYLOAD =
  'STRUCT("name" VARCHAR, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)), ' +
  'tags VARCHAR[], scores STRUCT(q1 DOUBLE, q2 INTEGER))'

const primitive = (label: string): DuckDbType => ({ kind: 'primitive', label })
const field = (name: string, type: DuckDbType): { name: string; type: DuckDbType } => ({
  name,
  type,
})

describe('parseDuckDbType — flat types', () => {
  it('parses plain primitives', () => {
    expect(parseDuckDbType('BIGINT')).toEqual(primitive('BIGINT'))
    expect(parseDuckDbType('VARCHAR')).toEqual(primitive('VARCHAR'))
    expect(parseDuckDbType('DOUBLE')).toEqual(primitive('DOUBLE'))
    expect(parseDuckDbType('DATE')).toEqual(primitive('DATE'))
    expect(parseDuckDbType('BOOLEAN')).toEqual(primitive('BOOLEAN'))
  })

  it('parses parameterized primitives with raw parameter capture', () => {
    expect(parseDuckDbType('DECIMAL(21,1)')).toEqual(primitive('DECIMAL(21,1)'))
    expect(parseDuckDbType('DECIMAL(18, 3)')).toEqual(primitive('DECIMAL(18,3)'))
    expect(parseDuckDbType('TIMESTAMP(3)')).toEqual(primitive('TIMESTAMP(3)'))
  })

  it('parses multi-word primitives', () => {
    expect(parseDuckDbType('TIMESTAMP WITH TIME ZONE')).toEqual(
      primitive('TIMESTAMP WITH TIME ZONE'),
    )
    expect(parseDuckDbType('TIME WITH TIME ZONE')).toEqual(primitive('TIME WITH TIME ZONE'))
  })

  it('is whitespace-insensitive around flat types', () => {
    expect(parseDuckDbType('  BIGINT  ')).toEqual(primitive('BIGINT'))
  })
})

describe('parseDuckDbType — the exact nested.parquet payload type', () => {
  it('parses the full struct into the navigable tree', () => {
    expect(parseDuckDbType(NESTED_PARQUET_PAYLOAD)).toEqual({
      kind: 'struct',
      fields: [
        field('name', primitive('VARCHAR')),
        field('geo', {
          kind: 'struct',
          fields: [
            field('lat', primitive('DECIMAL(21,1)')),
            field('lon', primitive('DECIMAL(21,1)')),
          ],
        }),
        field('tags', { kind: 'list', element: primitive('VARCHAR'), dimensions: '[]' }),
        field('scores', {
          kind: 'struct',
          fields: [field('q1', primitive('DOUBLE')), field('q2', primitive('INTEGER'))],
        }),
      ],
    })
  })

  it('parses the flat sibling column type', () => {
    expect(parseDuckDbType('BIGINT')).toEqual(primitive('BIGINT'))
  })
})

describe('parseDuckDbType — quoted field names', () => {
  it('unquotes quoted field names (DuckDB quotes "name" in nested.parquet)', () => {
    const parsed = parseDuckDbType('STRUCT("name" VARCHAR, plain INTEGER)')
    expect(parsed).toEqual({
      kind: 'struct',
      fields: [field('name', primitive('VARCHAR')), field('plain', primitive('INTEGER'))],
    })
  })

  it('keeps field names with spaces and embedded quotes (DuckDB "" escaping)', () => {
    const parsed = parseDuckDbType('STRUCT("a b" INTEGER, "c""d" VARCHAR)')
    expect(parsed).toEqual({
      kind: 'struct',
      fields: [field('a b', primitive('INTEGER')), field('c"d', primitive('VARCHAR'))],
    })
  })

  it('accepts single-quoted field names', () => {
    const parsed = parseDuckDbType("STRUCT('weird field' INTEGER)")
    expect(parsed).toEqual({
      kind: 'struct',
      fields: [field('weird field', primitive('INTEGER'))],
    })
  })
})

describe('parseDuckDbType — lists', () => {
  it('parses an array suffix (VARCHAR[])', () => {
    expect(parseDuckDbType('VARCHAR[]')).toEqual({
      kind: 'list',
      element: primitive('VARCHAR'),
      dimensions: '[]',
    })
  })

  it('parses LIST(…) wrapping', () => {
    expect(parseDuckDbType('LIST(VARCHAR)')).toEqual({
      kind: 'list',
      element: primitive('VARCHAR'),
      dimensions: '',
    })
  })

  it('parses multi-dimensional arrays (INT[][]) and fixed sizes (INT[2][3])', () => {
    expect(parseDuckDbType('INT[][]')).toEqual({
      kind: 'list',
      element: primitive('INT'),
      dimensions: '[][]',
    })
    expect(parseDuckDbType('INT[2][3]')).toEqual({
      kind: 'list',
      element: primitive('INT'),
      dimensions: '[2][3]',
    })
  })

  it('parses lists of structs and struct-of-lists (llm.parquet messages shape)', () => {
    // The real llm.parquet `messages` type from DuckDB 1.5.5 DESCRIBE.
    const parsed = parseDuckDbType(
      'STRUCT("role" VARCHAR, "content" VARCHAR, tool_calls STRUCT("name" VARCHAR, args STRUCT(city VARCHAR))[])[]',
    )
    expect(parsed).toEqual({
      kind: 'list',
      element: {
        kind: 'struct',
        fields: [
          field('role', primitive('VARCHAR')),
          field('content', primitive('VARCHAR')),
          field('tool_calls', {
            kind: 'list',
            element: {
              kind: 'struct',
              fields: [
                field('name', primitive('VARCHAR')),
                field('args', {
                  kind: 'struct',
                  fields: [field('city', primitive('VARCHAR'))],
                }),
              ],
            },
            dimensions: '[]',
          }),
        ],
      },
      dimensions: '[]',
    })
  })

  it('parses deeply nested lists-of-structs', () => {
    const parsed = parseDuckDbType('STRUCT(a STRUCT(b VARCHAR[])[])[]')
    expect(parsed.kind).toBe('list')
    if (parsed.kind !== 'list') return
    expect(parsed.dimensions).toBe('[]')
    // Field a is itself a list of structs (STRUCT(b VARCHAR[])[]):
    const outer = parsed.element
    expect(outer.kind).toBe('struct')
    if (outer.kind !== 'struct') return
    const inner = outer.fields[0]
    expect(inner?.name).toBe('a')
    expect(inner?.type.kind).toBe('list')
    if (inner?.type.kind !== 'list') return
    expect(inner.type.dimensions).toBe('[]')
    expect(inner.type.element).toEqual({
      kind: 'struct',
      fields: [field('b', { kind: 'list', element: primitive('VARCHAR'), dimensions: '[]' })],
    })
  })
})

describe('parseDuckDbType — MAP, UNION, edge shapes', () => {
  it('parses MAP(key, value) with typed halves (real DuckDB output: MAP(INTEGER, INTEGER))', () => {
    expect(parseDuckDbType('MAP(INTEGER, INTEGER)')).toEqual({
      kind: 'map',
      key: primitive('INTEGER'),
      value: primitive('INTEGER'),
    })
  })

  it('parses UNION alternatives like struct fields', () => {
    expect(parseDuckDbType('UNION(v VARCHAR, n INTEGER)')).toEqual({
      kind: 'union',
      fields: [field('v', primitive('VARCHAR')), field('n', primitive('INTEGER'))],
    })
  })

  it('parses a struct array suffix (STRUCT(x INT)[])', () => {
    expect(parseDuckDbType('STRUCT(x INT)[]')).toEqual({
      kind: 'list',
      element: { kind: 'struct', fields: [field('x', primitive('INT'))] },
      dimensions: '[]',
    })
  })

  it('parses an empty struct without crashing', () => {
    expect(parseDuckDbType('STRUCT()')).toEqual({ kind: 'struct', fields: [] })
  })
})

describe('parseDuckDbType — graceful degradation (never throws)', () => {
  it('degrades unknown identifiers to a displayable untyped leaf', () => {
    // Well-formed but unknown identifiers become opaque leaf labels — the
    // panel can still show them; 'unknown' is reserved for grammar violations.
    expect(parseDuckDbType('WEIRD_TYPE')).toEqual(primitive('WEIRD_TYPE'))
  })

  it('degrades the empty string to a raw leaf', () => {
    expect(parseDuckDbType('')).toEqual({ kind: 'unknown', raw: '' })
  })

  it('degrades whitespace-only input to a raw leaf', () => {
    expect(parseDuckDbType('   ')).toEqual({ kind: 'unknown', raw: '   ' })
  })

  it('degrades unbalanced delimiters to a raw leaf', () => {
    for (const raw of ['STRUCT(', 'STRUCT("a" VARCHAR', 'VARCHAR]', '(((']) {
      const parsed = parseDuckDbType(raw)
      expect(parsed.kind, raw).toBe('unknown')
      if (parsed.kind === 'unknown') expect(parsed.raw).toBe(raw)
    }
  })

  it('degrades field lists missing types / separators to a raw leaf', () => {
    for (const raw of ['STRUCT("a")', 'STRUCT(a VARCHAR b INTEGER)', 'STRUCT( VARCHAR)']) {
      expect(parseDuckDbType(raw).kind, raw).toBe('unknown')
    }
  })

  it('degrades trailing garbage after a complete type to a raw leaf', () => {
    expect(parseDuckDbType('BIGINT garbage )').kind).toBe('unknown')
    expect(parseDuckDbType('STRUCT(a INT) extra').kind).toBe('unknown')
  })

  it('degrades stray special characters to a raw leaf', () => {
    for (const raw of ['???', 'INT; DROP TABLE', '$%$', 'INT@', 'VARCHAR!', 'a.b.c']) {
      expect(parseDuckDbType(raw).kind, raw).toBe('unknown')
    }
  })

  it('still parses the structural keyword itself when no parens follow', () => {
    // 'STRUCT' without parens is not the grammar's struct — a leaf label is
    // a better degradation than a crash, and keeps future types displayable.
    expect(parseDuckDbType('STRUCT')).toEqual(primitive('STRUCT'))
  })
})

describe('formatDuckDbType — canonical rendering', () => {
  it('round-trips types without quoted field names', () => {
    for (const raw of [
      'BIGINT',
      'DECIMAL(21,1)',
      'TIMESTAMP WITH TIME ZONE',
      'VARCHAR[]',
      'INT[2][3]',
      'MAP(INTEGER, INTEGER)',
      'UNION(v VARCHAR, n INTEGER)',
      'STRUCT(a INT, b STRUCT(c VARCHAR[]), d STRUCT(x INT)[])',
    ]) {
      expect(formatDuckDbType(parseDuckDbType(raw)), raw).toBe(raw)
    }
  })

  it('canonicalizes LIST(T) wrapping to the T[] suffix form', () => {
    expect(formatDuckDbType(parseDuckDbType('LIST(VARCHAR)'))).toBe('VARCHAR[]')
  })

  it('renders quoted names only when they are not plain identifiers', () => {
    expect(formatDuckDbType(parseDuckDbType('STRUCT("name" VARCHAR)'))).toBe('STRUCT(name VARCHAR)')
    expect(formatDuckDbType(parseDuckDbType('STRUCT("a b" INTEGER)'))).toBe('STRUCT("a b" INTEGER)')
    expect(formatDuckDbType(parseDuckDbType('STRUCT("c""d" VARCHAR)'))).toBe(
      'STRUCT("c""d" VARCHAR)',
    )
  })

  it('renders unknown leaves verbatim', () => {
    expect(formatDuckDbType(parseDuckDbType('STRUCT('))).toBe('STRUCT(')
  })
})
