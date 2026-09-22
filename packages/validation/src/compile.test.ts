import { describe, expect, it } from 'vitest'
import type { ColumnRuleSet, ContractV1 } from '@assay/contracts'
import { compileContract, DEFAULT_SAMPLE_LIMIT } from './compile'
import { describeBindingError } from './errors'
import type { BindingError, BindingErrorCode } from './errors'

/**
 * Binding-error pins (m5-1): every rejection class with its code,
 * attribution (path/ruleId/column) and message substance, plus the
 * collect-all-errors and no-silent-skips guarantees. The errors are the
 * surface m5-2/m5-4 render; their text is pinned for substance (stable
 * fragments), the structured fields for exactness.
 */

const BASE_SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'flag', type: 'BOOLEAN' },
  { name: 'amount', type: 'DECIMAL(10,2)' },
]

function contractOf(
  columns: readonly ColumnRuleSet[],
  dataset?: ContractV1['dataset'],
): ContractV1 {
  return {
    format: 'v1',
    metadata: { name: 'pin', version: 1 },
    columns,
    ...(dataset !== undefined ? { dataset } : {}),
  }
}

/** Compile one column rule set against the base schema (or a custom one). */
function compileOne(
  column: ColumnRuleSet,
  schema: readonly { name: string; type: string }[] = BASE_SCHEMA,
  dataset?: ContractV1['dataset'],
): ReturnType<typeof compileContract> {
  return compileContract(contractOf([column], dataset), schema, { relation: 't1' })
}

/** Cast a valid-typed rule into a deliberately malformed one (caller-bug surface). */
function broken(column: Record<string, unknown>): ColumnRuleSet {
  return column as unknown as ColumnRuleSet
}

function firstError(result: ReturnType<typeof compileContract>): BindingError {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected failure')
  expect(result.errors.length).toBeGreaterThanOrEqual(1)
  return result.errors[0] as BindingError
}

describe('missing-column — attribution, hint, case sensitivity', () => {
  it('rejects a rule addressing an absent column with full attribution', () => {
    const error = firstError(compileOne({ name: 'user_id', required: true }))
    expect(error.code).toBe('missing-column')
    expect(error.path).toBe('columns[0].required')
    expect(error.ruleId).toBe('columns[0].required')
    expect(error.column).toBe('user_id')
    expect(error.message).toContain("'user_id'")
    expect(error.message).toContain('does not exist in the target schema')
    expect(error.message).toContain('case-sensitive')
  })

  it('suggests the single case-insensitive candidate', () => {
    const error = firstError(compileOne({ name: 'ID', required: true }))
    expect(error.code).toBe('missing-column')
    expect(error.message).toContain("did you mean 'id'?")
  })

  it('stays silent on ambiguous case-insensitive candidates', () => {
    const schema = [
      { name: 'id', type: 'BIGINT' },
      { name: 'ID', type: 'VARCHAR' },
    ]
    const error = firstError(compileOne({ name: 'Id', required: true }, schema))
    expect(error.code).toBe('missing-column')
    expect(error.message).not.toContain('did you mean')
  })

  it('offers no suggestion when nothing matches case-insensitively', () => {
    const error = firstError(compileOne({ name: 'zzz', required: true }))
    expect(error.message).not.toContain('did you mean')
  })

  it('binds exactly and case-sensitively when the name matches', () => {
    const result = compileOne({ name: 'id', required: true })
    expect(result.ok).toBe(true)
  })
})

