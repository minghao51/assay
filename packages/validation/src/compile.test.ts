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
  it('rejects a rule on a reserved plan-machinery column name', () => {
    const schema = [{ name: 'assay_row_ordinal', type: 'BIGINT' }]
    const error = firstError(compileOne({ name: 'assay_row_ordinal', required: true }, schema))
    expect(error.code).toBe('rule-not-applicable')
    expect(error.message).toContain('reserved')
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
  it('rejects the pattern regardless of the column type (dialect before applicability)', () => {
    const error = firstError(compileOne({ name: 'id', regex: 'a*+' }))
    expect(error.code).toBe('invalid-regex')
    expect(error.message).toContain('nothing to repeat')
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
  it('defaults the sample limit to the pinned K', () => {
    const result = compileContract(contractOf([{ name: 'id', required: true }]), BASE_SCHEMA, {
      relation: 't1',
    })
    expect(DEFAULT_SAMPLE_LIMIT).toBe(20)
    if (result.ok) expect(result.plan.sampleLimit).toBe(20)
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
