import { describe, expect, it } from 'vitest'
import { compileContract } from './compile'
import type { BindingError } from './errors'
import { checkRe2Pattern } from './re2'
import { genContract, genOptions, genSchema, makeTestRng } from './property-testing'
import type { ContractV1 } from '@assay/contracts'

/**
 * Seeded property suites (m5-1). Repo convention: mulberry32, fixed seeds
 * (never `Math.random`), so a failing case reproduces exactly. The
 * generators produce *validated-shaped* inputs — normalized m5-0 contracts
 * and engine-shaped schemas (incl. unclassifiable spellings) — because the
 * property under test is totality over the compiler's real input domain:
 * every (contract, schema, options) yields a plan or typed binding errors,
 * never a throw.
 */

const TOTALITY_SEEDS = [20260920, 20260921, 20260922]
const CASES_PER_SEED = 250

/** One generated (contract, schema, options) draw. */
function draw(
  seed: number,
  index: number,
): {
  contract: ContractV1
  schema: { name: string; type: string }[]
  options: { relation: string; sampleLimit?: number }
} {
  const rng = makeTestRng(seed + index)
  return { contract: genContract(rng), schema: genSchema(rng), options: genOptions(rng) }
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'missing-column',
  'unknown-column-type',
  'rule-not-applicable',
  'invalid-regex',
  'invalid-schema-input',
  'invalid-options',
  'invalid-contract-input',
])

describe('property — totality over validated inputs (seeded)', () => {
  it('generated (contract, schema, options) always yields a plan or typed errors — 3×250 cases', () => {
    let plans = 0
    let rejected = 0
    for (const seed of TOTALITY_SEEDS) {
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const { contract, schema, options } = draw(seed, i)
        let result: ReturnType<typeof compileContract> | undefined
        expect(() => {
          result = compileContract(contract, schema, options)
        }).not.toThrow()
        if (result === undefined) throw new Error('unreachable: compileContract returned nothing')
        if (result.ok) {
          plans += 1
          const { plan } = result
          // plan well-formedness: unique ruleIds, one summary arm per rule,
          // every arm keyed by its rule, JSON-representable payload.
          const ids = plan.rules.map((rule) => rule.ruleId)
          expect(new Set(ids).size).toBe(ids.length)
          if (plan.rules.length > 0) {
            const arms = plan.summarySql.split('\nUNION ALL\n')
            expect(arms).toHaveLength(plan.rules.length)
            for (const rule of plan.rules) {
              expect(plan.summarySql).toContain(`'${rule.ruleId}'`)
            }
          } else {
            expect(plan.summarySql).toContain('WHERE FALSE')
          }
          expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
          // an accepted regex rule was checked RE2-valid (binding honesty)
          for (const column of contract.columns) {
            if (column.regex !== undefined) {
              expect(checkRe2Pattern(column.regex).valid).toBe(true)
            }
          }
        } else {
          rejected += 1
          for (const error of result.errors) {
            expect(typeof error.message).toBe('string')
            expect(error.message.length).toBeGreaterThan(0)
            expect(error.path.length).toBeGreaterThan(0)
            expect(KNOWN_CODES.has(error.code)).toBe(true)
          }
        }
      }
    }
    // non-vacuity: both outcomes occur across the pool (the generator hits
    // applicable and inapplicable combinations alike).
    expect(plans).toBeGreaterThan(0)
    expect(rejected).toBeGreaterThan(0)
  })

  it('compile∘recompile and schema-reorder determinism — byte-identical plans (pinned seeds)', () => {
    for (const seed of TOTALITY_SEEDS) {
      for (let i = 0; i < CASES_PER_SEED; i += 10) {
        const { contract, schema, options } = draw(seed, i)
        const first = compileContract(contract, schema, options)
        const second = compileContract(contract, schema, options)
        expect(JSON.stringify(second)).toBe(JSON.stringify(first))
        // Accepted plans never depend on the schema array's order (rule order
        // is the contract's canonical order; the schema is lookup-only).
        // Rejected schema inputs are compared only on recompile: error paths
        // are positional by contract — the schema array is ordered caller
        // input (engine DESCRIBE order), so a duplicate entry's error path
        // legitimately tracks its position.
        if (first.ok) {
          const reordered = compileContract(contract, [...schema].reverse(), options)
          expect(JSON.stringify(reordered)).toBe(JSON.stringify(first))
        }
      }
    }
  })

  it('a compiled plan never depends on the schema array it did not use (contract-order canonicality)', () => {
    // two schemas with identical entries in different orders, plus the
    // identical extra column appended at different positions
    const { contract, schema, options } = draw(20260920, 3)
    const a = [...schema, { name: 'extra', type: 'DOUBLE' }]
    const b = [{ name: 'extra', type: 'DOUBLE' }, ...schema]
    const pa = compileContract(contract, a, options)
    const pb = compileContract(contract, b, options)
    expect(JSON.stringify(pa)).toBe(JSON.stringify(pb))
  })
})