describe('rule-not-applicable — the documented applicability matrix', () => {
  function expectNotApplicable(
    column: ColumnRuleSet,
    messageFragment: string,
    schema = BASE_SCHEMA,
  ): void {
    const CANONICAL_KEY: Readonly<Record<string, string>> = {
      type: 'type',
      required: 'required',
      unique: 'unique',
      min: 'min',
      max: 'max',
      allowedValues: 'allowed-values',
      regex: 'regex',
      maxNullShare: 'max-null-share',
      minDistinctShare: 'min-distinct-share',
    }
    const error = firstError(compileOne(column, schema))
    expect(error.code).toBe('rule-not-applicable')
    const field = Object.keys(column).find((k) => k !== 'name') ?? ''
    expect(error.path).toBe(`columns[0].${CANONICAL_KEY[field]}`)
    expect(error.column).toBe(column.name)
    expect(error.message).toContain(messageFragment)
    expect(error.message).toContain(`column '${String(column.name)}'`)
  }

  it('rejects min on a textual column', () => {
    expectNotApplicable({ name: 'name', min: 0 }, 'min/max bounds require a numeric column')
  })
  it('rejects max on a boolean column', () => {
    expectNotApplicable({ name: 'flag', max: 5 }, 'require a numeric column')
  })
  it('rejects regex on a numeric column (naming the engine type and family)', () => {
    const error = firstError(compileOne({ name: 'id', regex: '^\\d+$' }))
    expect(error.code).toBe('rule-not-applicable')
    expect(error.message).toContain('regex requires a textual (VARCHAR) column')
    expect(error.message).toContain("'BIGINT'")
    expect(error.message).toContain("'numeric'")
  })
  it('rejects allowed-values on a temporal column', () => {
    const schema = [...BASE_SCHEMA, { name: 'day', type: 'DATE' }]
    expectNotApplicable(
      { name: 'day', allowedValues: ['MON', 'TUE'] },
      'applies only to numeric, textual or boolean columns',
      schema,
    )
  })
  it('rejects unique on a JSON column (textual equality would be approximate)', () => {
    const schema = [...BASE_SCHEMA, { name: 'doc', type: 'JSON' }]
    expectNotApplicable({ name: 'doc', unique: true }, 'JSON equality is textual', schema)
  })
  it('binds a rule on a column spelled like a plan alias (no reserved names)', () => {
    // DuckDB identifiers are case-insensitive even when quoted, so no name
    // is unreachable by a dataset column; the compiled SQL is collision-
    // free by construction (range-qualified source references; derived
    // tables expose only reserved aliases — see plan.ts). Exact-case and
    // case-variant spellings all bind; the DuckDB agreement suite proves
    // they *execute* correctly.
    for (const name of ['assay_row_ordinal', 'ASSAY_ROW_ORDINAL', 'assay_occurrences']) {
      const schema = [{ name, type: 'BIGINT' }]
      const result = compileContract(
        contractOf([{ name, required: true, unique: true, type: 'BIGINT' }]),
        schema,
        { relation: 't1' },
      )
      expect(result.ok, name).toBe(true)
      if (result.ok) {
        for (const rule of result.plan.rules) {
          if (rule.kind === 'declared-type') continue // a row-count fact never references the column
          // The source column is read range-qualified. (A negative bare-name
          // regex is meaningless when the dataset column is *spelled* like a
          // plan alias — the bare occurrences are then the plan's own derived
          // aliases; correctness is pinned by execution in the DuckDB
          // agreement suite.)
          expect(rule.sql).toContain(`"src"."${name}"`)
        }
      }
    }
  })

  it('rejects cross-kind allowed-values entries (would fail or coerce at execution)', () => {
    const error = firstError(compileOne({ name: 'id', allowedValues: ['US'] }))
    expect(error.code).toBe('rule-not-applicable')
    expect(error.message).toContain('entry 0 is a string')
    expect(error.message).toContain("'BIGINT'")
    expect(error.message).toContain('numeric columns bind only number literals')
  })
  it('rejects number entries on textual columns, naming the first offending entry', () => {
    const error = firstError(compileOne({ name: 'name', allowedValues: ['ok', 5] }))
    expect(error.code).toBe('rule-not-applicable')
    expect(error.message).toContain('entry 1 is a number')
    expect(error.message).toContain("'VARCHAR'")
    expect(error.message).toContain('textual columns bind only string literals')
  })
  it('rejects boolean entries on textual columns', () => {
    const error = firstError(compileOne({ name: 'name', allowedValues: [true] }))
    expect(error.code).toBe('rule-not-applicable')
    expect(error.message).toContain('entry 0 is a boolean')
  })
  it('rejects string entries on boolean columns', () => {
    const error = firstError(compileOne({ name: 'flag', allowedValues: ['TRUE'] }))
    expect(error.code).toBe('rule-not-applicable')
    expect(error.message).toContain('boolean columns bind only boolean literals')
  })

  it('binds kind-consistent allowed-values on every family (incl. the degenerate empty list)', () => {
    expect(compileOne({ name: 'id', allowedValues: [1, 2] }).ok).toBe(true)
    expect(compileOne({ name: 'name', allowedValues: ['US'] }).ok).toBe(true)
    expect(compileOne({ name: 'flag', allowedValues: [true, false] }).ok).toBe(true)
    for (const name of ['id', 'name', 'flag']) {
      const result = compileOne({ name, allowedValues: [] })
      expect(result.ok).toBe(true)
      if (result.ok) {
        // the documented degenerate semantics: every non-NULL value fails
        expect(result.plan.rules[0]?.sql).toContain('IS NOT NULL)')
      }
    }
  })
})

