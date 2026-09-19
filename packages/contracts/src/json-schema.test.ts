import { describe, expect, it } from 'vitest'
import type { ContractV1 } from './ast'
import type { JsonSchemaAdapterError, JsonSchemaAdapterResult } from './json-schema'
import { jsonSchemaToContract } from './json-schema'
import { parseContract } from './parse'
import { serializeContract } from './serialize'
import { makeTestRng, type TestRng } from './property-testing'

/**
 * Tests for the JSON Schema → contract adapter (m5-5): golden pins (exact
 * AST + exact canonical bytes), the unsupported-key matrix (the queue's core
 * requirement — every unsupported key reported, all collected), per-code
 * malformed pins, hostile totality probes, and the seeded property suites
 * (the done-when: adapter output always round-trips through m5-0
 * `parseContract`; totality never throws).
 *
 * Conventions mirror the m5-0 test files: mulberry32 PRNG with fixed
 * date-of-work-derived seeds committed here, no `Math.random`.
 */

/** Run a conversion that must fail; narrows the union for the pins below. */
function convertFailing(schema: unknown): {
  ok: false
  errors: readonly JsonSchemaAdapterError[]
} {
  const result = jsonSchemaToContract(schema)
  expect(result.ok).toBe(false)
  return result as { ok: false; errors: readonly JsonSchemaAdapterError[] }
}

/** Run a conversion that must succeed; narrows the union. */
function convertOk(schema: unknown): { ok: true; contract: ContractV1 } {
  const result = jsonSchemaToContract(schema)
  expect(result.ok).toBe(true)
  return result as { ok: true; contract: ContractV1 }
}

/** A minimal in-subset object schema around the given properties. */
function objectSchema(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { title: 't', type: 'object', properties, ...extra }
}

// ---------------------------------------------------------------------------
// Golden pins
// ---------------------------------------------------------------------------

describe('golden: full-subset conversion', () => {
  /**
   * Golden A — every supported mapping at once: ignored `$schema`,
   * title/description metadata, all four type spellings plus the
   * single-element array form, required, enum (string/boolean/empty),
   * minimum/maximum, and verbatim RE2-subset patterns.
   */
  const GOLDEN_A_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'customers-quality',
    description: 'Converted from the customers feed schema',
    type: 'object',
    properties: {
      customer_id: { type: 'string', pattern: '^[A-Z]{2}[0-9]+$' },
      email: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' },
      country: { type: 'string', enum: ['US', 'GB', 'DE'] },
      age: { type: 'integer', minimum: 0, maximum: 120 },
      score: { type: 'number', minimum: 0 },
      flag: { type: 'boolean', enum: [true, false] },
      note: { enum: [] },
      ratio: { type: ['number'] },
    },
    required: ['customer_id', 'email', 'country'],
  }

  const GOLDEN_A_AST: ContractV1 = {
    format: 'v1',
    metadata: {
      name: 'customers-quality',
      version: 1,
      description: 'Converted from the customers feed schema',
    },
    columns: [
      {
        name: 'customer_id',
        type: 'VARCHAR',
        required: true,
        regex: '^[A-Z]{2}[0-9]+$',
      },
      {
        name: 'email',
        type: 'VARCHAR',
        required: true,
        regex: '^[^@]+@[^@]+\\.[^@]+$',
      },
      { name: 'country', type: 'VARCHAR', required: true, allowedValues: ['US', 'GB', 'DE'] },
      { name: 'age', type: 'BIGINT', min: 0, max: 120 },
      { name: 'score', type: 'DOUBLE', min: 0 },
      { name: 'flag', type: 'BOOLEAN', allowedValues: [true, false] },
      { name: 'note', allowedValues: [] },
      { name: 'ratio', type: 'DOUBLE' },
    ],
  }

  it('converts to the exact AST', () => {
    expect(convertOk(GOLDEN_A_SCHEMA)).toEqual({ ok: true, contract: GOLDEN_A_AST })
  })

  it('serializes to the exact canonical bytes', () => {
    const { contract } = convertOk(GOLDEN_A_SCHEMA)
    const canonical = serializeContract(contract)
    expect(canonical).toBe(
      [
        'format: v1',
        'name: customers-quality',
        'version: 1',
        'description: Converted from the customers feed schema',
        'columns:',
        '  - name: customer_id',
        '    type: VARCHAR',
        '    required: true',
        '    regex: ^[A-Z]{2}[0-9]+$',
        '  - name: email',
        '    type: VARCHAR',
        '    required: true',
        '    regex: ^[^@]+@[^@]+\\.[^@]+$',
        '  - name: country',
        '    type: VARCHAR',
        '    required: true',
        '    allowed-values: [ US, GB, DE ]',
        '  - name: age',
        '    type: BIGINT',
        '    min: 0',
        '    max: 120',
        '  - name: score',
        '    type: DOUBLE',
        '    min: 0',
        '  - name: flag',
        '    type: BOOLEAN',
        '    allowed-values: [ true, false ]',
        '  - name: note',
        '    allowed-values: []',
        '  - name: ratio',
        '    type: DOUBLE',
        '',
      ].join('\n'),
    )
  })

  it('the conversion round-trips through the m5-0 parser (identity)', () => {
    const { contract } = convertOk(GOLDEN_A_SCHEMA)
    const text = serializeContract(contract)
    expect(parseContract(text)).toEqual({ ok: true, contract })
  })
})

