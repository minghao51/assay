import { describe, expect, it } from 'vitest'
import type { ContractV1 } from './ast'
import type { ContractError } from './errors'
import { parseContract } from './parse'
import { serializeContract } from './serialize'
import { describeContractError } from './errors'

/**
 * Parse a document that must fail, returning the typed errors. Narrows the
 * union for the pins below (the guard expectation doubles as the pin).
 */
function parseFailing(text: string): { ok: false; errors: readonly ContractError[] } {
  const result = parseContract(text)
  expect(result.ok).toBe(false)
  return result as { ok: false; errors: readonly ContractError[] }
}

/**
 * Golden pins (m5-0). Committed as test files inside the package per the
 * queue (not in `fixtures/`): canonical YAML ↔ AST pairs, malformed-input
 * typed-error pins (line/column and message substance), and normalization
 * pins. The canonical texts are byte-exact — the canonical serializer is a
 * reviewed surface.
 */

/** Golden A — every v1 rule kind in one contract; the canonical byte pin. */
const GOLDEN_A_YAML = `format: v1
name: customers-quality
version: 2
description: Quality gates for the customers feed
columns:
  - name: customer_id
    type: BIGINT
    required: true
    unique: true
  - name: email
    required: true
    regex: ^[^@]+@[^@]+\\.[^@]+$
    max-null-share: 0
  - name: country
    type: VARCHAR
    allowed-values: [ US, GB, DE ]
    min-distinct-share: 0.5
  - name: age
    type: INTEGER
    min: 0
    max: 120
dataset:
  min-rows: 1
  max-rows: 1000000
`

const GOLDEN_A_AST: ContractV1 = {
  format: 'v1',
  metadata: {
    name: 'customers-quality',
    version: 2,
    description: 'Quality gates for the customers feed',
  },
  columns: [
    { name: 'customer_id', type: 'BIGINT', required: true, unique: true },
    { name: 'email', required: true, regex: '^[^@]+@[^@]+\\.[^@]+$', maxNullShare: 0 },
    { name: 'country', type: 'VARCHAR', allowedValues: ['US', 'GB', 'DE'], minDistinctShare: 0.5 },
    { name: 'age', type: 'INTEGER', min: 0, max: 120 },
  ],
  dataset: { minRows: 1, maxRows: 1000000 },
}

/** The same contract, semantically identical: root key order shuffled, keys
 * shuffled *within* each column entry (column entry order is itself
 * meaningful and preserved), flow style, different indentation, comments. */
const GOLDEN_A_MESSY = `dataset: {max-rows: 1000000, min-rows: 1}
name: customers-quality
format: v1
description: Quality gates for the customers feed
columns:
    - {name: customer_id, unique: true, required: true, type: BIGINT}
    - name: email
      max-null-share: 0
      regex: '^[^@]+@[^@]+\\.[^@]+$'
      required: true
    - name: country
      min-distinct-share: 0.5
      allowed-values: [US, GB, DE]
      type: VARCHAR
    - type: INTEGER
      max: 120
      min: 0
      name: age
# metadata tail
version: 2
`

describe('parseContract — golden YAML↔AST pins', () => {
  it('parses golden A (all v1 rule kinds) into the pinned AST', () => {
    expect(parseContract(GOLDEN_A_YAML)).toEqual({ ok: true, contract: GOLDEN_A_AST })
  })

  it('re-serializes golden A byte-exactly (canonical form is a reviewed surface)', () => {
    const result = parseContract(GOLDEN_A_YAML)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe(GOLDEN_A_YAML)
  })

  it('parses the shuffled/flow/commented variant to the identical AST', () => {
    expect(parseContract(GOLDEN_A_MESSY)).toEqual({ ok: true, contract: GOLDEN_A_AST })
  })

  it('canonicalizes the messy variant to the same bytes as the canonical pin', () => {
    const result = parseContract(GOLDEN_A_MESSY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe(GOLDEN_A_YAML)
  })

  it('parses golden B (metadata only) — columns is always an array, dataset absent', () => {
    const result = parseContract('format: v1\nname: minimal\nversion: 1\n')
    expect(result).toEqual({
      ok: true,
      contract: { format: 'v1', metadata: { name: 'minimal', version: 1 }, columns: [] },
    })
  })

  it('normalizes semantically-empty rules (false booleans, empty description/dataset) away', () => {
    const result = parseContract(`version: 3
description: ''
dataset: {}
format: v1
name: normalizes-to-minimal
columns:
  - name: id
    required: false
    unique: false
`)
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'normalizes-to-minimal', version: 3 },
        columns: [{ name: 'id' }],
      },
    })
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe(
      'format: v1\nname: normalizes-to-minimal\nversion: 3\ncolumns:\n  - name: id\n',
    )
  })

  it('keeps an empty allowed-values (a real constraint) while normalizing false rules', () => {
    const result = parseContract(`format: v1
name: enum-empty
version: 1
columns:
  - name: nothing
    required: false
    allowed-values: []
`)
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'enum-empty', version: 1 },
        columns: [{ name: 'nothing', allowedValues: [] }],
      },
    })
  })

  it('parses tricky scalars exactly: block-literal description, quoted/space strings, negative numbers', () => {
    const result = parseContract(`format: v1
name: tricky-scalars
version: 1
description: |-
  two
  lines
columns:
  - name: flag
    type: BOOLEAN
    allowed-values: [true, false]
    min: -0.5
    max: 2.5
  - name: label
    allowed-values:
      - 'quoted value'
      - 123
      - -0.25
    max-null-share: 1
`)
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'tricky-scalars', version: 1, description: 'two\nlines' },
        columns: [
          { name: 'flag', type: 'BOOLEAN', min: -0.5, max: 2.5, allowedValues: [true, false] },
          { name: 'label', allowedValues: ['quoted value', 123, -0.25], maxNullShare: 1 },
        ],
      },
    })
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe(`format: v1
name: tricky-scalars
version: 1
description: |-
  two
  lines
columns:
  - name: flag
    type: BOOLEAN
    min: -0.5
    max: 2.5
    allowed-values: [ true, false ]
  - name: label
    allowed-values: [ quoted value, 123, -0.25 ]
    max-null-share: 1
`)
  })
})