describe('unknown-column-type — unclassifiable engine spellings reject honestly', () => {
  function expectUnknownType(column: ColumnRuleSet, type: string, description: string): void {
    const schema = [{ name: column.name, type }]
    const error = firstError(compileOne(column, schema))
    expect(error.code).toBe('unknown-column-type')
    expect(error.column).toBe(column.name)
    expect(error.message).toContain(description)
    expect(error.message).toContain('only flat scalar engine types are bindable in v1')
  }

  it('rejects min on an array column', () => {
    expectUnknownType({ name: 'xs', min: 0 }, 'INTEGER[]', "array type 'INTEGER[]'")
  })
  it('rejects regex on a nested column', () => {
    expectUnknownType(
      { name: 's', regex: 'a' },
      'STRUCT(a INTEGER)',
      "nested type 'STRUCT(a INTEGER)'",
    )
  })
  it('rejects min on an unknown spelling', () => {
    expectUnknownType(
      { name: 'x', min: 0 },
      'WEIRD_TYPE',
      "unknown engine type spelling 'WEIRD_TYPE'",
    )
  })
  it('rejects alias spellings the engine never reports (TEXT, lowercase)', () => {
    expectUnknownType({ name: 'x', min: 0 }, 'TEXT', "unknown engine type spelling 'TEXT'")
    expectUnknownType({ name: 'x', min: 0 }, 'varchar', "unknown engine type spelling 'varchar'")
  })
  it('rejects malformed parameterized decimals fail-closed', () => {
    expectUnknownType(
      { name: 'x', min: 0 },
      'DECIMAL(5,9)',
      "unknown engine type spelling 'DECIMAL(5,9)'",
    )
  })

  it('still binds family-free rules on unclassifiable types (NULL arithmetic is total)', () => {
    const schema = [
      { name: 'xs', type: 'INTEGER[]' },
      { name: 's', type: 'STRUCT(a INTEGER)' },
    ]
    const result = compileContract(
      contractOf([
        { name: 'xs', required: true, maxNullShare: 0 },
        { name: 's', required: true },
      ]),
      schema,
      { relation: 't1' },
    )
    expect(result.ok).toBe(true)
  })

  it('still binds declared-type expectations on unclassifiable types (exact spelling fact)', () => {
    const result = compileOne({ name: 'xs', type: 'INTEGER[]' as ColumnRuleSet['type'] }, [
      { name: 'xs', type: 'INTEGER[]' },
    ])
    expect(result.ok).toBe(true)
  })
})