describe('golden: minimal and boundary conversions', () => {
  it('a schema with no properties converts to the empty-columns contract', () => {
    const { contract } = convertOk({ title: 'empty', type: 'object' })
    expect(contract).toEqual({
      format: 'v1',
      metadata: { name: 'empty', version: 1 },
      columns: [],
    })
    expect(serializeContract(contract)).toBe('format: v1\nname: empty\nversion: 1\n')
  })

  it('the type-array form (["object"] root, ["integer"] property) matches the string form', () => {
    const stringForm = convertOk({
      title: 'a',
      type: 'object',
      properties: { n: { type: 'integer' } },
    }).contract
    const arrayForm = convertOk({
      title: 'a',
      type: ['object'],
      properties: { n: { type: ['integer'] } },
    }).contract
    expect(arrayForm).toEqual(stringForm)
  })

  it('a property constrained only by required becomes a required-only column', () => {
    const { contract } = convertOk(objectSchema({ id: {} }, { required: ['id'] }))
    expect(contract.columns).toEqual([{ name: 'id', required: true }])
  })

  it('a property schema that yields no rule normalizes away (mirrors m5-0 rule-less entries)', () => {
    const { contract } = convertOk(objectSchema({ id: {}, note: { type: 'string' } }))
    expect(contract.columns).toEqual([{ name: 'note', type: 'VARCHAR' }])
  })

  it('description: "" normalizes to absent (mirrors m5-0)', () => {
    const { contract } = convertOk(objectSchema({ id: { type: 'string' } }, { description: '' }))
    expect(contract.metadata.description).toBeUndefined()
    expect(contract.metadata).toEqual({ name: 't', version: 1 })
  })
})

// ---------------------------------------------------------------------------
// Unsupported-key matrix — nothing is ever silently dropped
// ---------------------------------------------------------------------------

describe('unsupported keys: every key outside the subset is reported', () => {
  it('reports unsupported root keys with their pointer paths', () => {
    for (const key of [
      '$id',
      '$defs',
      'additionalProperties',
      'allOf',
      'anyOf',
      'oneOf',
      'not',
      'default',
      'examples',
      'if',
      'unevaluatedProperties',
      '$comment',
      'const',
    ]) {
      const schema: Record<string, unknown> = { title: 't', type: 'object', properties: {} }
      schema[key] = { anything: true }
      const { errors } = convertFailing(schema)
      const unsupported = errors.filter((error) => error.code === 'unsupported-key')
      expect(unsupported, `root key ${key}`).toHaveLength(1)
      expect(unsupported[0]?.path, `root key ${key}`).toBe(`/${key}`)
      expect(unsupported[0]?.message, `root key ${key}`).toContain(`"${key}"`)
    }
  })

  it('reports unsupported property keys with their pointer paths, all collected', () => {
    const { errors } = convertFailing(
      objectSchema(
        {
          when: {
            format: 'date-time',
            minLength: 1,
            maxLength: 10,
            multipleOf: 0.01,
            default: 5,
            examples: [1],
            items: { type: 'string' },
            patternProperties: { '^x': {} },
            propertyNames: {},
            const: 5,
            title: 'annotated',
            description: 'annotated',
            uniqueItems: true,
            minItems: 1,
            $ref: '#/$defs/x',
          },
        },
        { required: ['when'] },
      ),
    )
    const unsupported = errors.filter((error) => error.code === 'unsupported-key')
    const paths = unsupported.map((error) => error.path)
    expect(paths).toEqual([
      '/properties/when/format',
      '/properties/when/minLength',
      '/properties/when/maxLength',
      '/properties/when/multipleOf',
      '/properties/when/default',
      '/properties/when/examples',
      '/properties/when/items',
      '/properties/when/patternProperties',
      '/properties/when/propertyNames',
      '/properties/when/const',
      '/properties/when/title',
      '/properties/when/description',
      '/properties/when/uniqueItems',
      '/properties/when/minItems',
      '/properties/when/$ref',
    ])
  })

  it('reports exclusive bounds as unsupported keys, naming the inclusivity gap', () => {
    const { errors } = convertFailing(
      objectSchema({ age: { exclusiveMinimum: 0, exclusiveMaximum: 100 } }),
    )
    const unsupported = errors.filter((error) => error.code === 'unsupported-key')
    expect(unsupported).toHaveLength(2)
    expect(unsupported[0]?.path).toBe('/properties/age/exclusiveMinimum')
    expect(unsupported[1]?.path).toBe('/properties/age/exclusiveMaximum')
    for (const error of unsupported) {
      expect(error.message).toContain('no honest inclusive mapping')
    }
  })

  it('reports pattern as an unsupported key when it is not RE2-subset-safe (dialect honesty)', () => {
    for (const [pattern, fragment] of [
      ['(?=.*[a-z])', 'lookaround'],
      ['(?<=a)b', 'lookbehind'],
      ['(a)\\1', 'backreference'],
      ['\\u0041', 'RE2 has no \\u escape'],
      ['\\x41', 'conservative filter'],
      ['a*+', 'possessive'],
      ['[[:digit:]]', 'POSIX'],
    ] as const) {
      const { errors } = convertFailing(objectSchema({ code: { pattern } }))
      const unsupported = errors.filter((error) => error.code === 'unsupported-key')
      expect(unsupported, `pattern ${pattern}`).toHaveLength(1)
      expect(unsupported[0]?.path, `pattern ${pattern}`).toBe('/properties/code/pattern')
      expect(unsupported[0]?.message, `pattern ${pattern}`).toContain(fragment)
      expect(unsupported[0]?.message, `pattern ${pattern}`).toContain('nothing is approximated')
    }
  })

  it('collects all independent unsupported keys across the whole document', () => {
    const { errors } = convertFailing({
      title: 't',
      type: 'object',
      $id: 'https://example.com/x',
      additionalProperties: false,
      properties: { a: { type: 'string', format: 'uuid' }, b: { minimum: 0, multipleOf: 2 } },
    })
    expect(errors.map((error) => [error.code, error.path])).toEqual([
      ['unsupported-key', '/$id'],
      ['unsupported-key', '/additionalProperties'],
      ['unsupported-key', '/properties/a/format'],
      ['unsupported-key', '/properties/b/multipleOf'],
    ])
  })

  it('property title/description are unsupported (contract v1 has no per-column docs)', () => {
    const { errors } = convertFailing(
      objectSchema({ a: { type: 'string', title: 'A', description: 'the a column' } }),
    )
    const unsupported = errors.filter((error) => error.code === 'unsupported-key')
    expect(unsupported.map((error) => error.path)).toEqual([
      '/properties/a/title',
      '/properties/a/description',
    ])
  })
})

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

