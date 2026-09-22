import { describe, expect, it } from 'vitest'
import type { ContractV1 } from './ast'
import { parseContract } from './parse'
import { serializeContract } from './serialize'

/**
 * Canonical serializer pins (m5-0). The canonical form is a reviewed,
 * byte-stable surface: fixed key order, only present rules emitted, flow
 * `allowed-values`, no folding, single trailing newline. See `serialize.ts`
 * for the full spec.
 */

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

describe('serializeContract — ±0 is one value (AR-V5)', () => {
  it('serializes a contract authored with -0 byte-identically to the same contract authored with 0', () => {
    const negZero = `format: v1
name: c
version: 1
columns:
  - name: id
    min: -0
    max: -0
    allowed-values: [ -0, 1 ]
    max-null-share: -0
dataset:
  min-rows: -0
`
    const plain = `format: v1
name: c
version: 1
columns:
  - name: id
    min: 0
    max: 0
    allowed-values: [ 0, 1 ]
    max-null-share: 0
dataset:
  min-rows: 0
`
    const neg = parseContract(negZero)
    const pos = parseContract(plain)
    expect(neg.ok).toBe(true)
    expect(pos.ok).toBe(true)
    if (!neg.ok || !pos.ok) return
    expect(serializeContract(neg.contract)).toBe(serializeContract(pos.contract))
    expect(serializeContract(neg.contract)).not.toContain('-0')
    // Round-trip stable.
    const again = parseContract(serializeContract(neg.contract))
    expect(again.ok).toBe(true)
    if (again.ok) expect(serializeContract(again.contract)).toBe(serializeContract(neg.contract))
  })

  it('normalizes a caller-bug -0 in the AST too (defensive read)', () => {
    const contract: ContractV1 = {
      format: 'v1',
      metadata: { name: 'c', version: 1 },
      columns: [{ name: 'id', min: -0, max: -0, allowedValues: [-0, 1], maxNullShare: -0 }],
      dataset: { minRows: -0 },
    }
    const text = serializeContract(contract)
    expect(text).not.toContain('-0')
    expect(text).toContain('min: 0')
  })
})

describe('serializeContract — canonical byte pins', () => {
  it('serializes golden A byte-exactly (the same pin parse.test.ts parses)', () => {
    const result = parseContract(GOLDEN_A_YAML)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(serializeContract(result.contract)).toBe(GOLDEN_A_YAML)
  })

  it('a metadata-only contract serializes to exactly three lines', () => {
    const contract: ContractV1 = {
      format: 'v1',
      metadata: { name: 'minimal', version: 1 },
      columns: [],
    }
    expect(serializeContract(contract)).toBe('format: v1\nname: minimal\nversion: 1\n')
  })

  it('empty rules are omitted; an empty allowed-values is kept (it is a real constraint)', () => {
    const contract: ContractV1 = {
      format: 'v1',
      metadata: { name: 'c', version: 1 },
      columns: [{ name: 'a', allowedValues: [] }],
      dataset: {},
    }
    expect(serializeContract(contract)).toBe(
      'format: v1\nname: c\nversion: 1\ncolumns:\n  - name: a\n    allowed-values: []\n',
    )
  })

  it('rule-less column entries are dropped (the parser normalizes them away; a caller-built AST cannot smuggle them back)', () => {
    const contract = {
      format: 'v1',
      metadata: { name: 'c', version: 1 },
      columns: [{ name: 'ghost' }, { name: 'real', required: true }],
    } as unknown as ContractV1
    expect(serializeContract(contract)).toBe(
      'format: v1\nname: c\nversion: 1\ncolumns:\n  - name: real\n    required: true\n',
    )
    // All entries rule-less ⇒ the columns key disappears entirely, matching
    // what the parser produces for the same input.
    const allGhost = {
      format: 'v1',
      metadata: { name: 'c', version: 1 },
      columns: [{ name: 'ghost' }],
    } as unknown as ContractV1
    expect(serializeContract(allGhost)).toBe('format: v1\nname: c\nversion: 1\n')
  })

  it('strings that would parse as bool/number/null are quoted; multi-line strings use literal blocks', () => {
    const contract: ContractV1 = {
      format: 'v1',
      metadata: {
        name: 'quoting',
        version: 1,
        description: 'two\nlines\nwith a trailing newline',
      },
      columns: [{ name: 'flag', allowedValues: [true, 'true', 1, '1', 'null'] }],
    }
    expect(serializeContract(contract)).toBe(`format: v1
name: quoting
version: 1
description: |-
  two
  lines
  with a trailing newline
columns:
  - name: flag
    allowed-values: [ true, "true", 1, "1", "null" ]
`)
  })

  it('descriptions with quotes and unicode round-trip through the canonical quoting', () => {
    const contract: ContractV1 = {
      format: 'v1',
      metadata: { name: 'quotes', version: 1, description: "it's 'quoted' — ünï ✓" },
      columns: [],
    }
    const text = serializeContract(contract)
    expect(text).toContain(`description: it's 'quoted' — ünï ✓`)
    expect(parseContract(text)).toEqual({ ok: true, contract })
  })
})