describe('invalid-regex — RE2 dialect honesty at binding time', () => {
  it('rejects backreferences with attribution', () => {
    const error = firstError(compileOne({ name: 'name', regex: '(a)\\1' }))
    expect(error.code).toBe('invalid-regex')
    expect(error.path).toBe('columns[0].regex')
    expect(error.ruleId).toBe('columns[0].regex')
    expect(error.column).toBe('name')
    expect(error.message).toContain('RE2')
    expect(error.message).toContain('backreferences')
  })
  it('rejects lookbehind', () => {
    const error = firstError(compileOne({ name: 'name', regex: '(?<=a)b' }))
    expect(error.code).toBe('invalid-regex')
    expect(error.message).toContain('lookbehind')
  })
  it('rejects malformed flag groups (DuckDB: "invalid perl operator")', () => {
    for (const pattern of ['(?i-)abc', '(?--i)abc', '(?i--s)abc']) {
      const error = firstError(compileOne({ name: 'name', regex: pattern }))
      expect(error.code, pattern).toBe('invalid-regex')
      expect(error.message, pattern).toContain('flag group')
    }
  })
  it('rejects escaped non-ASCII codepoints (DuckDB: "invalid escape sequence")', () => {
    for (const pattern of ['\\é', '\\😀', '[\\é]', 'a\\ü']) {
      const error = firstError(compileOne({ name: 'name', regex: pattern }))
      expect(error.code, pattern).toBe('invalid-regex')
      expect(error.message, pattern).toContain('invalid escape sequence')
    }
  })
  it('never throws on deep nesting — a past-the-bound pattern is typed data (m5-1 review item 3)', () => {
    // DuckDB 1.5.5 accepts 5,000 nested groups; the checker's documented
    // bound (100) is a checker-safety bound, so this DuckDB-valid pattern
    // must come back as invalid-regex DATA — never a RangeError.
    const pattern = '('.repeat(5000) + 'a' + ')'.repeat(5000)
    let result: ReturnType<typeof compileContract> | undefined
    expect(() => {
      result = compileOne({ name: 'name', regex: pattern })
    }).not.toThrow()
    const error = firstError(result as ReturnType<typeof compileContract>)
    expect(error.code).toBe('invalid-regex')
    expect(error.message).toContain('nest')
  })
  it('rejects the pattern regardless of the column type (dialect before applicability)', () => {
    const error = firstError(compileOne({ name: 'id', regex: 'a*+' }))
    expect(error.code).toBe('invalid-regex')
    expect(error.message).toContain('nothing to repeat')
  })
  it('AR-V1 newly accepted patterns compile (no invalid-regex)', () => {
    for (const pattern of [
      '\\v',
      '[\\v]',
      '[]a]',
      '[]]',
      '[^]a]',
      '^*',
      '$+',
      '^{2,3}',
      '\\b{2}',
      '\\B+',
      '\\A?',
      '\\z{2}',
      'a(?i)*',
      '\\x{0000061}',
      '\\x{00000000000000000000000000000000000000000000000000000000000000000061}',
    ]) {
      const result = compileOne({ name: 'name', regex: pattern })
      expect(result.ok, pattern).toBe(true)
    }
  })
  it('rejects a non-string pattern as a contract-shape error, never a crash', () => {
    const error = firstError(compileOne(broken({ name: 'name', regex: 42 })))
    expect(error.code).toBe('invalid-contract-input')
    expect(error.message).toContain('must be a string')
  })
})