describe('type mapping', () => {
  it('maps the four scalar spellings (pinned via the golden above)', () => {
    const { contract } = convertOk(
      objectSchema({
        s: { type: 'string' },
        i: { type: 'integer' },
        n: { type: 'number' },
        b: { type: 'boolean' },
      }),
    )
    expect(contract.columns.map((column) => column.type)).toEqual([
      'VARCHAR',
      'BIGINT',
      'DOUBLE',
      'BOOLEAN',
    ])
  })

  it('stops at the root when the schema is not object-rooted', () => {
    for (const [root, fragment] of [
      [{}, 'declares no "type"'],
      [{ type: 'array' }, 'only object-rooted'],
      [{ type: ['object', 'string'] }, 'only object-rooted'],
      [{ type: 'string' }, 'only object-rooted'],
    ] as const) {
      const { errors } = convertFailing({
        title: 't',
        ...root,
        properties: { a: { type: 'string' } },
      })
      expect(errors, JSON.stringify(root)).toHaveLength(1)
      expect(errors[0]?.code, JSON.stringify(root)).toBe('unsupported-type')
      expect(errors[0]?.path, JSON.stringify(root)).toBe('/type')
      expect(errors[0]?.message, JSON.stringify(root)).toContain(fragment)
    }
  })

  it('reports property types with no honest vocabulary target', () => {
    for (const type of ['array', 'object', 'null']) {
      const { errors } = convertFailing(objectSchema({ a: { type } }))
      expect(errors, type).toEqual([
        expect.objectContaining({
          code: 'unsupported-type',
          path: `/properties/a/type`,
          message: expect.stringContaining('no honest target in the contract type vocabulary'),
        }),
      ])
    }
  })

  it('refuses type unions beyond the single-element array form (no silent null-stripping)', () => {
    const { errors } = convertFailing(objectSchema({ a: { type: ['string', 'null'] } }))
    expect(errors[0]?.code).toBe('unsupported-type')
    expect(errors[0]?.message).toContain('no single honest declared-type')
    const empty = convertFailing(objectSchema({ a: { type: [] } }))
    expect(empty.errors[0]?.message).toContain('empty type array')
  })

  it('a property without type simply has no declared-type rule', () => {
    const { contract } = convertOk(objectSchema({ a: { minimum: 0 } }))
    expect(contract.columns).toEqual([{ name: 'a', min: 0 }])
  })
})

// ---------------------------------------------------------------------------
// enum / bounds / required mapping
// ---------------------------------------------------------------------------

describe('enum mapping', () => {
  it('maps string, number, boolean and mixed-kind enums (m5-0 entry kinds allow all)', () => {
    const { contract } = convertOk(
      objectSchema({
        c: { enum: ['US', 'GB'] },
        n: { enum: [0, 1.5, -3] },
        b: { enum: [true, false] },
        m: { enum: ['US', 5, true] },
      }),
    )
    expect(contract.columns.map((column) => column.allowedValues)).toEqual([
      ['US', 'GB'],
      [0, 1.5, -3],
      [true, false],
      ['US', 5, true],
    ])
  })

  it('preserves an empty enum as the real constraint allowed-values: []', () => {
    const { contract } = convertOk(objectSchema({ never: { enum: [] } }))
    expect(contract.columns).toEqual([{ name: 'never', allowedValues: [] }])
  })

  it('rejects null entries (nullness is required/max-null-share territory), objects and arrays', () => {
    for (const [entry, fragment] of [
      [null, 'null membership is not expressible'],
      [{ nested: true }, 'got an object'],
      [[1], 'got an array'],
      [['nested'], 'got an array'],
    ] as const) {
      const { errors } = convertFailing(objectSchema({ a: { enum: ['ok', entry] } }))
      expect(errors, JSON.stringify(entry)).toEqual([
        expect.objectContaining({
          code: 'wrong-type',
          path: '/properties/a/enum/1',
          message: expect.stringContaining(fragment),
        }),
      ])
    }
  })

  it('a non-array enum is a wrong-type error', () => {
    const { errors } = convertFailing(objectSchema({ a: { enum: 'US' } }))
    expect(errors[0]?.code).toBe('wrong-type')
    expect(errors[0]?.path).toBe('/properties/a/enum')
  })
})