describe('serializeContract — canonical stability across equivalent sources', () => {
  const sources = [
    // Canonical itself
    GOLDEN_A_YAML,
    // Root keys shuffled, comment noise, flow dataset
    `dataset: {min-rows: 1, max-rows: 1000000}\n# a comment\nversion: 2\ndescription: Quality gates for the customers feed\nname: customers-quality\nformat: v1\ncolumns:\n  - name: customer_id\n    unique: true\n    required: true\n    type: BIGINT\n  - name: email\n    required: true\n    regex: '^[^@]+@[^@]+\\.[^@]+$'\n    max-null-share: 0\n  - name: country\n    allowed-values: [US, GB, DE]\n    min-distinct-share: 0.5\n    type: VARCHAR\n  - name: age\n    min: 0\n    max: 120\n    type: INTEGER\n`,
    // Deeper indentation, block allowed-values, quoted keys
    `format: v1\n"name": customers-quality\n'version': 2\ndescription: Quality gates for the customers feed\n` +
      `columns:\n    - name: customer_id\n      type: BIGINT\n      required: true\n      unique: true\n    - name: email\n      required: true\n      regex: "^[^@]+@[^@]+\\\\.[^@]+$"\n      max-null-share: 0\n    - name: country\n      type: VARCHAR\n      allowed-values:\n        - US\n        - GB\n        - DE\n      min-distinct-share: 0.5\n    - name: age\n      type: INTEGER\n      min: 0\n      max: 120\ndataset:\n  min-rows: 1\n  max-rows: 1000000\n`,
  ]

  it('every equivalent source parses to the identical AST', () => {
    const parsed = sources.map((source) => parseContract(source))
    for (const result of parsed) expect(result.ok).toBe(true)
    expect(parsed[0]).toEqual(parsed[1])
    expect(parsed[0]).toEqual(parsed[2])
  })

  it('every equivalent source serializes to the identical bytes', () => {
    const texts = sources.map((source) => {
      const result = parseContract(source)
      expect(result.ok).toBe(true)
      return result.ok ? serializeContract(result.contract) : ''
    })
    expect(texts[0]).toBe(GOLDEN_A_YAML)
    expect(texts[1]).toBe(GOLDEN_A_YAML)
    expect(texts[2]).toBe(GOLDEN_A_YAML)
  })

  it('serialization is a fixpoint: parse(serialize(parse(text))) is byte-identical', () => {
    for (const source of sources) {
      const once = parseContract(source)
      expect(once.ok).toBe(true)
      if (!once.ok) continue
      const first = serializeContract(once.contract)
      const again = parseContract(first)
      expect(again.ok).toBe(true)
      if (!again.ok) continue
      expect(serializeContract(again.contract)).toBe(first)
    }
  })
})

describe('serializeContract — defensive reads (typed input, total function)', () => {
  /**
   * The parameter is typed `ContractV1` — trusted input, like `baseRowId`'s
   * ordinal in `@assay/domain`. These pins document what a caller bug behind
   * a cast does: deterministic, plain output that never throws (and is not
   * guaranteed to re-parse as a valid contract).
   */
  it('never throws and is deterministic for a wildly non-conforming value', () => {
    const garbage = {
      format: 'v9',
      metadata: { name: 42, version: 'x' },
      columns: 'not-a-list',
      dataset: { minRows: 'many' },
    } as unknown as ContractV1
    const first = serializeContract(garbage)
    const second = serializeContract(garbage)
    expect(first).toBe(second)
    expect(() => JSON.parse(JSON.stringify(first))).not.toThrow()
  })

  it('drops rule values outside their domains instead of emitting them', () => {
    const contract = {
      format: 'v1',
      metadata: { name: 'c', version: 1 },
      columns: [
        {
          name: 'a',
          min: Number.NaN,
          max: Number.POSITIVE_INFINITY,
          maxNullShare: 7,
          minDistinctShare: -1,
          allowedValues: [Number.NaN, 'ok', {}, null],
        },
      ],
    } as unknown as ContractV1
    expect(serializeContract(contract)).toBe(
      'format: v1\nname: c\nversion: 1\ncolumns:\n  - name: a\n    allowed-values: [ ok ]\n',
    )
  })

  it('a BigInt version (unconstructible via the format) falls back to the default', () => {
    const contract = {
      format: 'v1',
      metadata: { name: 'c', version: 9007199254740993n },
      columns: [],
    } as unknown as ContractV1
    expect(serializeContract(contract)).toBe('format: v1\nname: c\nversion: 1\n')
  })
})