describe('invalid-contract-input — caller-bug surface (parseContract output cannot produce these)', () => {
  it.each([
    ['non-finite min', broken({ name: 'id', min: Number.NaN }), 'finite number'],
    [
      'non-finite share',
      broken({ name: 'id', maxNullShare: Number.POSITIVE_INFINITY }),
      'share rule',
    ],
    ['share out of [0,1]', broken({ name: 'id', minDistinctShare: 1.5 }), 'share rule'],
    ['non-string declared type', broken({ name: 'id', type: 42 }), 'must be a string'],
    [
      'non-scalar allowed-values entry',
      broken({ name: 'name', allowedValues: ['a', null] }),
      'entry 1 is not a scalar',
    ],
    [
      'NUL in an allowed-values entry',
      broken({ name: 'name', allowedValues: ['a\u0000b'] }),
      'NUL',
    ],
  ])('%s → typed error', (_label, column, fragment) => {
    const error = firstError(compileOne(column))
    expect(error.code).toBe('invalid-contract-input')
    expect(error.message).toContain(fragment)
  })

  it('rejects duplicate column rule sets (m5-0 would have rejected at parse)', () => {
    const result = compileContract(
      contractOf([
        { name: 'id', required: true },
        { name: 'id', regex: 'a' },
      ]),
      BASE_SCHEMA,
      { relation: 't1' },
    )
    const error = firstError(result)
    expect(error.code).toBe('invalid-contract-input')
    expect(error.path).toBe('columns[1]')
    expect(error.message).toContain("duplicate column rule set for 'id'")
  })

  it('rejects a non-v1 format behind a broken cast', () => {
    const result = compileContract(
      { ...contractOf([]), format: 'v2' as unknown as 'v1' },
      BASE_SCHEMA,
      { relation: 't1' },
    )
    const error = firstError(result)
    expect(error.code).toBe('invalid-contract-input')
    expect(error.path).toBe('format')
    expect(error.message).toContain("'v1'")
  })

  it('rejects non-true required/unique behind a broken cast (never compiled as a rule)', () => {
    for (const column of [
      broken({ name: 'id', required: { bad: true } }),
      broken({ name: 'id', required: 'yes' }),
      broken({ name: 'id', required: 1 }),
      broken({ name: 'id', unique: { bad: true } }),
      broken({ name: 'id', unique: 'yes' }),
    ]) {
      const error = firstError(compileOne(column))
      expect(error.code).toBe('invalid-contract-input')
      expect(error.message).toContain('must be exactly true when present')
    }
  })

  it('rejects an unrecognizable dataset shape (never silently ignored)', () => {
    for (const dataset of ['silent', 42, true, [1, 2], null]) {
      const result = compileContract(
        {
          format: 'v1',
          metadata: { name: 'pin', version: 1 },
          columns: [{ name: 'id', required: true }],
          dataset,
        } as unknown as ContractV1,
        BASE_SCHEMA,
        { relation: 't1' },
      )
      expect(result.ok).toBe(false)
      if (result.ok) continue
      const error = result.errors.find((e) => e.path === 'dataset')
      expect(error?.code, String(dataset)).toBe('invalid-contract-input')
      expect(error?.message).toContain('must be an object with minRows/maxRows')
    }
  })

  it('rejects unknown rule keys (column-level, dataset-level, top-level) — no silent skips', () => {
    const unknownColumnKey = firstError(compileOne(broken({ name: 'id', median: 5 })))
    expect(unknownColumnKey.code).toBe('invalid-contract-input')
    expect(unknownColumnKey.path).toBe('columns[0].median')
    expect(unknownColumnKey.message).toContain("'median' is not a rule key")

    const badDataset = compileContract(
      {
        format: 'v1',
        metadata: { name: 'pin', version: 1 },
        columns: [{ name: 'id', required: true }],
        dataset: { minRows: 1, medianRows: 5 },
      } as ContractV1,
      BASE_SCHEMA,
      { relation: 't1' },
    )
    expect(badDataset.ok).toBe(false)
    if (!badDataset.ok) {
      const error = badDataset.errors.find((e) => e.path === 'dataset.medianRows')
      expect(error?.code).toBe('invalid-contract-input')
      expect(error?.message).toContain("'medianRows' is not a dataset rule key")
    }

    const badTopLevel = compileContract(
      { ...contractOf([]), owner: 'someone' } as unknown as ContractV1,
      BASE_SCHEMA,
      { relation: 't1' },
    )
    const topError = firstError(badTopLevel)
    expect(topError.code).toBe('invalid-contract-input')
    expect(topError.path).toBe('owner')
    expect(topError.message).toContain("'owner' is not a v1 contract key")
  })

  it('a known key with a false value stays an absent rule (the m5-0 normalization)', () => {
    const result = compileOne(broken({ name: 'id', required: false, unique: false }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.rules).toHaveLength(0)
  })
})

describe('invalid-options — compile options are validated before any SQL exists', () => {
  it('rejects an empty relation name', () => {
    const error = firstError(compileContract(contractOf([]), BASE_SCHEMA, { relation: '' }))
    expect(error.code).toBe('invalid-options')
    expect(error.path).toBe('options')
    expect(error.message).toContain('non-empty string')
  })
  it.each([0, -3, 2.5, Number.NaN])('rejects sampleLimit %s', (sampleLimit) => {
    const error = firstError(
      compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
        relation: 't1',
        sampleLimit,
      }),
    )
    expect(error.code).toBe('invalid-options')
    expect(error.message).toContain('safe integer ≥ 1')
  })
  it('rejects a NUL in the relation name', () => {
    const error = firstError(compileContract(contractOf([]), BASE_SCHEMA, { relation: 't\u00001' }))
    expect(error.code).toBe('invalid-options')
    expect(error.message).toContain('NUL')
  })
  it('renders hostile option values totally — the error path never throws (m5-1 review item 4)', () => {
    // String(Object.create(null)) is a TypeError ("Cannot convert object to
    // primitive value"); the invalid-options rendering must be total over
    // every value a caller bug behind a cast can produce.
    const hostile: readonly unknown[] = [
      Object.create(null),
      { toString: null },
      { ugly: true },
      Symbol('x'),
      () => 42,
    ]
    for (const sampleLimit of hostile) {
      let result: ReturnType<typeof compileContract> | undefined
      expect(() => {
        result = compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
          relation: 't1',
          sampleLimit: sampleLimit as number,
        })
      }).not.toThrow()
      const error = firstError(result as ReturnType<typeof compileContract>)
      expect(error.code).toBe('invalid-options')
      expect(error.message).toContain('safe integer ≥ 1')
      expect(error.message.length).toBeGreaterThan(0)
    }
    // and the same totality for a hostile relation value
    let relationResult: ReturnType<typeof compileContract> | undefined
    expect(() => {
      relationResult = compileContract(contractOf([]), BASE_SCHEMA, {
        relation: Object.create(null) as string,
      })
    }).not.toThrow()
    expect(firstError(relationResult as ReturnType<typeof compileContract>).code).toBe(
      'invalid-options',
    )
  })
  it('degrades non-object options to typed errors (totality behind a cast)', () => {
    for (const options of [null, undefined, 42, 't1']) {
      let result: ReturnType<typeof compileContract> | undefined
      expect(() => {
        result = compileContract(
          contractOf([{ name: 'id', required: true }]),
          BASE_SCHEMA,
          options as unknown as { relation: string },
        )
      }).not.toThrow()
      expect(firstError(result as ReturnType<typeof compileContract>).code).toBe('invalid-options')
    }
  })
  it('defaults the sample limit to the pinned K', () => {
    const result = compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
      relation: 't1',
    })
    expect(DEFAULT_SAMPLE_LIMIT).toBe(20)
    if (result.ok) expect(result.plan.sampleLimit).toBe(20)
  })
})

