// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseDcr } from './dcr-parse.js'
import { serializeDcr } from './dcr-serialize.js'
import { genDcr, makeTestRng, renderAlternateDcr } from './dcr-property-testing.js'
import { mutateYaml } from './property-testing.js'

/**
 * Seeded property suites for the DCR artifact (p3-1), mirroring the p-1
 * pipeline suites: mulberry32 PRNG, fixed seeds committed in this file, no
 * `Math.random`.
 *
 * - **Round-trip**: parse(serialize(ast)) is the identity on generated
 *   artifacts (one AST → one exact text → the same AST).
 * - **Canonical stability**: an alternate rendering (JSON — a YAML 1.2
 *   subset, with shuffled key order and different whitespace) parses to the
 *   same AST and serializes to the same bytes; serialization is a fixpoint.
 * - **Totality under fuzzing**: mutated documents never throw; whatever
 *   still parses satisfies the canonical fixpoint.
 *
 * Seeds are date-of-work-derived constants. A failure reproduces by re-running
 * with the printed seed.
 */

const SEED_ROUND_TRIP = 20261003
const SEED_ALTERNATE = 20261004
const SEED_FUZZ = 20261005
const ROUND_TRIP_CASES = 400
const ALTERNATE_CASES = 400
const FUZZ_CASES = 2500

describe('property: parseDcr ∘ serializeDcr is the identity on valid DCR artifacts', () => {
  it(`round-trips ${ROUND_TRIP_CASES} generated artifacts (seed ${SEED_ROUND_TRIP})`, () => {
    const rng = makeTestRng(SEED_ROUND_TRIP)
    for (let i = 0; i < ROUND_TRIP_CASES; i++) {
      const artifact = genDcr(rng)
      const text = serializeDcr(artifact)
      const result = parseDcr(text)
      expect(result).toEqual({ ok: true, artifact })
      if (!result.ok) return
      expect(serializeDcr(result.artifact)).toBe(text)
    }
  })
})

describe('property: canonical bytes depend on the AST only, never on the source form', () => {
  it(`alternate renderings of ${ALTERNATE_CASES} generated artifacts parse identically and canonicalize to the same bytes (seed ${SEED_ALTERNATE})`, () => {
    const rng = makeTestRng(SEED_ALTERNATE)
    for (let i = 0; i < ALTERNATE_CASES; i++) {
      const artifact = genDcr(rng)
      const canonical = serializeDcr(artifact)
      const alternate = renderAlternateDcr(rng, artifact)
      const parsed = parseDcr(alternate)
      expect(parsed).toEqual({ ok: true, artifact })
      if (!parsed.ok) return
      // Canonical output depends on the AST only — never on the source bytes.
      expect(serializeDcr(parsed.artifact)).toBe(canonical)
    }
  })
})

describe('property: parseDcr is total under fuzzing', () => {
  it(`never throws across ${FUZZ_CASES} mutated documents; survivors satisfy the canonical fixpoint (seed ${SEED_FUZZ})`, () => {
    const rng = makeTestRng(SEED_FUZZ)
    let parsedCount = 0
    for (let i = 0; i < FUZZ_CASES; i++) {
      const base = serializeDcr(genDcr(rng))
      const mutated = mutateYaml(rng, base)
      let result: ReturnType<typeof parseDcr> | undefined
      expect(() => {
        result = parseDcr(mutated)
      }).not.toThrow()
      if (result === undefined) throw new Error('unreachable: parseDcr always returns')
      if (!result.ok) continue
      parsedCount++
      const once = serializeDcr(result.artifact)
      const reparsed = parseDcr(once)
      expect(reparsed).toEqual({ ok: true, artifact: result.artifact })
      expect(serializeDcr(reparsed.ok ? reparsed.artifact : result.artifact)).toBe(once)
    }
    // Sanity: the mutations are not all fatal, so the fixpoint assertions
    // above are not vacuous. The DCR grammar is denser than the IR's (every
    // section is strictly typed), so mutations are fatal more often:
    // measured 69/2500 survivors on the committed seed.
    expect(parsedCount).toBeGreaterThan(FUZZ_CASES / 50)
  }, 20_000)
})
