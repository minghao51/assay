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

  it('normalizes semantically-empty rules away, including a rule-less column entry', () => {
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
    // The rule-less entry (only a name, its other rules all false) normalizes
    // away with the rest: the AST is byte-for-byte the metadata-only shape.
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'normalizes-to-minimal', version: 3 },
        columns: [],
      },
    })
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe(
      'format: v1\nname: normalizes-to-minimal\nversion: 3\n',
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

describe('parseContract — rule-less column entries normalize away (one shape per meaning)', () => {
  it('a columns[] entry carrying only a name is dropped, like any semantically-empty rule', () => {
    const result = parseContract('format: v1\nname: x\nversion: 1\ncolumns:\n  - name: id\n')
    expect(result).toEqual({
      ok: true,
      contract: { format: 'v1', metadata: { name: 'x', version: 1 }, columns: [] },
    })
    if (!result.ok) return
    // Canonical serialization is then indistinguishable from never listing
    // the column — the fixpoint holds.
    expect(serializeContract(result.contract)).toBe('format: v1\nname: x\nversion: 1\n')
  })

  it('rule-less entries drop; ruled entries keep their relative order', () => {
    const result = parseContract(`format: v1
name: x
version: 1
columns:
  - name: ghost
  - name: real
    required: true
  - name: also-ghost
    unique: false
  - name: real-2
    type: VARCHAR
`)
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'x', version: 1 },
        columns: [
          { name: 'real', required: true },
          { name: 'real-2', type: 'VARCHAR' },
        ],
      },
    })
  })

  it('a rule-less entry still participates in duplicate-name rejection', () => {
    // Chosen semantics (documented in ast.ts): declaring a column twice is an
    // authoring error even when one entry carries no rules — the duplicate
    // check runs on declared entries, before the rule-less drop.
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
  - name: a
    required: true
`)
    expect(result.errors).toEqual([
      {
        code: 'duplicate-key',
        message: expect.stringContaining(
          'duplicate column name "a" — columns[0] already declares it',
        ),
        path: 'columns[1]',
        line: 6,
        column: 5,
      },
    ])
  })
})

describe('parseContract — rule numbers are exact or rejected (imprecise-number)', () => {
  const expectImprecise = (
    text: string,
    at: { path: string; line: number; column: number },
    messageSubstance: string,
  ) => {
    const result = parseFailing(text)
    expect(result.errors).toEqual([
      {
        code: 'imprecise-number',
        message: expect.stringContaining(messageSubstance),
        path: at.path,
        line: at.line,
        column: at.column,
      },
    ])
  }

  it('a 17th-significant-digit integer bound is rejected, naming the written literal', () => {
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    min: 9007199254740993
`,
      { path: 'columns[0].min', line: 6, column: 10 },
      'the written number 9007199254740993 would be silently altered',
    )
  })

  it('the imprecise-number message names the written literal, never the rounded double', () => {
    // 9007199254740993 parses to the double 9007199254740992. The error
    // reports what the author wrote; echoing the read-back value would name
    // a number that appears nowhere in the document — the very corruption
    // the exactness gate refuses.
    const result = parseFailing(
      'format: v1\nname: x\nversion: 1\ncolumns:\n  - name: a\n    min: 9007199254740993\n',
    )
    const message = result.errors.map((error) => error.message).join('\n')
    expect(message).toContain('9007199254740993')
    expect(message).not.toContain('9007199254740992')
  })

  it('the same corruption inside allowed-values is rejected at the entry', () => {
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    allowed-values: [9007199254740993]
`,
      { path: 'columns[0].allowed-values[0]', line: 6, column: 22 },
      'the written number 9007199254740993',
    )
  })

  it('a corrupted literal on an integer slot reports imprecise-number, not the rounded value', () => {
    expectImprecise(
      'format: v1\nname: x\nversion: 9007199254740993\n',
      { path: 'version', line: 3, column: 10 },
      'the written number 9007199254740993',
    )
    expectImprecise(
      `format: v1
name: x
version: 1
dataset:
  min-rows: 9007199254740993
`,
      { path: 'dataset.min-rows', line: 5, column: 13 },
      'the written number 9007199254740993',
    )
  })

  it('exponential spellings are judged by value, not shape', () => {
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    max: 9.007199254740993e15
`,
      { path: 'columns[0].max', line: 6, column: 10 },
      'the written number 9.007199254740993e15 would be silently altered',
    )
    // The exact exponential spelling of 2^53 is accepted and canonicalizes
    // to the plain form (same value ⇒ same AST ⇒ same bytes).
    const exact = parseContract(`format: v1
name: x
version: 1
columns:
  - name: a
    min: 9.007199254740992e15
`)
    expect(exact).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'x', version: 1 },
        columns: [{ name: 'a', min: 9007199254740992 }],
      },
    })
    if (!exact.ok) return
    const text = serializeContract(exact.contract)
    expect(text).toContain('min: 9007199254740992')
    expect(parseContract(text)).toEqual(exact)
  })

  it('an over-precise decimal is rejected; the plain spelling of the same value is fine', () => {
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    min: 0.1000000000000000000000001
`,
      { path: 'columns[0].min', line: 6, column: 10 },
      'the written number 0.1000000000000000000000001',
    )
    const plain = parseContract(
      'format: v1\nname: x\nversion: 1\ncolumns:\n  - name: a\n    min: 0.1\n',
    )
    expect(plain.ok).toBe(true)
  })

  it('over-precise shares are rejected too', () => {
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    max-null-share: 0.3333333333333333333333
`,
      { path: 'columns[0].max-null-share', line: 6, column: 21 },
      'the written number 0.3333333333333333333333',
    )
  })

  it('exactly representable large bounds are accepted (the boundary is exactness, not size)', () => {
    const result = parseContract(`format: v1
name: x
version: 1
columns:
  - name: a
    min: 9007199254740992
`)
    expect(result).toEqual({
      ok: true,
      contract: {
        format: 'v1',
        metadata: { name: 'x', version: 1 },
        columns: [{ name: 'a', min: 9007199254740992 }],
      },
    })
    if (!result.ok) return
    const text = serializeContract(result.contract)
    expect(text).toContain('min: 9007199254740992')
    expect(parseContract(text)).toEqual(result) // fixpoint: serialization re-parses identically
  })

  it('hexadecimal literals fail closed; library-resolvable tags are accepted by their content literal', () => {
    // 0x1F parses to the number 31, but the written spelling is not a plain
    // decimal literal whose exact value the format can verify — rejected.
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    min: 0x1F
`,
      { path: 'columns[0].min', line: 6, column: 10 },
      'cannot verify the exact value of "0x1F"',
    )
    // Deliberate policy (documented in numeric.ts / errors.ts, pinned
    // here): a *library-resolvable* tagged form is accepted — the tag sits
    // *outside* the scalar's source range, so the exactness gate judges the
    // *content* literal under exactly the same rule as the plain spelling.
    // Acceptance is exactly as wide as library resolution: a tag the library
    // cannot resolve is a parse warning — already a `yaml-syntax` error —
    // and a non-numeric tag fails `wrong-type`, so no tag path bypasses the
    // gate.
    for (const [literal, expected] of [
      ['!!int 5', 5],
      ['!!int +5', 5],
      ['!!float 1.5', 1.5],
    ] as const) {
      const result = parseContract(`format: v1
name: x
version: 1
columns:
  - name: a
    min: ${literal}
`)
      expect(result).toEqual({
        ok: true,
        contract: {
          format: 'v1',
          metadata: { name: 'x', version: 1 },
          columns: [{ name: 'a', min: expected }],
        },
      })
    }
    // The gate still guards the content: the same corruption under a tag is
    // caught, with the message naming the written literal (never the rounded
    // read-back double).
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    min: !!int 9007199254740993
`,
      { path: 'columns[0].min', line: 6, column: 16 },
      'the written number 9007199254740993',
    )
    // Non-plain-decimal content under a tag is unverifiable — rejected.
    expectImprecise(
      `format: v1
name: x
version: 1
columns:
  - name: a
    min: !!int 0x1F
`,
      { path: 'columns[0].min', line: 6, column: 16 },
      'cannot verify the exact value of "0x1F"',
    )
  })

  it('a standard-looking tag the library cannot resolve (!!float 2) → yaml-syntax, never the exactness gate', () => {
    // Pin of the acceptance boundary: the float resolver needs a `.` or
    // exponent in the content, so `!!float 2` stays unresolved — the parse
    // warns "Unresolved tag" and the contract fails `yaml-syntax` before any
    // numeric rule is read (documented in numeric.ts / errors.ts).
    const result = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    min: !!float 2
`)
    expect(result.errors).toEqual([
      {
        code: 'yaml-syntax',
        message: expect.stringContaining('Unresolved tag'),
        path: 'document',
        line: 6,
        column: 10,
      },
    ])
  })
})

describe('parseContract — adversarial spellings hit own-property lookups only', () => {
  it('prototype-named type values are unknown types with no bogus suggestion', () => {
    for (const spelling of ['__proto__', 'constructor', 'toString']) {
      const result = parseFailing(
        `format: v1\nname: x\nversion: 1\ncolumns:\n  - name: a\n    type: ${spelling}\n`,
      )
      expect(result.errors[0]).toMatchObject({
        code: 'unknown-type',
        path: 'columns[0].type',
        line: 6,
        column: 11,
      })
      expect(result.errors[0]?.message).toContain(`unknown declared type "${spelling}"`)
      expect(result.errors[0]?.message).not.toContain('did you mean') // no inherited-member "suggestion"
    }
  })

  it('prototype-named mapping keys are typed unknown-key errors, never a crash', () => {
    const atRoot = parseFailing('format: v1\nname: x\nversion: 1\nconstructor: x\n')
    expect(atRoot.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining('unknown key "constructor" at the document root'),
        path: 'document',
        line: 4,
        column: 1,
      },
    ])
    const inColumn = parseFailing(`format: v1
name: x
version: 1
columns:
  - name: a
    toString: x
`)
    expect(inColumn.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining('unknown key "toString" in the rule set at "columns[0]"'),
        path: 'columns[0]',
        line: 6,
        column: 5,
      },
    ])
    const inDataset = parseFailing(`format: v1
name: x
version: 1
dataset:
  valueOf: 1
`)
    expect(inDataset.errors).toEqual([
      {
        code: 'unknown-key',
        message: expect.stringContaining('unknown key "valueOf" in the "dataset" mapping'),
        path: 'dataset',
        line: 5,
        column: 3,
      },
    ])
    const dunderRoot = parseFailing(
      'format: v1\nname: x\nversion: 1\ncolumns:\n  - name: a\n    __proto__: x\n',
    )
    expect(dunderRoot.errors[0]).toMatchObject({ code: 'unknown-key', path: 'columns[0]' })
  })
})

describe('parseContract — BOM-prefixed documents report visible columns', () => {
  it('an error on the first line points at the visible column (BOM not counted)', () => {
    const result = parseFailing('\uFEFFformat: v2\nname: x\n')
    expect(result.errors).toEqual([
      {
        code: 'unsupported-format',
        message: expect.stringContaining('implements "v1" only'),
        path: 'format',
        line: 1,
        column: 9, // visible column of the "v2" value — not 10 (pre-fix: off by one)
      },
    ])
    const unknownFirst = parseFailing('\uFEFFbogus: 1\nformat: v1\nname: x\nversion: 1\n')
    expect(unknownFirst.errors[0]).toMatchObject({
      code: 'unknown-key',
      line: 1,
      column: 1, // visible column of the "bogus" key — not 2
    })
  })

  it('lines after the BOM are unaffected', () => {
    const result = parseFailing('\uFEFFformat: v1\nname: x\nversion: 0\n')
    expect(result.errors[0]).toMatchObject({
      code: 'out-of-range',
      path: 'version',
      line: 3,
      column: 10,
    })
  })

  it('a valid BOM-prefixed contract parses; canonical output carries no BOM', () => {
    const result = parseContract('\uFEFFformat: v1\nname: bom\nversion: 1\n')
    expect(result).toEqual({
      ok: true,
      contract: { format: 'v1', metadata: { name: 'bom', version: 1 }, columns: [] },
    })
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe('format: v1\nname: bom\nversion: 1\n')
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

describe('parseContract — NUL is refused at the parse seam (AR-V2)', () => {
  it.each([
    [
      'column name',
      'format: v1\nname: n\nversion: 1\ncolumns:\n  - name: "a\\0b"\n    required: true\n',
    ],
    [
      'allowed-values entry',
      'format: v1\nname: n\nversion: 1\ncolumns:\n  - name: x\n    allowed-values: ["a\\0b"]\n',
    ],
    [
      'regex pattern',
      'format: v1\nname: n\nversion: 1\ncolumns:\n  - name: x\n    regex: "a\\0b"\n',
    ],
    ['metadata name', 'format: v1\nname: "a\\0b"\nversion: 1\n'],
    ['metadata description', 'format: v1\nname: n\nversion: 1\ndescription: "a\\0b"\n'],
  ])('rejects a NUL in a %s with a typed out-of-range error', (_label, document) => {
    const result = parseContract(document)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const error = result.errors[0]
    expect(error?.code).toBe('out-of-range')
    expect(error?.message).toContain('NUL')
  })

  it('the NUL rejection keeps the compiler taxonomy honest: parsed NUL never reaches invalid-contract-input', () => {
    const result = parseContract(
      'format: v1\nname: n\nversion: 1\ncolumns:\n  - name: "a\\0b"\n    required: true\n',
    )
    expect(result.ok).toBe(false)
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