describe('property — totality over malformed inputs (caller-bug surface)', () => {
  /** Fixed structural mutations applied to generated contracts. */
  const MUTATIONS: readonly {
    readonly label: string
    readonly apply: (contract: ContractV1) => unknown
  }[] = [
    { label: 'regex: number', apply: (c) => ({ ...c, columns: [{ ...c.columns[0], regex: 42 }] }) },
    { label: 'min: string', apply: (c) => ({ ...c, columns: [{ ...c.columns[0], min: 'x' }] }) },
    {
      label: 'allowedValues: scalar',
      apply: (c) => ({ ...c, columns: [{ ...c.columns[0], allowedValues: 'nope' }] }),
    },
    {
      label: 'allowedValues: object entry',
      apply: (c) => ({ ...c, columns: [{ ...c.columns[0], allowedValues: [{ deep: true }] }] }),
    },
    {
      label: 'required: false',
      apply: (c) => ({ ...c, columns: [{ ...c.columns[0], required: false }] }),
    },
    { label: 'columns: not array', apply: (c) => ({ ...c, columns: 'nope' }) },
    { label: 'metadata: null', apply: (c) => ({ ...c, metadata: null }) },
    { label: 'format: v9', apply: (c) => ({ ...c, format: 'v9' }) },
    { label: 'columns: null entry', apply: (c) => ({ ...c, columns: [null] }) },
    {
      label: 'regex: NUL pattern',
      apply: (c) => ({ ...c, columns: [{ ...c.columns[0], regex: 'a\u0000b' }] }),
    },
  ]

  it('mutated contracts degrade to typed errors or plans — never a throw', () => {
    const rng = makeTestRng(20260923)
    for (const mutation of MUTATIONS) {
      for (let i = 0; i < 20; i++) {
        const { schema, options } = { schema: genSchema(rng), options: genOptions(rng) }
        const contract = genContract(rng)
        const candidate = mutation.apply(contract)
        let result: ReturnType<typeof compileContract> | undefined
        expect(() => {
          // the mutation surface is behind the type system by construction
          result = compileContract(candidate as ContractV1, schema, options)
        }).not.toThrow()
        if (result === undefined) throw new Error('unreachable')
        if (!result.ok) {
          for (const error of result.errors as readonly BindingError[]) {
            expect(KNOWN_CODES.has(error.code)).toBe(true)
          }
        }
      }
    }
  })

  it('schema garbage degrades to typed errors — never a throw', () => {
    const garbage: readonly unknown[] = [
      null,
      'nope',
      [null],
      [{ name: 'x' }],
      [{ type: 'BIGINT' }],
      [{ name: '', type: 'BIGINT' }],
      [
        { name: 'x', type: 'BIGINT' },
        { name: 'x', type: 'VARCHAR' },
      ],
      [{ name: 'x', type: 'BIGINT' }, 'y'],
    ]
    for (const schema of garbage) {
      expect(() =>
        compileContract(
          {
            format: 'v1',
            metadata: { name: 'c', version: 1 },
            columns: [{ name: 'x', required: true }],
          },
          schema as { name: string; type: string }[],
          { relation: 't1' },
        ),
      ).not.toThrow()
    }
  })
})