describe('minimum/maximum mapping', () => {
  it('maps inclusive bounds and keeps derived min>max an error (mirrors m5-0)', () => {
    const { errors } = convertFailing(objectSchema({ a: { minimum: 10, maximum: 5 } }))
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'out-of-range',
        path: '/properties/a/maximum',
        message: expect.stringContaining('maximum (5) must be ≥ minimum (10)'),
      }),
    ])
    const equal = convertOk(objectSchema({ a: { minimum: 5, maximum: 5 } }))
    expect(equal.contract.columns).toEqual([{ name: 'a', min: 5, max: 5 }])
  })

  it('bounds carry exactly the numbers given (2^53 boundary pin)', () => {
    // 2^53 is exactly representable and round-trips through m5-0's
    // comparator (the written-literal gate's acceptance, scoped to parsed
    // values — see the module doc's numerics section).
    const twoTo53 = 9007199254740992
    const { contract } = convertOk(objectSchema({ a: { minimum: twoTo53, maximum: twoTo53 } }))
    expect(contract.columns[0]?.min).toBe(twoTo53)
    expect(contract.columns[0]?.max).toBe(twoTo53)
    expect(parseContract(serializeContract(contract))).toEqual({ ok: true, contract })
  })

  it('non-numbers and non-finite numbers (hostile) are typed errors', () => {
    const { errors } = convertFailing(objectSchema({ a: { minimum: '0' } }))
    expect(errors[0]).toMatchObject({ code: 'wrong-type', path: '/properties/a/minimum' })
    const hostile = objectSchema({})
    Object.defineProperty(hostile.properties, 'a', {
      enumerable: true,
      value: { minimum: Number.POSITIVE_INFINITY },
    })
    const nonFinite = convertFailing(hostile)
    expect(nonFinite.errors[0]).toMatchObject({
      code: 'out-of-range',
      path: '/properties/a/minimum',
    })
  })
})

describe('required mapping', () => {
  it('marks the named properties required', () => {
    const { contract } = convertOk(
      objectSchema(
        { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
        { required: ['a', 'c'] },
      ),
    )
    expect(contract.columns.map((column) => [column.name, column.required])).toEqual([
      ['a', true],
      ['b', undefined],
      ['c', true],
    ])
  })

  it('an empty required array is fine', () => {
    const { contract } = convertOk(objectSchema({ a: { type: 'string' } }, { required: [] }))
    expect(contract.columns).toEqual([{ name: 'a', type: 'VARCHAR' }])
  })

  it('names without a properties entry are unknown-key errors (m5-0 unknown-column strictness)', () => {
    const { errors } = convertFailing(objectSchema({ a: {} }, { required: ['ghost'] }))
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'unknown-key',
        path: '/required/0',
        message: expect.stringContaining('"ghost"'),
      }),
    ])
  })

  it('duplicate names are duplicate-key errors at the second occurrence', () => {
    const { errors } = convertFailing(objectSchema({ a: {} }, { required: ['a', 'a'] }))
    expect(errors).toEqual([
      expect.objectContaining({ code: 'duplicate-key', path: '/required/1' }),
    ])
  })

  it('non-string entries and non-array values are wrong-type errors', () => {
    const { errors } = convertFailing(objectSchema({ a: {} }, { required: ['a', 5] }))
    expect(errors[0]).toMatchObject({ code: 'wrong-type', path: '/required/1' })
    const notArray = convertFailing(objectSchema({ a: {} }, { required: 'a' }))
    expect(notArray.errors[0]).toMatchObject({ code: 'wrong-type', path: '/required' })
  })

  it('non-empty required without properties errors for every name — never silently dropped', () => {
    // Round-2 review pin: `required` used to be walked only when a readable
    // `properties` existed, so this shape converted (wrongly) to a
    // validates-nothing `columns: []` contract.
    const { errors } = convertFailing({ title: 't', type: 'object', required: ['ghost'] })
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'unknown-key',
        path: '/required/0',
        message: expect.stringContaining('"ghost"'),
      }),
    ])
  })

  it('required without properties behaves exactly like properties: {} (no unrelated-key dependence)', () => {
    // Every entry is typed at its own pointer — unknown names once per
    // occurrence (duplicates included), non-string entries as wrong-type —
    // and the error list is byte-identical to the same array against
    // `properties: {}`.
    const without = { title: 't', type: 'object', required: ['a', 'ghost', 'a', 5] }
    const withEmpty = { ...without, properties: {} }
    expect(convertFailing(without).errors).toEqual(convertFailing(withEmpty).errors)
    expect(convertFailing(without).errors.map((error) => [error.code, error.path])).toEqual([
      ['unknown-key', '/required/0'],
      ['unknown-key', '/required/1'],
      ['unknown-key', '/required/2'],
      ['wrong-type', '/required/3'],
    ])
  })

  it('empty required without properties converts with columns: [] (nothing to lose)', () => {
    // An empty `required` carries no constraint, so there is nothing to
    // drop: it converts, exactly like the no-required empty schema.
    const { contract } = convertOk({ title: 't', type: 'object', required: [] })
    expect(contract).toEqual({
      format: 'v1',
      metadata: { name: 't', version: 1 },
      columns: [],
    })
    expect(serializeContract(contract)).toBe('format: v1\nname: t\nversion: 1\n')
  })

  it('required is walked even when properties is malformed (all independent errors collected)', () => {
    const { errors } = convertFailing({
      title: 't',
      type: 'object',
      properties: 5,
      required: ['ghost'],
    })
    expect(errors.map((error) => [error.code, error.path])).toEqual([
      ['wrong-type', '/properties'],
      ['unknown-key', '/required/0'],
    ])
  })
})