describe('invalid-options — hostile option accessors resolve once to typed errors (m5-1 re-review round 2, item 1)', () => {
  it('a throwing relation getter degrades to typed invalid-options — never a raw exception', () => {
    let result: ReturnType<typeof compileContract> | undefined
    expect(() => {
      result = compileContract(contractOf([]), BASE_SCHEMA, {
        get relation(): string {
          throw new Error('boom')
        },
      })
    }).not.toThrow()
    const error = firstError(result as ReturnType<typeof compileContract>)
    expect(error.code).toBe('invalid-options')
    expect(error.path).toBe('options')
    expect(error.message).toContain("'relation'")
    expect(error.message).toContain('threw an exception')
  })

  it('a throwing sampleLimit getter after a valid relation is typed too — never raw', () => {
    let result: ReturnType<typeof compileContract> | undefined
    expect(() => {
      result = compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
        relation: 't1',
        get sampleLimit(): number {
          throw new RangeError('nope')
        },
      })
    }).not.toThrow()
    const error = firstError(result as ReturnType<typeof compileContract>)
    expect(error.code).toBe('invalid-options')
    expect(error.path).toBe('options')
    expect(error.message).toContain("'sampleLimit'")
    expect(error.message).toContain('threw an exception')
  })

  it('totality holds over what the getter throws, not just that it throws', () => {
    for (const thrown of [undefined, Object.create(null), Symbol('x'), 'boom']) {
      let result: ReturnType<typeof compileContract> | undefined
      expect(() => {
        result = compileContract(contractOf([]), BASE_SCHEMA, {
          get relation(): string {
            throw thrown
          },
        })
      }).not.toThrow()
      const error = firstError(result as ReturnType<typeof compileContract>)
      expect(error.code).toBe('invalid-options')
      expect(error.message).toContain('threw an exception')
    }
  })

  it('a stateful (value-changing) relation accessor is read exactly once — one consistent value validated and compiled', () => {
    // The documented policy for stateful accessors: a single consistent
    // read. Resolution reads the property once, in a fixed order; the
    // validated value is the value quoted into every query and the plan.
    const reads: string[] = []
    const result = compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
      get relation(): string {
        reads.push('read')
        return reads.length === 1 ? 't1' : 't2'
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.relation).toBe('t1')
      for (const rule of result.plan.rules) {
        expect(rule.sql).toContain('"t1"')
        expect(rule.sql).not.toContain('"t2"')
      }
      expect(result.plan.summarySql).toContain('"t1"')
      expect(result.plan.summarySql).not.toContain('"t2"')
    }
    expect(reads).toHaveLength(1)
  })

  it('a stateful sampleLimit accessor is likewise read exactly once (plan and LIMIT agree on the first value)', () => {
    let reads = 0
    const result = compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
      relation: 't1',
      get sampleLimit(): number {
        reads += 1
        return reads === 1 ? 5 : 99
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.sampleLimit).toBe(5)
      for (const rule of result.plan.rules) {
        expect(rule.sql).toContain('LIMIT 5')
        expect(rule.sql).not.toContain('LIMIT 99')
      }
    }
    expect(reads).toBe(1)
  })
})

