import { describe, expect, it } from 'vitest'
import { binIndex } from './bins'
import type { CategoricalTopKEntry } from './profile'
import { jensenShannon, newCategories, psi, totalVariation, vanishedCategories } from './divergence'
import { diffDatasets, hasSchemaOrProfileDifferences } from './report'
import type { DiffInput } from './report'
import {
  genCountVectors,
  genHostileProfile,
  genHostileSchema,
  genSchemaPair,
  genTopKPair,
  genValidProfile,
  genValidSchema,
  makeTestRng,
} from './diff-property-testing'

/**
 * Seeded property suites (m6-0). Repo convention: mulberry32, fixed seeds
 * (never `Math.random`), so a failing case reproduces exactly. Non-vacuity
 * is pinned everywhere (the m5-5 lesson: a suite that never generates the
 * interesting shape proves nothing).
 */

const TOTALITY_SEEDS = [20261001, 20261002, 20261003]
const CASES_PER_SEED = 250

/** Codes the model may emit — anything else is a bug (mirrors m5-1's sweep). */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  'invalid-input',
  'invalid-schema-input',
  'invalid-profile-input',
  'invalid-column-profile',
  'duplicate-column-name',
])

/** Recursively assert every number in the report is finite and never -0. */
function assertJsonStable(node: unknown): void {
  if (typeof node === 'number') {
    expect(Number.isFinite(node)).toBe(true)
    expect(Object.is(node, -0)).toBe(false)
    return
  }
  if (Array.isArray(node)) {
    node.forEach(assertJsonStable)
    return
  }
  if (node !== null && typeof node === 'object') {
    Object.values(node).forEach(assertJsonStable)
  }
}

describe('property — totality over hostile inputs (seeded)', () => {
  it('3×250 hostile (schema, profile) draws: never throws, always JSON-stable, issues typed', () => {
    let withIssues = 0
    let withFindings = 0
    let withDeltas = 0
    for (const seed of TOTALITY_SEEDS) {
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const rng = makeTestRng(seed + i)
        const input = {
          schemaA: genHostileSchema(rng),
          schemaB: genHostileSchema(rng),
          profileA: genHostileProfile(rng),
          profileB: genHostileProfile(rng),
        } as unknown as DiffInput
        let report: ReturnType<typeof diffDatasets> | undefined
        expect(() => {
          report = diffDatasets(input)
        }).not.toThrow()
        if (report === undefined) throw new Error('unreachable: diffDatasets returned nothing')
        assertJsonStable(report)
        expect(JSON.parse(JSON.stringify(report))).toEqual(report)
        // determinism: identical input → identical bytes
        expect(JSON.stringify(diffDatasets(input))).toBe(JSON.stringify(report))
        for (const issue of report.issues) {
          expect(KNOWN_CODES.has(issue.code)).toBe(true)
          expect(issue.message.length).toBeGreaterThan(0)
          expect(['A', 'B', undefined]).toContain(issue.side)
        }
        if (report.issues.length > 0) withIssues += 1
        if (report.schemaDrift.length > 0) withFindings += 1
        if (report.columnDeltas.length > 0) withDeltas += 1
      }
    }
    // non-vacuity: the hostile generator really produces problems, findings,
    // and deltas — or the sweep proves nothing. (Fully clean reports are the
    // identity suite's territory — pinned there over valid shapes.)
    expect(withIssues).toBeGreaterThan(0)
    expect(withFindings).toBeGreaterThan(0)
    expect(withDeltas).toBeGreaterThan(0)
  })

  it('hostile draws genuinely corrupt (the generator itself is non-vacuous)', () => {
    const rng = makeTestRng(20261099)
    let corrupted = 0
    for (let i = 0; i < 100; i++) {
      const before = genValidProfile(rng)
      const after = genHostileProfile(rng)
      if (JSON.stringify(before) !== JSON.stringify(after)) corrupted += 1
    }
    expect(corrupted).toBeGreaterThan(60)
  })
})

describe('property — identity: drift(a, a) = 0 everywhere (seeded)', () => {
  const IDENTITY_SEEDS = [20261011, 20261012]
  const CASES = 200

  it('valid profiles compared to themselves: no findings, no issues, exactly-0 metrics', () => {
    let numericSeen = 0
    let definedNumericSeen = 0
    let categoricalSeen = 0
    let nonEmptyProfiles = 0
    for (const seed of IDENTITY_SEEDS) {
      for (let i = 0; i < CASES; i++) {
        const rng = makeTestRng(seed + i)
        const profile = genValidProfile(rng)
        const schema = genValidSchema(rng)
        // deep copy: identity must hold by value, not by reference equality
        const input = {
          schemaA: schema,
          schemaB: JSON.parse(JSON.stringify(schema)),
          profileA: profile,
          profileB: JSON.parse(JSON.stringify(profile)),
        }
        const report = diffDatasets(input)
        expect(report.issues).toEqual([])
        expect(report.schemaDrift).toEqual([])
        expect(report.columnDeltas).toHaveLength(profile.columns.length)
        for (const delta of report.columnDeltas) {
          if (delta.numeric !== undefined) {
            numericSeen += 1
            // defined metrics are exactly 0; documented-undefined stays null
            if (delta.numeric.meanShiftStandardized !== null) {
              expect(delta.numeric.meanShiftStandardized).toBe(0)
              definedNumericSeen += 1
            }
            if (delta.numeric.varianceShiftStandardized !== null) {
              expect(delta.numeric.varianceShiftStandardized).toBe(0)
            }
            if (delta.numeric.p50Shift !== null) expect(delta.numeric.p50Shift).toBe(0)
            if (delta.numeric.p90Shift !== null) expect(delta.numeric.p90Shift).toBe(0)
            expect(Array.isArray(delta.numeric.bins.edges)).toBe(true)
          }
          if (delta.categorical !== undefined) {
            categoricalSeen += 1
            expect(delta.categorical.totalVariation).toBe(0)
            expect(delta.categorical.newCategories).toEqual([])
            expect(delta.categorical.vanishedCategories).toEqual([])
          }
        }
        expect(hasSchemaOrProfileDifferences(report)).toBe(false)
        if (profile.columns.length > 0) nonEmptyProfiles += 1
      }
    }
    // non-vacuity: the suites actually exercise both delta kinds on non-trivial shapes
    expect(nonEmptyProfiles).toBeGreaterThan(IDENTITY_SEEDS.length * CASES * 0.9)
    expect(numericSeen).toBeGreaterThan(0)
    expect(definedNumericSeen).toBeGreaterThan(0)
    expect(categoricalSeen).toBeGreaterThan(0)
  })
})