describe('metadata mapping', () => {
  it('title is required — absent, empty and non-string are typed errors', () => {
    const missing = convertFailing({ type: 'object', properties: {} })
    expect(missing.errors).toEqual([
      expect.objectContaining({ code: 'missing-key', path: '/title' }),
    ])
    const empty = convertFailing({ title: '', type: 'object', properties: {} })
    expect(empty.errors).toEqual([
      expect.objectContaining({ code: 'out-of-range', path: '/title' }),
    ])
    const nonString = convertFailing({ title: 5, type: 'object', properties: {} })
    expect(nonString.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/title' }),
    ])
  })

  it('$schema is accepted and ignored when a string; non-strings are reported', () => {
    const ok = convertOk({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 't',
      type: 'object',
      properties: {},
    })
    expect(ok.contract.metadata.name).toBe('t')
    expect(serializeContract(ok.contract)).not.toContain('json-schema.org')
    const bad = convertFailing({ $schema: 42, title: 't', type: 'object', properties: {} })
    expect(bad.errors).toEqual([expect.objectContaining({ code: 'wrong-type', path: '/$schema' })])
  })

  it('version is always 1 (JSON Schema has no contract-revision concept in the subset)', () => {
    expect(convertOk(objectSchema({})).contract.metadata.version).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Path scheme
// ---------------------------------------------------------------------------

describe('paths are RFC 6901 JSON Pointers with escaping', () => {
  it('escapes ~ and / in property names', () => {
    const { errors } = convertFailing(
      objectSchema({ 'a/b': { type: 'string', pattern: '(?=?' }, 'c~d': { type: 'array' } }),
    )
    expect(errors.map((error) => error.path)).toEqual([
      '/properties/a~1b/pattern',
      '/properties/c~0d/type',
    ])
  })
})

// ---------------------------------------------------------------------------
// Hostile totality probes
// ---------------------------------------------------------------------------

describe('totality: hostile inputs produce typed errors, never throws', () => {
  it('non-object inputs yield exactly one wrong-type error', () => {
    for (const input of [null, undefined, 42, 'schema', true, [], ['a'], () => 1]) {
      const { errors } = convertFailing(input)
      expect(errors, String(input)).toHaveLength(1)
      expect(errors[0]?.code, String(input)).toBe('wrong-type')
      expect(errors[0]?.path, String(input)).toBe('')
    }
  })

  it('prototype-spelling keys are honest unsupported-key reports, never inherited lookups', () => {
    // JSON.parse creates an *own* "__proto__" property — reported like any
    // other key outside the subset.
    const withProto = convertFailing(
      JSON.parse('{"title":"t","type":"object","properties":{},"__proto__":{"polluted":1}}'),
    )
    expect(withProto.errors).toEqual([
      expect.objectContaining({ code: 'unsupported-key', path: '/__proto__' }),
    ])
    // An own "toString" key (shadows the inherited method) likewise.
    const hostile: Record<string, unknown> = { title: 't', type: 'object', properties: {} }
    Object.defineProperty(hostile, 'toString', {
      enumerable: true,
      value: { not: 'a function' },
    })
    const withToString = convertFailing(hostile)
    expect(withToString.errors).toEqual([
      expect.objectContaining({ code: 'unsupported-key', path: '/toString' }),
    ])
  })

  it('hostile property NAMES become plain column names and round-trip', () => {
    const { contract } = convertOk(
      JSON.parse(
        '{"title":"t","type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"hasOwnProperty":{"type":"string"}}}',
      ),
    )
    expect(contract.columns.map((column) => column.name)).toEqual([
      '__proto__',
      'constructor',
      'hasOwnProperty',
    ])
    // The AST is built as plain data (no dynamic-key assignment), so these
    // names cannot have touched any prototype — and the m5-0 parse agrees.
    expect(parseContract(serializeContract(contract))).toEqual({ ok: true, contract })
  })

  it('throwing getters degrade to typed unreadable errors at the right paths', () => {
    const throwingGetter = (): unknown => {
      const target: Record<string, unknown> = {}
      Object.defineProperty(target, 'x', {
        enumerable: true,
        get() {
          throw new Error('boom')
        },
      })
      return target
    }
    // title getter
    const schema: Record<string, unknown> = { type: 'object', properties: {} }
    Object.defineProperty(schema, 'title', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    const titleResult = convertFailing(schema)
    expect(titleResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/title' }),
    ])
    // a property schema delivered by a getter that hands back a hostile object
    const parent: Record<string, unknown> = { title: 't', type: 'object' }
    Object.defineProperty(parent, 'properties', { enumerable: true, get: throwingGetter })
    const propertiesResult = convertFailing(parent)
    expect(propertiesResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/properties/x' }),
    ])
    // a property schema whose `type` value getter throws
    const nested: Record<string, unknown> = { title: 't', type: 'object', properties: {} }
    Object.defineProperty(nested, 'properties', {
      enumerable: true,
      value: { a: throwingGetter() },
    })
    // `a` is a plain object here; make its `type` throw instead
    const inner: Record<string, unknown> = {}
    Object.defineProperty(inner, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    nested.properties = { a: inner }
    const typeResult = convertFailing(nested)
    expect(typeResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/properties/a/type' }),
    ])
  })

  it('a proxy that refuses key enumeration degrades to a typed error', () => {
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no enumeration')
        },
      },
    )
    const rootResult = convertFailing(hostileProxy)
    expect(rootResult.errors).toEqual([expect.objectContaining({ code: 'wrong-type', path: '' })])
    const schema = { title: 't', type: 'object', properties: hostileProxy }
    const propertiesResult = convertFailing(schema)
    expect(propertiesResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/properties' }),
    ])
  })

  it('circular structures are safe (the walk never recurses into unsupported values)', () => {
    const property: Record<string, unknown> = { properties: null }
    property.properties = property // self-referencing value under an unsupported key
    const result = jsonSchemaToContract(objectSchema({ a: property }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toEqual(['/properties/a/properties'])
    }
  })

  it('a proxy over an array that throws on any read degrades to typed errors', () => {
    const hostileArrayProxy = new Proxy([] as unknown[], {
      get() {
        throw new Error('no reads')
      },
    })
    const enumResult = convertFailing(objectSchema({ a: { enum: hostileArrayProxy } }))
    expect(enumResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/properties/a/enum' }),
    ])
    const requiredResult = convertFailing(objectSchema({ a: {} }, { required: hostileArrayProxy }))
    expect(requiredResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/required' }),
    ])
  })

  it('boolean schemas are reported (wrong-type), not treated as constraints', () => {
    const { errors } = convertFailing(
      JSON.parse('{"title":"t","type":"object","properties":{"a":true}}'),
    )
    expect(errors).toEqual([expect.objectContaining({ code: 'wrong-type', path: '/properties/a' })])
  })
})

