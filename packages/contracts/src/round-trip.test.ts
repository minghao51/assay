import { describe, expect, it } from 'vitest'
import type { ContractV1 } from './ast'
import { parseContract } from './parse'
import { serializeContract } from './serialize'
import { genContract, makeTestRng, mutateYaml, renderMessyYaml } from './property-testing'

/**
 * Seeded property suites (m5-0), mirroring `@assay/domain`'s conventions:
 * mulberry32 PRNG, fixed seeds committed in this file, no `Math.random`.
 *
 * - **Round-trip**: parse(serialize(ast)) is the identity on generated ASTs.
 * - **Canonical stability**: two equivalent YAML sources — the canonical
 *   form and a test-side *messy* rendering (shuffled key order, mixed
 *   quoting/flow styles, comments, random indentation) — parse to the same
 *   AST and serialize to the same bytes; serialization is a fixpoint.
 * - **Totality under fuzzing**: mutated documents never throw; whatever
 *   still parses satisfies the canonical fixpoint.
 *
 * Seeds are date-of-work-derived constants. A failure reproduces by
 * re-running with the printed seed.
 */

const SEED_ROUND_TRIP = 20260919
const SEED_MESSY = 20260918
const SEED_FUZZ = 20260917
const ROUND_TRIP_CASES = 400
const MESSY_CASES = 400
const FUZZ_CASES = 2500

describe('property: parse ∘ serialize is the identity on valid contracts', () => {
  it(`round-trips ${ROUND_TRIP_CASES} generated contracts (seed ${SEED_ROUND_TRIP})`, () => {
    const rng = makeTestRng(SEED_ROUND_TRIP)
    for (let i = 0; i < ROUND_TRIP_CASES; i++) {
      const contract = genContract(rng)
      const text = serializeContract(contract)
      const result = parseContract(text)
      // The generated corpus is always valid, and round-trips exactly.
      expect(result).toEqual({ ok: true, contract })
      if (!result.ok) return
      expect(serializeContract(result.contract)).toBe(text)
    }
  })
})

describe('property: canonical stability regardless of source key order / whitespace', () => {
  it(`messy renderings of ${MESSY_CASES} generated contracts parse identically and canonicalize to the same bytes (seed ${SEED_MESSY})`, () => {
    const rng = makeTestRng(SEED_MESSY)
    for (let i = 0; i < MESSY_CASES; i++) {
      const contract = genContract(rng)
      const canonical = serializeContract(contract)
      const messy = renderMessyYaml(rng, contract)
      const parsed = parseContract(messy)
      expect(parsed).toEqual({ ok: true, contract })
      if (!parsed.ok) return
      // Canonical output depends on the AST only — never on the source text.
      expect(serializeContract(parsed.contract)).toBe(canonical)
    }
  })

  it('messy renderings of one contract are all valid and all canonicalize identically', () => {
    const rng = makeTestRng(SEED_MESSY + 1)
    const contract: ContractV1 = genContract(rng)
    const canonical = serializeContract(contract)
    for (let variant = 0; variant < 25; variant++) {
      const messy = renderMessyYaml(makeTestRng(SEED_MESSY + 100 + variant), contract)
      const parsed = parseContract(messy)
      expect(parsed).toEqual({ ok: true, contract })
      if (!parsed.ok) return
      expect(serializeContract(parsed.contract)).toBe(canonical)
    }
  })
})

describe('property: parseContract is total under fuzzing', () => {
  it(`never throws across ${FUZZ_CASES} mutated documents; survivors satisfy the canonical fixpoint (seed ${SEED_FUZZ})`, () => {
    const rng = makeTestRng(SEED_FUZZ)
    let parsedCount = 0
    for (let i = 0; i < FUZZ_CASES; i++) {
      const base = serializeContract(genContract(rng))
      const mutated = mutateYaml(rng, base)
      let result: ReturnType<typeof parseContract> | undefined
      expect(() => {
        result = parseContract(mutated)
      }).not.toThrow()
      if (result === undefined) throw new Error('unreachable: parseContract always returns')
      if (!result.ok) continue
      parsedCount++
      // A mutated document that still parses must re-serialize stably.
      const once = serializeContract(result.contract)
      const reparsed = parseContract(once)
      expect(reparsed).toEqual({ ok: true, contract: result.contract })
      expect(serializeContract(reparsed.ok ? reparsed.contract : (undefined as never))).toBe(once)
    }
    // Sanity: the mutations are not all fatal — the corpus actually covers
    // both outcomes, so the fixpoint assertions above are not vacuous.
    // The historical 10% floor holds on the committed seed: the measured
    // rate is 253/2500 = 10.12% survivors with zero imprecise-number
    // errors — the generator's number pools are short decimals, so text
    // mutations essentially never produce a 17-significant-digit literal
    // for the exactness gate to reject (that gate is covered by the
    // dedicated pins in `parse.test.ts`, not by this corpus).
    expect(parsedCount).toBeGreaterThan(FUZZ_CASES / 10)
  })
})
