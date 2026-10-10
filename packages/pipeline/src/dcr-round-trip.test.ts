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
 * - **Bounding disclosure (p3-1b, D19-OQ-4)**: the optional
 *   bounded-flag keys appear in the canonical bytes exactly when the AST
 *   carries them — absence is meaning, both directions.
 *
 * Seeds are date-of-work-derived constants. A failure reproduces by re-running
 * with the printed seed.
 */

const SEED_ROUND_TRIP = 20261003
const SEED_ALTERNATE = 20261004
const SEED_FUZZ = 20261005
const SEED_DISCLOSURE = 20261011
const ROUND_TRIP_CASES = 400
const ALTERNATE_CASES = 400
const FUZZ_CASES = 2500
const DISCLOSURE_CASES = 400

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

describe('property: the D19-OQ-4 bounding disclosure is present exactly when the aspect was bounded (p3-1b)', () => {
  it(`flags in the AST ⟺ keys in the canonical bytes, over ${DISCLOSURE_CASES} generated artifacts (seed ${SEED_DISCLOSURE})`, () => {
    const rng = makeTestRng(SEED_DISCLOSURE)
    let flaggedKeys = 0
    for (let i = 0; i < DISCLOSURE_CASES; i++) {
      const artifact = genDcr(rng)
      const text = serializeDcr(artifact)
      // The key names are unique in the grammar, so raw occurrence counts
      // are exact: presence in the bytes ⟺ the flag on some categorical
      // delta — and the count matches how many deltas carry each flag.
      const newInBytes = (text.match(/newCategoriesBounded/g) ?? []).length
      const vanishedInBytes = (text.match(/vanishedCategoriesBounded/g) ?? []).length
      let newInAst = 0
      let vanishedInAst = 0
      for (const delta of artifact.deltas.columnDeltas ?? []) {
        if (delta.categorical?.newCategoriesBounded === true) newInAst++
        if (delta.categorical?.vanishedCategoriesBounded === true) vanishedInAst++
      }
      expect(newInBytes).toBe(newInAst)
      expect(vanishedInBytes).toBe(vanishedInAst)
      flaggedKeys += newInAst + vanishedInAst
    }
    // Sanity: the generator exercises the flagged state, so the ⟺ pin is
    // not vacuous (measured 40 on the committed seed).
    expect(flaggedKeys).toBeGreaterThan(0)
  })

  it('byte-stability holds for flagged artifacts: two serializations are identical and re-parse to the same AST', () => {
    const rng = makeTestRng(SEED_DISCLOSURE + 1)
    let flaggedArtifacts = 0
    for (let i = 0; i < DISCLOSURE_CASES; i++) {
      const artifact = genDcr(rng)
      const hasFlags = (artifact.deltas.columnDeltas ?? []).some(
        (delta) =>
          delta.categorical?.newCategoriesBounded === true ||
          delta.categorical?.vanishedCategoriesBounded === true,
      )
      if (!hasFlags) continue
      flaggedArtifacts++
      const once = serializeDcr(artifact)
      const twice = serializeDcr(artifact)
      expect(twice).toBe(once)
      const reparsed = parseDcr(once)
      expect(reparsed).toEqual({ ok: true, artifact })
      if (!reparsed.ok) return
      expect(serializeDcr(reparsed.artifact)).toBe(once)
    }
    expect(flaggedArtifacts).toBeGreaterThan(0)
  })
})