describe('adversarial hardening: prototype lookups, throwing index getters, ±0', () => {
  it('a ["__proto__"] type array hits no prototype member — plain unsupported-type', () => {
    const { errors } = convertFailing(objectSchema({ a: { type: ['__proto__'] } }))
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'unsupported-type',
        path: '/properties/a/type',
        message: expect.stringContaining('"__proto__"'),
      }),
    ])
    // The same for the constructor spelling (would also be inherited by a
    // plain-record index).
    const { errors: constructorErrors } = convertFailing(
      objectSchema({ a: { type: ['constructor'] } }),
    )
    expect(constructorErrors[0]?.code).toBe('unsupported-type')
  })

  it('throwing index getters on arrays degrade to typed errors', () => {
    const arrayWithThrowingGetter = (): unknown[] => {
      const array: unknown[] = []
      Object.defineProperty(array, 0, {
        enumerable: true,
        get() {
          throw new Error('boom')
        },
      })
      return array
    }
    // property type array
    const typeResult = convertFailing(objectSchema({ a: { type: arrayWithThrowingGetter() } }))
    expect(typeResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/properties/a/type' }),
    ])
    // enum element
    const enumArray: unknown[] = ['ok']
    Object.defineProperty(enumArray, 1, {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    const directEnumResult = convertFailing(objectSchema({ a: { enum: enumArray } }))
    expect(directEnumResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/properties/a/enum/1' }),
    ])
    // required element
    const requiredArray: unknown[] = []
    Object.defineProperty(requiredArray, 0, {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    const requiredResult = convertFailing(objectSchema({ a: {} }, { required: requiredArray }))
    expect(requiredResult.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '/required/0' }),
    ])
    // root type array
    const rootTypeResult = convertFailing({
      title: 't',
      type: arrayWithThrowingGetter(),
      properties: {},
    })
    expect(rootTypeResult.errors).toEqual([
      expect.objectContaining({ code: 'unsupported-type', path: '/type' }),
    ])
  })

  it('-0 normalizes to 0 (the m5-0 ±0-is-one-value rule; keeps the round trip exact)', () => {
    const { contract } = convertOk(objectSchema({ a: { enum: [-0], minimum: -0 } }))
    expect(contract.columns[0]?.allowedValues).toEqual([0])
    expect(contract.columns[0]?.min).toBe(0)
    expect(Object.is(contract.columns[0]?.min, -0)).toBe(false)
    expect(parseContract(serializeContract(contract))).toEqual({ ok: true, contract })
  })
})

// ---------------------------------------------------------------------------
// Seeded property suites
// ---------------------------------------------------------------------------

/** Property-name pool for generated schemas. */
const SCHEMA_COLUMN_POOL = ['id', 'email', 'country', 'age', 'score', 'flag', 'note', 'ratio']

/** RE2-subset-safe pattern pool (no rejected constructs, no quote-hostile characters). */
const SAFE_PATTERN_POOL = [
  '^[A-Z]{2}$',
  '^\\d{4}-\\d{2}-\\d{2}$',
  'user_[0-9]+',
  '@example\\.com$',
  '^(a|b)+c?',
  '[a-z-]+_[0-9]{1,3}',
  '(?i)^(abc|def)$',
  '(?:prefix)?[0-9]{2,4}',
  '(?P<code>[A-Z]\\d)',
]

const ENUM_STRINGS = ['US', 'GB', 'DE', 'FR', 'has space', 'ünï']
const ENUM_NUMBERS = [0, 1, 2, 100, -5, 0.25, 1.5]

/** Generate one in-subset property schema (rules drawn independently). */
function genProperty(rng: TestRng): Record<string, unknown> {
  const property: Record<string, unknown> = {}
  if (rng.bool(0.7)) {
    const spelling = rng.pick(['string', 'integer', 'number', 'boolean'] as const)
    property.type = rng.bool(0.8) ? spelling : [spelling]
  }
  if (rng.bool(0.4)) {
    const kind = rng.int(0, 3)
    const count = rng.int(0, 4)
    const values: unknown[] = []
    for (let i = 0; i < count; i++) {
      if (kind === 0) values.push(rng.pick(ENUM_STRINGS))
      else if (kind === 1) values.push(rng.pick(ENUM_NUMBERS))
      else if (kind === 2) values.push(rng.bool())
      else values.push(rng.pick([...ENUM_STRINGS, ...ENUM_NUMBERS, true, false])) // mixed kinds
    }
    property.enum = values
  }
  if (rng.bool(0.5)) {
    const minimum = rng.int(-1000, 1000)
    property.minimum = minimum
    if (rng.bool(0.7)) property.maximum = minimum + rng.int(0, 5000) // min ≤ max guaranteed
  } else if (rng.bool(0.3)) {
    property.maximum = rng.int(-1000, 1000)
  }
  if (rng.bool(0.4)) property.pattern = rng.pick(SAFE_PATTERN_POOL)
  return property
}