describe('parseContract — malformed documents produce typed, positioned errors', () => {
  it('a YAML tab in indentation → yaml-syntax with line/column', () => {
    const result = parseFailing('format: v1\n\tname: x\n')
    expect(result.errors).toEqual([
      {
        code: 'yaml-syntax',
        message: expect.stringContaining('Tabs are not allowed'),
        path: 'document',
        line: 2,
        column: 1,
      },
    ])
  })

  it('an unterminated flow sequence → yaml-syntax pointing at the failure', () => {
    const result = parseFailing('format: v1\nname: x\nversion: 1\ncolumns: [1,\n')
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      code: 'yaml-syntax',
      message: expect.stringContaining(']'),
      line: 5,
      column: 1,
    })
  })

  it('an unresolved tag (a library warning — silent coercion) is surfaced as a syntax error', () => {
    const result = parseFailing('format: v1\nname: x\nversion: 1\nfoo: !!weird 1\n')
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      {
        code: 'yaml-syntax',
        message: expect.stringContaining('Unresolved tag'),
        path: 'document',
        line: 4,
        column: 6,
      },
    ])
  })

  it('format: v2 → unsupported-format, reported alone (no guessing at other versions)', () => {
    const result = parseFailing('format: v2\nname: x\nversion: 1\nnothing: is-walked\n')
    expect(result.errors).toEqual([
      {
        code: 'unsupported-format',
        message: expect.stringContaining('implements "v1" only'),
        path: 'format',
        line: 1,
        column: 9,
      },
    ])
  })

  it('a missing format key is a missing-key error at the document root', () => {
    const result = parseFailing('name: x\nversion: 1\n')
    expect(result.errors).toEqual([
      {
        code: 'missing-key',
        message: expect.stringContaining('missing required key "format"'),
        path: 'document',
        line: 1,
        column: 1,
      },
    ])
  })

  it('a missing contract name and version are each reported', () => {
    const result = parseFailing('format: v1\n')
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toEqual(['missing-key', 'missing-key'])
    expect(result.errors[0]).toMatchObject({
      message: expect.stringContaining('"name"'),
      path: 'document',
      line: 1,
      column: 1,
    })
    expect(result.errors[1]).toMatchObject({
      message: expect.stringContaining('"version"'),
      path: 'document',
      line: 1,
      column: 1,
    })
  })

  it('a truly unknown root key names the expected key set', () => {
    const result = parseFailing('format: v1\nname: x\nversion: 1\nextraneous: 1\n')
    expect(result.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining(
          'expected one of: format, name, version, description, columns, dataset',
        ),
        path: 'document',
        line: 4,
        column: 1,
      },
    ])
  })

  it('a misplaced rule key at the root says where the key belongs', () => {
    const result = parseFailing('format: v1\nname: x\nversion: 1\nrequired: true\n')
    expect(result.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining('"required" is valid only in a columns[] entry'),
        path: 'document',
        line: 4,
        column: 1,
      },
    ])
  })

  it('min-rows at the root points at the dataset mapping', () => {
    const result = parseFailing('format: v1\nname: x\nversion: 1\nmin-rows: 5\n')
    expect(result.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining('"min-rows" is valid only in the dataset mapping'),
        path: 'document',
        line: 4,
        column: 1,
      },
    ])
  })

  it('an unknown key inside a column rule set names the rule-key set', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    requird: true
`)
    expect(result.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining('unknown key "requird"'),
        path: 'columns[0]',
        line: 6,
        column: 5,
      },
    ])
  })

  it('a duplicated rule key (same column + same rule kind) is rejected at the second occurrence', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    required: true
    required: false
`)
    expect(result.errors).toEqual([
      {
        code: 'duplicate-key',
        message: expect.stringContaining('duplicate key "required"'),
        path: 'columns[0]',
        line: 7,
        column: 5,
      },
    ])
  })

  it('a duplicated column name is rejected at the second entry', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    required: true
  - name: a
`)
    expect(result.errors).toEqual([
      {
        code: 'duplicate-key',
        message: expect.stringContaining(
          'duplicate column name "a" — columns[0] already declares it',
        ),
        path: 'columns[1]',
        line: 7,
        column: 5,
      },
    ])
  })

  it('YAML 1.1-style yes is a string, not a boolean — wrong-type with the true/false hint', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    required: yes
`)
    expect(result.errors).toEqual([
      {
        code: 'wrong-type',
        message: expect.stringContaining('expected true or false, got the string "yes"'),
        path: 'columns[0].required',
        line: 6,
        column: 15,
      },
    ])
  })

  it('a string version and out-of-domain versions are typed errors', () => {
    const stringVersion = parseFailing('format: v1\nname: x\nversion: "1"\n')
    expect(stringVersion.errors).toEqual([
      {
        code: 'wrong-type',
        message: expect.stringContaining('expected a positive integer'),
        path: 'version',
        line: 3,
        column: 10,
      },
    ])
    const zero = parseFailing('format: v1\nname: x\nversion: 0\n')
    expect(zero.errors[0]).toMatchObject({
      code: 'out-of-range',
      path: 'version',
      line: 3,
      column: 10,
    })
    const fractional = parseFailing('format: v1\nname: x\nversion: 1.5\n')
    expect(fractional.errors[0]).toMatchObject({ code: 'out-of-range', path: 'version' })
  })

  it('shares must be within [0, 1]', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    max-null-share: 1.5
`)
    expect(result.errors).toEqual([
      {
        code: 'out-of-range',
        message: expect.stringContaining('expected a share between 0 and 1, got 1.5'),
        path: 'columns[0].max-null-share',
        line: 6,
        column: 21,
      },
    ])
  })

  it('min > max is an out-of-range error pointing at the max value', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    min: 10
    max: 5
`)
    expect(result.errors).toEqual([
      {
        code: 'out-of-range',
        message: expect.stringContaining('max (5) must be ≥ min (10)'),
        path: 'columns[0].max',
        line: 7,
        column: 10,
      },
    ])
  })

  it('dataset min-rows > max-rows is an out-of-range error pointing at max-rows', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
dataset:
  min-rows: 100
  max-rows: 10
`)
    expect(result.errors).toEqual([
      {
        code: 'out-of-range',
        message: expect.stringContaining('max-rows (10) must be ≥ min-rows (100)'),
        path: 'dataset.max-rows',
        line: 6,
        column: 13,
      },
    ])
  })

  it('unknown type spellings are rejected against the vocabulary — with an alias hint when one exists', () => {
    const alias = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    type: TEXT
`)
    expect(alias.errors).toEqual([
      {
        code: 'unknown-type',
        message: expect.stringContaining('did you mean "VARCHAR"?'),
        path: 'columns[0].type',
        line: 6,
        column: 11,
      },
    ])
    const lowercase = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    type: varchar