describe('invalid-schema-input — the target schema is validated, not trusted', () => {
  it('rejects duplicate column names with the entry path', () => {
    const error = firstError(
      compileOne({ name: 'dup', required: true }, [
        { name: 'dup', type: 'BIGINT' },
        { name: 'dup', type: 'VARCHAR' },
      ]),
    )
    expect(error.code).toBe('invalid-schema-input')
    expect(error.path).toBe('schema[1]')
    expect(error.message).toContain("duplicate column name 'dup'")
  })
  it('rejects entries with a missing/empty type', () => {
    const error = firstError(compileOne({ name: 'x', required: true }, [{ name: 'x', type: '' }]))
    expect(error.code).toBe('invalid-schema-input')
    expect(error.message).toContain('non-empty string type')
  })
  it('rejects NUL in a schema name or type', () => {
    const error = firstError(
      compileOne({ name: 'x\u0000', required: true }, [{ name: 'x\u0000', type: 'BIGINT' }]),
    )
    expect(error.code).toBe('invalid-schema-input')
    expect(error.message).toContain('NUL')
  })
  it('input-level schema errors carry no ruleId (not attributable to one rule)', () => {
    const error = firstError(
      compileOne({ name: 'dup', required: true }, [
        { name: 'dup', type: 'BIGINT' },
        { name: 'dup', type: 'VARCHAR' },
      ]),
    )
    expect(error.ruleId).toBeUndefined()
  })
})

