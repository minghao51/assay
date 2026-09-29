// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parsePipeline } from './parse.js'
import { serializePipeline } from './serialize.js'
import { genPipeline, makeTestRng, mutateYaml, renderAlternateYaml } from './property-testing.js'

/**
 * Seeded property suites (p-1), mirroring `@assay/domain`/`@assay/contracts`:
 * mulberry32 PRNG, fixed seeds committed in this file, no `Math.random`.
 *
 * - **Round-trip**: parse(serialize(ast)) is the identity on generated ASTs.
 * - **Canonical stability**: an alternate rendering (JSON — a YAML 1.2
 *   subset, with shuffled node/key order and different whitespace) parses to
 *   the same AST and serializes to the same bytes; serialization is a
 *   fixpoint.
 * - **Totality under fuzzing**: mutated documents never throw; whatever still
 *   parses satisfies the canonical fixpoint.
 *
 * Seeds are date-of-work-derived constants. A failure reproduces by re-running
 * with the printed seed.
 */

const SEED_ROUND_TRIP = 20260930
const SEED_ALTERNATE = 20261001
const SEED_FUZZ = 20261002
const ROUND_TRIP_CASES = 400
const ALTERNATE_CASES = 400
const FUZZ_CASES = 2500

describe('property: parse ∘ serialize is the identity on valid pipelines', () => {
  it(`round-trips ${ROUND_TRIP_CASES} generated pipelines (seed ${SEED_ROUND_TRIP})`, () => {
    const rng = makeTestRng(SEED_ROUND_TRIP)
    for (let i = 0; i < ROUND_TRIP_CASES; i++) {
      const pipeline = genPipeline(rng)
      const text = serializePipeline(pipeline)
      const result = parsePipeline(text)
      expect(result).toEqual({ ok: true, pipeline })
      if (!result.ok) return
      expect(serializePipeline(result.pipeline)).toBe(text)
    }
  })
})

describe('property: canonical stability regardless of node/key order and whitespace', () => {
  it(`alternate renderings of ${ALTERNATE_CASES} generated pipelines parse identically and canonicalize to the same bytes (seed ${SEED_ALTERNATE})`, () => {
    const rng = makeTestRng(SEED_ALTERNATE)
    for (let i = 0; i < ALTERNATE_CASES; i++) {
      const pipeline = genPipeline(rng)
      const canonical = serializePipeline(pipeline)
      const alternate = renderAlternateYaml(rng, pipeline)
      const parsed = parsePipeline(alternate)
      expect(parsed).toEqual({ ok: true, pipeline })
      if (!parsed.ok) return
      // Canonical output depends on the AST only — never on the source bytes.
      expect(serializePipeline(parsed.pipeline)).toBe(canonical)
    }
  })
})

describe('property: parsePipeline is total under fuzzing', () => {
  it(`never throws across ${FUZZ_CASES} mutated documents; survivors satisfy the canonical fixpoint (seed ${SEED_FUZZ})`, () => {
    const rng = makeTestRng(SEED_FUZZ)
    let parsedCount = 0
    for (let i = 0; i < FUZZ_CASES; i++) {
      const base = serializePipeline(genPipeline(rng))
      const mutated = mutateYaml(rng, base)
      let result: ReturnType<typeof parsePipeline> | undefined
      expect(() => {
        result = parsePipeline(mutated)
      }).not.toThrow()
      if (result === undefined) throw new Error('unreachable: parsePipeline always returns')
      if (!result.ok) continue
      parsedCount++
      const once = serializePipeline(result.pipeline)
      const reparsed = parsePipeline(once)
      expect(reparsed).toEqual({ ok: true, pipeline: result.pipeline })
      expect(serializePipeline(reparsed.ok ? reparsed.pipeline : result.pipeline)).toBe(once)
    }
    // Sanity: the mutations are not all fatal, so the fixpoint assertions
    // above are not vacuous. Measured on the committed seed (220/2500).
    expect(parsedCount).toBeGreaterThan(FUZZ_CASES / 20)
  }, 20_000)
})