describe('property — documented symmetry and bounds (seeded)', () => {
  const SYMMETRY_SEEDS = [20261021, 20261022]
  const CASES = 250

  it('divergences: J-S and TV symmetric, PSI symmetric on fixed bins (Jeffreys form), bounds hold', () => {
    let zeroBinCases = 0
    let psiAsymmetryViaBins = 0
    let tvTopKEver = 0
    for (const seed of SYMMETRY_SEEDS) {
      for (let i = 0; i < CASES; i++) {
        const rng = makeTestRng(seed + i)
        const binCount = rng.int(1, 6)
        const edges = Array.from({ length: binCount - 1 }, (_, k) => (k + 1) * rng.int(1, 10))
        const { a, b } = genCountVectors(rng, binCount)
        if (a.includes(0) || b.includes(0)) zeroBinCases += 1

        const forward = psi(edges, a, b)
        const backward = psi(edges, b, a)
        expect(forward).not.toBeNull()
        expect(backward).not.toBeNull()
        expect(forward).toBeGreaterThanOrEqual(0) // non-negativity wherever defined
        expect(forward).toBeCloseTo(backward as number, 12) // Jeffreys symmetry on fixed bins
        // same raw data through a genuinely different reference binning → a
        // different PSI (the documented A-binned directionality is real)
        const otherEdges = binCount === 1 ? [7, 14] : [7]
        const raw = Array.from({ length: 40 }, () => rng.int(0, 60))
        const countsInto = (bins: number[], values: number[]) => {
          const counts = new Array<number>(bins.length + 1).fill(0)
          for (const v of values) counts[binIndex(bins, v)] += 1
          return counts
        }
        const ref = raw.slice(0, 20)
        const cur = raw.slice(20)
        const p1 = psi(edges, countsInto(edges, ref), countsInto(edges, cur))
        const p2 = psi(otherEdges, countsInto(otherEdges, ref), countsInto(otherEdges, cur))
        if (p1 !== null && p2 !== null && Math.abs(p1 - p2) > 1e-9) psiAsymmetryViaBins += 1

        const js = jensenShannon(edges, a, b)
        const jsSwapped = jensenShannon(edges, b, a)
        expect(js).not.toBeNull()
        expect(js).toBeGreaterThanOrEqual(0)
        // the ln-2 bound holds to floating rounding (the exact-arithmetic bound)
        expect(js).toBeLessThanOrEqual(Math.LN2 + 1e-12)
        expect(js).toBeCloseTo(jsSwapped as number, 12)

        const pair: ReturnType<typeof genTopKPair> = genTopKPair(rng)
        const tv = totalVariation(pair.topKA, pair.nonNullA, pair.topKB, pair.nonNullB)
        const tvSwapped = totalVariation(pair.topKB, pair.nonNullB, pair.topKA, pair.nonNullA)
        expect(tv).not.toBeNull()
        expect(tv).toBeGreaterThanOrEqual(0)
        expect(tv).toBeLessThanOrEqual(1)
        expect(tv).toBeCloseTo(tvSwapped as number, 12)
        // new/vanished exchange exactly under the swap (relative-to-A pin)
        const newForward: CategoricalTopKEntry[] = newCategories(pair.topKA, pair.topKB)
        expect(vanishedCategories(pair.topKA, pair.topKB)).toEqual(
          newCategories(pair.topKB, pair.topKA),
        )
        expect(newForward).toEqual(vanishedCategories(pair.topKB, pair.topKA))
        if (pair.topKA.length > 0 && pair.topKB.length > 0) tvTopKEver += 1
      }
    }
    // non-vacuity: epsilon path exercised; the bins genuinely carry the
    // directionality (PSI differs under a different reference binning); both
    // TV operands non-degenerate.
    expect(zeroBinCases).toBeGreaterThan(0)
    expect(psiAsymmetryViaBins).toBeGreaterThan(0)
    expect(tvTopKEver).toBeGreaterThan(0)
  })

  it('schema pairs: drift findings always come in the documented deterministic order', () => {
    for (const seed of SYMMETRY_SEEDS) {
      for (let i = 0; i < CASES_PER_SEED; i += 10) {
        const rng = makeTestRng(seed + 5000 + i)
        const { a, b } = genSchemaPair(rng)
        const profileA = genValidProfile(rng)
        const profileB = genValidProfile(rng)
        const report = diffDatasets({ schemaA: a, schemaB: b, profileA, profileB })
        // column name ascending (UTF-16 code unit), always
        const keys = report.schemaDrift.map((f) => f.column)
        expect(keys).toEqual([...keys].sort())
        // and reruns are byte-identical (determinism across the mixed draws)
        expect(JSON.stringify(diffDatasets({ schemaA: a, schemaB: b, profileA, profileB }))).toBe(
          JSON.stringify(report),
        )
      }
    }
  })
})