describe('collect-all-errors — every independent failure is reported, nothing silently skipped', () => {
  it('collects errors across columns and rule kinds in canonical order', () => {
    const result = compileContract(
      contractOf([
        { name: 'ghost', required: true }, // missing column
        { name: 'name', min: 0 }, // inapplicable family
        { name: 'flag', regex: '(a)\\1' }, // non-RE2, wrong family too (dialect first)
      ]),
      BASE_SCHEMA,
      { relation: 't1' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toEqual([
      'missing-column',
      'rule-not-applicable',
      'invalid-regex',
    ])
    expect(result.errors.map((e) => e.path)).toEqual([
      'columns[0].required',
      'columns[1].min',
      'columns[2].regex',
    ])
  })

  it('a failed compile produces no plan at all (never a partial plan)', () => {
    const result = compileOne({ name: 'ghost', required: true })
    expect(result.ok).toBe(false)
    expect('plan' in result).toBe(false)
  })

  it('the schema/option validation failures short-circuit before rule compilation', () => {
    const result = compileContract(contractOf([{ name: 'id', required: true }]), [], {
      relation: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(['invalid-options'])
  })
})

describe('declared-type — mismatch is a violation, never a binding error', () => {
  it('compiles a spelling mismatch to a reportable dataset fact with both spellings', () => {
    const result = compileOne({ name: 'id', type: 'VARCHAR' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [rule] = result.plan.rules
    expect(rule?.kind).toBe('declared-type')
    expect(rule?.expectedType).toBe('VARCHAR')
    expect(rule?.actualType).toBe('BIGINT')
    expect(rule?.sql).toContain('WHERE TRUE')
  })
  it('a matching expectation compiles to the never-true fact', () => {
    const result = compileOne({ name: 'id', type: 'BIGINT' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.rules[0]?.sql).toContain('WHERE FALSE')
  })
})

describe('error rendering — describeBindingError', () => {
  it('renders path, column, code and message in one greppable line', () => {
    const text = describeBindingError({
      code: 'missing-column',
      message: "column 'ghost' is missing",
      path: 'columns[0].required',
      ruleId: 'columns[0].required',
      column: 'ghost',
    })
    expect(text).toBe(
      "columns[0].required (column 'ghost'): [missing-column] column 'ghost' is missing",
    )
    const datasetLevel = describeBindingError({
      code: 'invalid-options',
      message: 'relation must be a non-empty string',
      path: 'options',
    })
    expect(datasetLevel).toBe('options: [invalid-options] relation must be a non-empty string')
  })
})

describe('totality against hostile contract/schema accessors (AR-V3)', () => {
  /** A Proxy whose `revoke()` has already fired: even `Array.isArray` throws. */
  const makeRevokedProxy = (): unknown => {
    const { proxy, revoke } = Proxy.revocable([] as unknown[], {})
    revoke()
    return proxy
  }
  /** An array Proxy whose every trap throws (passes `Array.isArray`). */
  const makeAllTrapsProxy = (): unknown => {
    const boom = (): never => {
      throw new Error('trap exploded')
    }
    return new Proxy([] as unknown[], {
      getPrototypeOf: boom,
      setPrototypeOf: boom,
      isExtensible: boom,
      preventExtensions: boom,
      getOwnPropertyDescriptor: boom,
      defineProperty: boom,
      has: boom,
      get: boom,
      set: boom,
      deleteProperty: boom,
      ownKeys: boom,
      apply: boom,
      construct: boom,
    })
  }
  /** A plain object with one throwing, enumerable getter. */
  const withThrowingGetter = (key: string, base: object = {}): Record<string, unknown> => {
    Object.defineProperty(base, key, {
      get() {
        throw new Error(`${key} getter exploded`)
      },
      enumerable: true,
      configurable: true,
    })
    return base as Record<string, unknown>
  }

  it('a revoked/all-traps Proxy as the contract or the schema is a typed error, never a throw', () => {
    const valid = contractOf([{ name: 'id', required: true }])
    for (const hostile of [makeRevokedProxy(), makeAllTrapsProxy()]) {
      let contractResult: ReturnType<typeof compileContract> | undefined
      expect(() => {
        contractResult = compileContract(hostile as ContractV1, BASE_SCHEMA, { relation: 't1' })
      }).not.toThrow()
      expect(contractResult?.ok).toBe(false)
      if (contractResult !== undefined && !contractResult.ok) {
        expect(contractResult.errors.length).toBeGreaterThan(0)
      }

      let schemaResult: ReturnType<typeof compileContract> | undefined
      expect(() => {
        schemaResult = compileContract(valid, hostile as never, { relation: 't1' })
      }).not.toThrow()
      expect(schemaResult?.ok).toBe(false)
      if (schemaResult !== undefined && !schemaResult.ok) {
        expect(schemaResult.errors.length).toBeGreaterThan(0)
      }
    }
  })

  it('throwing getters in contract/schema positions degrade to typed errors, never raw throws', () => {
    const columnWithThrowingRule = withThrowingGetter('required', { name: 'id' }) as never
    const contractWithThrowingDataset = contractOf([{ name: 'id', required: true }])
    withThrowingGetter('dataset', contractWithThrowingDataset)
    const contractWithThrowingMetadataName = contractOf([{ name: 'id', required: true }])
    withThrowingGetter('name', contractWithThrowingMetadataName.metadata)

    const probes: ReadonlyArray<readonly [string, () => ReturnType<typeof compileContract>]> = [
      [
        'contract.format',
        () =>
          compileContract(withThrowingGetter('format') as unknown as ContractV1, BASE_SCHEMA, {
            relation: 't1',
          }),
      ],
      [
        'contract.columns',
        () =>
          compileContract(withThrowingGetter('columns') as unknown as ContractV1, BASE_SCHEMA, {
            relation: 't1',
          }),
      ],
      [
        'contract.dataset',
        () => compileContract(contractWithThrowingDataset, BASE_SCHEMA, { relation: 't1' }),
      ],
      [
        'contract.metadata.name',
        () => compileContract(contractWithThrowingMetadataName, BASE_SCHEMA, { relation: 't1' }),
      ],
      [
        'columns[0].required',
        () =>
          compileContract(contractOf([columnWithThrowingRule]), BASE_SCHEMA, { relation: 't1' }),
      ],
      [
        'schema[0].name',
        () =>
          compileContract(
            contractOf([{ name: 'id', required: true }]),
            [withThrowingGetter('name') as never],
            { relation: 't1' },
          ),
      ],
    ]
    for (const [label, run] of probes) {
      let result: ReturnType<typeof compileContract> | undefined
      expect(() => {
        result = run()
      }, label).not.toThrow()
      expect(result?.ok, label).toBe(false)
      if (result !== undefined && !result.ok) {
        expect(result.errors.length, label).toBeGreaterThan(0)
        expect(
          result.errors.every((e) => typeof e.code === 'string'),
          label,
        ).toBe(true)
      }
    }
  })
})

describe('error codes are a closed switch-able vocabulary', () => {
  it('every emitted code is one of the documented members', () => {
    const codes: readonly BindingErrorCode[] = [
      'missing-column',
      'unknown-column-type',
      'rule-not-applicable',
      'invalid-regex',
      'invalid-schema-input',
      'invalid-options',
      'invalid-contract-input',
    ]
    // exhaustiveness guard: adding a code to the union without adding it
    // here fails to compile (the array type must accept all members).
    const all: readonly BindingErrorCode[] = [...codes]
    expect(all.length).toBe(7)
  })
})