/** Generate one in-subset object-rooted schema. */
function genSchema(rng: TestRng): Record<string, unknown> {
  const names = rng.shuffle(SCHEMA_COLUMN_POOL).slice(0, rng.int(1, SCHEMA_COLUMN_POOL.length))
  const properties: Record<string, unknown> = {}
  for (const name of names) properties[name] = genProperty(rng)
  const schema: Record<string, unknown> = {
    title: `schema-${rng.int(0, 99)}`,
    type: rng.bool(0.8) ? 'object' : ['object'],
    properties,
  }
  if (rng.bool(0.5)) schema.$schema = 'https://json-schema.org/draft/2020-12/schema'
  if (rng.bool(0.4)) schema.description = `Generated schema ${rng.int(0, 99)}`
  if (rng.bool(0.7)) {
    schema.required = rng.shuffle(names).slice(0, rng.int(1, names.length))
  }
  return schema
}

describe('property: conversions always round-trip through the m5-0 parser', () => {
  const SEED_ROUND_TRIP = 20260924
  const ROUND_TRIP_CASES = 400

  it(`converts and round-trips ${ROUND_TRIP_CASES} generated in-subset schemas (seed ${SEED_ROUND_TRIP})`, () => {
    const rng = makeTestRng(SEED_ROUND_TRIP)
    let columnsObserved = 0
    for (let i = 0; i < ROUND_TRIP_CASES; i++) {
      const schema = genSchema(rng)
      const result = jsonSchemaToContract(schema)
      // The generator stays inside the documented subset: every case converts.
      expect(result).toEqual({ ok: true, contract: (result as { contract: ContractV1 }).contract })
      if (!result.ok) return
      expect(result.contract.metadata.version).toBe(1)
      columnsObserved += result.contract.columns.length
      // The done-when: adapter output ALWAYS parses as a valid m5-0
      // contract — and the round trip is exact (the re-parsed AST equals
      // the produced one, so the adapter emits the normalized shape).
      const text = serializeContract(result.contract)
      expect(parseContract(text)).toEqual({ ok: true, contract: result.contract })
      expect(
        serializeContract((parseContract(text) as { ok: true; contract: ContractV1 }).contract),
      ).toBe(text)
    }
    // Non-vacuity: the corpus is not empty of real conversions.
    expect(columnsObserved).toBeGreaterThan(ROUND_TRIP_CASES)
  })
})

// ---------------------------------------------------------------------------
// Seeded property suite — the round-2 escape vector: `required` without a
// `properties` key. The in-subset generator above must stay convertible, so
// it can never emit these shapes; this dedicated suite generates them (new
// seed, existing suites' seeds untouched) and pins the failure shape: every
// entry typed at its own pointer, duplicates per occurrence, and the empty
// array converting with columns: [] and an exact round trip.
// ---------------------------------------------------------------------------