`)
    expect(lowercase.errors[0]).toMatchObject({
      code: 'unknown-type',
      path: 'columns[0].type',
    })
    expect(lowercase.errors[0]?.message).toContain('CONTRACT_TYPE_VOCABULARY')
    expect(lowercase.errors[0]?.message).not.toContain('did you mean') // case-sensitive: no false hint
    const parameterized = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    type: DECIMAL(18,3)
`)
    expect(parameterized.errors[0]).toMatchObject({ code: 'unknown-type' }) // parameterized spellings are a v1 non-goal
  })

  it('structural mistakes are wrong-type errors with the actual shape described', () => {
    const columnsMapping = parseFailing(`format: v1
name: x
version: 1
columns:
  id:
    required: true
`)
    expect(columnsMapping.errors[0]).toMatchObject({
      code: 'wrong-type',
      message: expect.stringContaining('expected a list of column rule mappings, got a mapping'),
      path: 'columns',
    })
    const scalarEntry = parseFailing(`format: v1
name: x
version: 1
columns:
  - just-a-string
`)
    expect(scalarEntry.errors[0]).toMatchObject({
      code: 'wrong-type',
      path: 'columns[0]',
    })
    expect(scalarEntry.errors[0]?.message).toContain('expected a column rule mapping')
  })

  it('allowed-values must be a list of scalars; null membership is explained, not guessed at', () => {
    const notAList = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    allowed-values: US
`)
    expect(notAList.errors[0]).toMatchObject({
      code: 'wrong-type',
      message: expect.stringContaining('expected a list of scalar values, got the string "US"'),
      path: 'columns[0].allowed-values',
    })
    const nullEntry = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    allowed-values: [1, null, x]
`)
    expect(nullEntry.errors).toEqual([
      {
        code: 'wrong-type',
        message: expect.stringContaining(
          'govern nullness with "required" / "max-null-share" instead',
        ),
        path: 'columns[0].allowed-values[1]',
        line: 6,
        column: 25,
      },
    ])
  })

  it('.inf / .nan are not finite numbers', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    min: .inf
`)
    expect(result.errors).toEqual([
      {
        code: 'out-of-range',
        message: expect.stringContaining('expected a finite number'),
        path: 'columns[0].min',
        line: 6,
        column: 10,
      },
    ])
  })

  it('an empty (or comment-only) document is a typed error, not a crash', () => {
    for (const text of ['', '   \n\n', '# just a comment\n']) {
      const result = parseFailing(text)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.errors[0]).toMatchObject({
        code: 'wrong-type',
        message: expect.stringContaining('the document is empty'),
        path: 'document',
        line: 1,
        column: 1,
      })
    }
  })

  it('scalar and sequence documents are wrong-type at the root', () => {
    const scalar = parseFailing('just a string\n')
    expect(scalar.errors[0]).toMatchObject({
      code: 'wrong-type',
      message: expect.stringContaining('must be a YAML mapping, got the string "just a string"'),
      line: 1,
      column: 1,
    })
    const sequence = parseFailing('- a\n- b\n')
    expect(sequence.errors[0]).toMatchObject({
      code: 'wrong-type',
      message: expect.stringContaining('must be a YAML mapping, got a sequence'),
    })
  })

  it('several independent errors are all reported, not just the first', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - required: true
  - name: b
    max-null-share: 2
`)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toMatchObject({
      code: 'missing-key',
      message: expect.stringContaining('missing required key "name"'),
      path: 'columns[0]',
      line: 5,
      column: 5,
    })
    expect(result.errors[1]).toMatchObject({
      code: 'out-of-range',
      path: 'columns[1].max-null-share',
      line: 7,
      column: 21,
    })
  })

  it('recursive anchors (alias cycles) are a typed error, never infinite recursion', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns: &c
  - name: a
  - name: b
    allowed-values: *c
`)
    expect(result.ok).toBe(false)
    // The position points at the anchor (&c, line 5) because aliases resolve
    // to their target; the path still names the offending slot.
    expect(result.errors).toEqual([
      {
        code: 'yaml-syntax',
        message: expect.stringContaining('alias cycle'),
        path: 'columns[1].allowed-values',
        line: 5,
        column: 3,
      },
    ])
  })

  it('merge keys are rejected explicitly (not silently applied)', () => {
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - &d
    name: a
    required: true
  - <<: *d
`)
    expect(result.errors[0]).toMatchObject({
      code: 'unknown-key',
      message: expect.stringContaining('unknown key "<<"'),
      path: 'columns[1]',
    })
  })

  it('non-string input (a caller bug) degrades to a typed error instead of throwing', () => {
    const result = parseFailing(42 as unknown as string)
    expect(result.errors).toEqual([
      {
        code: 'wrong-type',
        message: expect.stringContaining('must be a string of YAML text'),
        path: 'document',
        line: 1,
        column: 1,
      },
    ])
  })
})

describe('parseContract — anchors and aliases resolve; errors stay positioned', () => {
  it('aliases resolve to their anchor value (DAG sharing is legal)', () => {
    const result = parseContract(`format: v1
name: x
version: 1
columns:
  - &rule-a
    name: a
    required: true
  - name: b
    required: true
`)
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'x', version: 1 },
        columns: [
          { name: 'a', required: true },
          { name: 'b', required: true },
        ],
      },
    })
  })
})

describe('describeContractError', () => {
  it('renders the canonical greppable one-liner', () => {
    const result = parseContract('format: v1\nname: x\nversion: 0\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(describeContractError(result.errors[0])).toBe(
      `version:3:10: version: expected a positive integer, got 0`,
    )
  })
})