describe('property: required without properties is typed per entry, never dropped', () => {
  const SEED_REQUIRED_WITHOUT_PROPERTIES = 20260920
  const REQUIRED_WITHOUT_PROPERTIES_CASES = 400

  it(`keeps every entry typed across ${REQUIRED_WITHOUT_PROPERTIES_CASES} generated required-without-properties schemas (seed ${SEED_REQUIRED_WITHOUT_PROPERTIES})`, () => {
    const rng = makeTestRng(SEED_REQUIRED_WITHOUT_PROPERTIES)
    let unknownKeyErrors = 0
    let emptyRequiredConversions = 0
    for (let i = 0; i < REQUIRED_WITHOUT_PROPERTIES_CASES; i++) {
      // No `properties` key — the exact shape the review called out. The
      // doubled pool makes duplicate names occur; each occurrence must get
      // its own typed error.
      const required = rng
        .shuffle([...SCHEMA_COLUMN_POOL, ...SCHEMA_COLUMN_POOL])
        .slice(0, rng.int(0, SCHEMA_COLUMN_POOL.length))
      const schema: Record<string, unknown> = {
        title: `req-only-${rng.int(0, 99)}`,
        type: rng.bool(0.8) ? 'object' : ['object'],
        required,
      }
      const result = jsonSchemaToContract(schema)
      if (required.length === 0) {
        // An empty `required` carries no constraint — it converts, with
        // `columns: []`, and (as always) the result round-trips exactly.
        expect(result, JSON.stringify(schema)).toEqual({
          ok: true,
          contract: {
            format: 'v1',
            metadata: { name: schema.title, version: 1 },
            columns: [],
          },
        })
        if (!result.ok) return // narrowed for TS; toEqual above already failed otherwise
        emptyRequiredConversions++
        const text = serializeContract(result.contract)
        expect(parseContract(text)).toEqual({ ok: true, contract: result.contract })
      } else {
        expect(result.ok, JSON.stringify(schema)).toBe(false)
        if (result.ok) return // narrowed for TS
        expect(result.errors, JSON.stringify(schema)).toHaveLength(required.length)
        result.errors.forEach((error, index) => {
          expect(error.code, JSON.stringify(schema)).toBe('unknown-key')
          expect(error.path, JSON.stringify(schema)).toBe(`/required/${index}`)
          expect(error.message, JSON.stringify(schema)).toContain(JSON.stringify(required[index]))
          unknownKeyErrors++
        })
      }
    }
    // Non-vacuity: both arms of the generator are exercised.
    expect(unknownKeyErrors).toBeGreaterThan(0)
    expect(emptyRequiredConversions).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Hostile fuzz: totality + the round-trip property over hostile inputs
// ---------------------------------------------------------------------------

/** Values a hostile caller might inject (getter objects, prototypes, weird scalars). */
function hostileValues(): readonly unknown[] {
  const throwing: Record<string, unknown> = {}
  Object.defineProperty(throwing, 'x', {
    enumerable: true,
    get() {
      throw new Error('boom')
    },
  })
  const circular: Record<string, unknown> = {}
  circular.self = circular
  return [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2 ** 53,
    -0,
    5e-324,
    Number.MAX_VALUE,
    null,
    undefined,
    true,
    false,
    0,
    '',
    'x',
    [],
    [1, 2],
    () => 1,
    Symbol('x'),
    new Date(0),
    /x/,
    Object.create(null),
    new Proxy({}, {}),
    throwing,
    circular,
    JSON.parse('{"__proto__": {"polluted": 1}}'),
    { toString: 42, valueOf: 7 },
  ]
}

/** Apply one hostile mutation to a generated schema (or replace it). */
function mutateSchema(rng: TestRng, base: Record<string, unknown>): unknown {
  const pool = hostileValues()
  const properties = base.properties as Record<string, unknown>
  const names = Object.keys(properties)
  switch (rng.int(0, 8)) {
    case 0:
      return rng.pick(pool) // replace the whole input
    case 1: {
      const copy: Record<string, unknown> = { ...base }
      copy[rng.pick(Object.keys(base))] = rng.pick(pool)
      return copy
    }
    case 2: {
      const hostile: Record<string, unknown> = { ...base }
      Object.defineProperty(hostile, 'injected', {
        enumerable: true,
        value: rng.pick(pool),
      })
      return hostile
    }
    case 3: {
      const copy: Record<string, unknown> = { ...base }
      Object.defineProperty(copy, '__proto__', {
        enumerable: true,
        value: rng.pick(pool),
      })
      return copy
    }
    case 4:
      properties[rng.pick(names)] = rng.pick(pool)
      return base
    case 5: {
      const name = rng.pick(names)
      const property = properties[name]
      if (
        typeof property === 'object' &&
        property !== null &&
        !Array.isArray(property) &&
        !Object.isFrozen(property)
      ) {
        ;(property as Record<string, unknown>)[
          rng.pick(['type', 'enum', 'minimum', 'maximum', 'pattern', 'format'])
        ] = rng.pick(pool)
      }
      return base
    }
    case 6: {
      const name = rng.pick(names)
      const property = properties[name]
      if (
        typeof property === 'object' &&
        property !== null &&
        !Array.isArray(property) &&
        !Object.isFrozen(property) &&
        Array.isArray((property as Record<string, unknown>).enum)
      ) {
        ;(property as Record<string, unknown>).enum = [
          ...((property as Record<string, unknown>).enum as unknown[]),
          rng.pick(pool),
        ]
      }
      return base
    }
    case 7: {
      const copy: Record<string, unknown> = { ...base }
      copy.required = rng.pick(pool)
      return copy
    }
    default: {
      const copy: Record<string, unknown> = { ...base }
      copy.required = [
        ...(Array.isArray(base.required) ? (base.required as string[]) : []),
        rng.pick(names),
      ] // likely duplicate
      return copy
    }
  }
}

describe('property: the adapter never throws on hostile input; ok output always round-trips', () => {
  const SEED_HOSTILE = 20260925
  const HOSTILE_CASES = 2000

  it(`survives ${HOSTILE_CASES} hostile mutations (seed ${SEED_HOSTILE}); every ok result round-trips exactly`, () => {
    const rng = makeTestRng(SEED_HOSTILE)
    let okCount = 0
    let errorCount = 0
    for (let i = 0; i < HOSTILE_CASES; i++) {
      const input = mutateSchema(rng, genSchema(rng))
      let result: JsonSchemaAdapterResult | undefined
      expect(() => {
        result = jsonSchemaToContract(input)
      }).not.toThrow()
      if (result === undefined) throw new Error('unreachable: jsonSchemaToContract always returns')
      if (result.ok) {
        okCount++
        // Even on hostile input, a produced contract is a valid m5-0
        // contract, and the round trip is exact (the internal-invariant
        // shield makes this hold by construction; pinned here by sampling
        // the whole hostile corpus).
        const text = serializeContract(result.contract)
        expect(parseContract(text)).toEqual({ ok: true, contract: result.contract })
      } else {
        errorCount++
        for (const error of result.errors) {
          expect(typeof error.code).toBe('string')
          expect(typeof error.path).toBe('string')
          expect(typeof error.message).toBe('string')
        }
      }
    }
    // Non-vacuity: the corpus exercises both outcomes.
    expect(okCount).toBeGreaterThan(0)
    expect(errorCount).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Error rendering sanity (describeContractError is YAML-side; adapter errors
// render from their own fields — the pin keeps the shape honest)
// ---------------------------------------------------------------------------

describe('adapter errors are plain renderable data', () => {
  it('errors carry code, message and pointer path — no line/column by design', () => {
    const { errors } = convertFailing({
      title: 't',
      type: 'object',
      properties: { a: { type: 'string', if: {} } },
    })
    for (const error of errors) {
      expect(Object.keys(error).sort()).toEqual(['code', 'message', 'path'])
      // The pointer lives in the dedicated path field (no line/column — the
      // input is a parsed value, not text).
      expect(error.path).toBe('/properties/a/if')
    }
  })
})
