// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { binIndex, deriveBins } from './bins'
import { distributionDeltas } from './deltas'
import { jensenShannon, newCategories, psi, totalVariation, vanishedCategories } from './divergence'
import {
  genCountVectors,
  genHostileProfile,
  genHostileSchema,
  genSchemaPair,
  genTopKPair,
  genValidProfile,
  genValidSchema,
  makeAllTrapsProxy,
  makeHostileShapeSpy,
  makeProxyArray,
  makeProxyObject,
  makeRevokedProxy,
  makeThrowingGetter,
  makeUnstringifiable,
  makeTestRng,
} from './diff-property-testing'
import type { HostileShapeCounts } from './diff-property-testing'
import { describeDiffIssue } from './issues'
import type { CategoricalTopKEntry } from './profile'
import { roundForReport } from './rounding'
import { diffDatasets, hasSchemaOrProfileDifferences } from './report'
import type { DiffInput } from './report'
import { nullabilityDrift, schemaDrift } from './schema-drift'

/**
 * Seeded property suites (m6-0). Repo convention: mulberry32, fixed seeds
 * (never `Math.random`), so a failing case reproduces exactly. Non-vacuity
 * is pinned everywhere (the m5-5 lesson: a suite that never generates the
 * interesting shape proves nothing).
 */

const TOTALITY_SEEDS = [20261001, 20261002, 20261003]
const CASES_PER_SEED = 250

/**
 * Exact per-family hostile-shape totals over HOSTILE_SHAPE_SEEDS ×
 * SHAPE_CASES draws (the spy counts at the bottom of the hostile-shape
 * suite). Deterministic constants — see the exact-pin rationale there.
 * Recomputed after the round-2 generator (unchanged since round 1):
 * 345 proxyArrays / 120 explodingObjects / 855 throwingGetters /
 * 921 unstringifiable.
 */
const EXPECTED_SHAPE_TOTALS: Readonly<HostileShapeCounts> = {
  proxyArrays: 345,
  explodingObjects: 120,
  throwingGetters: 855,
  unstringifiable: 921,
}

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
    // Total stringify: a shape that explodes on JSON.stringify is corrupted
    // *by definition* — that failure mode is the point of the shape weaves.
    const safeStringify = (value: unknown): string => {
      try {
        return JSON.stringify(value) ?? 'undefined'
      } catch {
        return '<unstringifiable or unreadable>'
      }
    }
    let corrupted = 0
    for (let i = 0; i < 100; i++) {
      const before = genValidProfile(rng)
      const after = genHostileProfile(rng)
      if (safeStringify(before) !== safeStringify(after)) corrupted += 1
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

// ---------------------------------------------------------------------------
// Hostile SHAPES (the m6-0 fix round): JSON-ish value corruption cannot
// detect a totality regression because it never detonates a getter, a Proxy
// trap, or a stringification path. These suites generate exactly those
// shapes, count them, and pin the counts (non-vacuity per family).
// ---------------------------------------------------------------------------

describe('property — totality over hostile shapes (proxies, throwing getters, coercion)', () => {
  const HOSTILE_SHAPE_SEEDS = [20261101, 20261102, 20261103]
  const SHAPE_CASES = 250

  it('3×250 draws with woven Proxy/getter/unstringifiable shapes: never throws, JSON-stable, every family counted', () => {
    const totals: HostileShapeCounts = makeHostileShapeSpy()
    for (const seed of HOSTILE_SHAPE_SEEDS) {
      for (let i = 0; i < SHAPE_CASES; i++) {
        const rng = makeTestRng(seed + i)
        const spy = makeHostileShapeSpy()
        const input = {
          schemaA: genHostileSchema(rng, spy),
          schemaB: genHostileSchema(rng, spy),
          profileA: genHostileProfile(rng, spy),
          profileB: genHostileProfile(rng, spy),
        } as unknown as DiffInput
        let report: ReturnType<typeof diffDatasets> | undefined
        expect(() => {
          report = diffDatasets(input)
        }).not.toThrow()
        if (report === undefined) throw new Error('unreachable: diffDatasets returned nothing')
        // reports stay plain, JSON-stable data even when the inputs were not
        assertJsonStable(report)
        expect(JSON.parse(JSON.stringify(report))).toEqual(report)
        totals.proxyArrays += spy.proxyArrays
        totals.explodingObjects += spy.explodingObjects
        totals.throwingGetters += spy.throwingGetters
        totals.unstringifiable += spy.unstringifiable
      }
    }
    // Non-vacuity per hostile family (the m5-5 lesson, applied to shapes),
    // pinned EXACTLY: the generators are seeded and deterministic to the bit
    // (mulberry32 is pure 32-bit integer arithmetic — platform-exact), so
    // the run totals are constants, recomputed and pinned. A lower bound
    // (toBeGreaterThan) was not enough: with only lower bounds, disabling a
    // single weave (e.g. the top-k proxy weave) left other weaves feeding
    // the same family and the suite green (the fix-round-2 drill). With
    // exact pins, disabling ANY weave, changing any probability, or
    // otherwise drifting a generator changes at least one total and fails
    // right here. (If a deliberate generator change shifts a total, re-derive
    // the constant and update it WITH the change, never by relaxing to a
    // bound.)
    expect(totals.proxyArrays).toBe(EXPECTED_SHAPE_TOTALS.proxyArrays)
    expect(totals.explodingObjects).toBe(EXPECTED_SHAPE_TOTALS.explodingObjects)
    expect(totals.throwingGetters).toBe(EXPECTED_SHAPE_TOTALS.throwingGetters)
    expect(totals.unstringifiable).toBe(EXPECTED_SHAPE_TOTALS.unstringifiable)
  })
})

describe('totality — the seven reviewer probes, verbatim shapes', () => {
  it('probes 1–2 — diffDatasets: array-Proxy schema and unstringifiable schema value', () => {
    const proxySchema = makeProxyArray()
    let report: ReturnType<typeof diffDatasets> | undefined
    expect(() => {
      report = diffDatasets({
        schemaA: proxySchema,
        schemaB: [],
        profileA: { rowCount: 1, columns: [] },
        profileB: { rowCount: 1, columns: [] },
      } as unknown as DiffInput)
    }).not.toThrow() // was: Error: array getter exploded
    expect(report?.issues.some((issue) => issue.code === 'invalid-schema-input')).toBe(true)

    const unstringifiable = makeUnstringifiable()
    expect(() => {
      report = diffDatasets({
        schemaA: unstringifiable,
        schemaB: [],
        profileA: { rowCount: 1, columns: [] },
        profileB: { rowCount: 1, columns: [] },
      } as unknown as DiffInput)
    }).not.toThrow() // was: Error: stringification exploded
    const issue = report?.issues.find((issue) => issue.code === 'invalid-schema-input')
    expect(issue?.message.length).toBeGreaterThan(0) // the message was built, safely
    expect(issue?.message).toContain('no safe string form') // hostile value never echoed
  })

  it('probe 3 — psi (and jensenShannon): Proxy count vectors and Proxy edges', () => {
    const proxyCounts = makeProxyArray()
    expect(() => psi([10], proxyCounts as never, [50, 50])).not.toThrow() // was: array getter exploded
    expect(psi([10], proxyCounts as never, [50, 50])).toBeNull()
    expect(psi([10], [50, 50], proxyCounts as never)).toBeNull()
    expect(psi(proxyCounts as never, [50, 50], [50, 50])).toBeNull()
    expect(jensenShannon([10], proxyCounts as never, [50, 50])).toBeNull()
    expect(jensenShannon(proxyCounts as never, [50, 50], [50, 50])).toBeNull()
  })

  it('probe 4 — binIndex: Proxy edges and hostile values/edges', () => {
    const proxyEdges = makeProxyArray()
    expect(() => binIndex(proxyEdges as never, 5)).not.toThrow() // was: array getter exploded
    expect(binIndex(proxyEdges as never, 5)).toBe(0) // unreadable edges → the one-bin shape
    expect(binIndex([10, 20], makeUnstringifiable() as never)).toBe(2) // hostile value → NaN → last bin
    expect(binIndex([makeUnstringifiable(), 10] as never, 5)).toBe(1) // non-number edge skipped
  })

  it('probe 5 — totalVariation: throwing entry getters and Proxy top-k', () => {
    const evilEntry = makeThrowingGetter('value', { count: 5 })
    expect(() => totalVariation([evilEntry as never], 10, [], 10)).not.toThrow() // was: value exploded
    expect(totalVariation([evilEntry as never], 10, [], 10)).toBeNull()
    expect(totalVariation([], 10, [evilEntry as never], 10)).toBeNull()
    expect(totalVariation(makeProxyArray() as never, 10, [], 10)).toBeNull()
    expect(
      totalVariation([{ value: 'x', count: 1 }], makeUnstringifiable() as never, [], 10),
    ).toBeNull()
  })

  it('probe 6 — newCategories/vanishedCategories: throwing entry getters', () => {
    const evilEntry = makeThrowingGetter('value', { count: 5 })
    expect(() => newCategories([evilEntry as never], [{ value: 'x', count: 1 }])).not.toThrow() // was: value exploded
    // unreadable side degrades to empty (documented): B's entries become "new"
    expect(newCategories([evilEntry as never], [{ value: 'x', count: 1 }])).toEqual([
      { value: 'x', count: 1 },
    ])
    expect(newCategories([{ value: 'x', count: 1 }], [evilEntry as never])).toEqual([])
    expect(() => vanishedCategories([{ value: 'x', count: 1 }], [evilEntry as never])).not.toThrow()
    expect(newCategories(makeProxyArray() as never, [{ value: 'x', count: 1 }])).toEqual([
      { value: 'x', count: 1 },
    ])
  })

  it('probe 7 — report predicate: throwing schemaDrift getter', () => {
    const hostileReport = makeThrowingGetter('schemaDrift', { columnDeltas: [] })
    expect(() => hasSchemaOrProfileDifferences(hostileReport as never)).not.toThrow() // was: report getter exploded
    expect(hasSchemaOrProfileDifferences(hostileReport as never)).toBe(false)
    expect(hasSchemaOrProfileDifferences(makeProxyObject() as never)).toBe(false)
  })
})

describe('totality — the reflective-throw class: revoked Proxies and all-traps Proxies', () => {
  // The fix-round-2 reviewer probe, verbatim shape: a revoked ARRAY Proxy
  // passed as schemaA used to escape diffDatasets as
  // `TypeError: Cannot perform 'IsArray' on a proxy that has been revoked`
  // (echoValue called Array.isArray outside a guard while building the
  // invalid-schema-input message). It must come back as the typed issue.
  it('revoked array Proxy as schemaA → invalid-schema-input issue, never a throw', () => {
    let report: ReturnType<typeof diffDatasets> | undefined
    expect(() => {
      report = diffDatasets({
        schemaA: makeRevokedProxy(),
        schemaB: [],
        profileA: { rowCount: 1, columns: [] },
        profileB: { rowCount: 1, columns: [] },
      } as unknown as DiffInput)
    }).not.toThrow() // was: TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
    expect(report?.issues).toHaveLength(1)
    const issue = report?.issues[0]
    expect(issue?.code).toBe('invalid-schema-input')
    expect(issue?.side).toBe('A')
    expect(issue?.message).toContain('no safe string form') // hostile value never echoed
    expect(report?.schemaDrift).toEqual([]) // the aspect skipped with the issue, no fabrication
    expect(report?.columnDeltas).toEqual([])
  })

  it('revoked Proxy / all-traps Proxy in every position of every public entry point', () => {
    const hostileSchemas: readonly unknown[] = [makeRevokedProxy(), makeAllTrapsProxy()]
    const validSchema = [{ name: 'x', type: 'DOUBLE' }]
    const validProfile = { rowCount: 4, columns: [] }
    for (const hostile of hostileSchemas) {
      // both schema sides
      expect(() => schemaDrift(hostile as never, validSchema as never)).not.toThrow()
      expect(schemaDrift(hostile as never, validSchema as never).findings).toEqual([])
      expect(() => schemaDrift(validSchema as never, hostile as never)).not.toThrow()
      // both profile sides (a revoked Proxy is typeof 'object', so it takes
      // the object path into validateProfile — reads guarded, degrade issue)
      expect(() => nullabilityDrift(hostile as never, validProfile as never)).not.toThrow()
      expect(() => distributionDeltas(hostile as never, validProfile as never)).not.toThrow()
      expect(distributionDeltas(hostile as never, validProfile as never).deltas).toEqual([])
      // divergence/bins arguments
      expect(psi(hostile as never, [50, 50], [50, 50])).toBeNull()
      expect(psi([10], hostile as never, [50, 50])).toBeNull()
      expect(jensenShannon(hostile as never, [50, 50], [50, 50])).toBeNull()
      expect(binIndex(hostile as never, 5)).toBe(0)
      expect(deriveBins(hostile as never).edges).toEqual([])
      expect(totalVariation(hostile as never, 10, [], 10)).toBeNull()
      expect(newCategories(hostile as never, hostile as never)).toEqual([])
      // the input object itself hostile — every field read degrades
      let report: ReturnType<typeof diffDatasets> | undefined
      expect(() => {
        report = diffDatasets(hostile as never)
      }).not.toThrow()
      expect(report?.issues.every((issue) => issue.code === 'invalid-input')).toBe(true)
      expect(report?.issues).toHaveLength(4) // one per input key, all attributed
      // echo paths (a revoked Proxy cannot even be asked isArray safely)
      expect(() => roundForReport(hostile as never)).not.toThrow()
      expect(() => describeDiffIssue(hostile as never)).not.toThrow()
      expect(describeDiffIssue(hostile as never)).toContain('(unreadable)')
      expect(hasSchemaOrProfileDifferences(hostile as never)).toBe(false)
      // as a whole DiffInput, each key revoked separately
      const healthy = {
        schemaA: validSchema,
        schemaB: validSchema,
        profileA: validProfile,
        profileB: validProfile,
      }
      for (const key of ['schemaA', 'schemaB', 'profileA', 'profileB'] as const) {
        let perKey: ReturnType<typeof diffDatasets> | undefined
        expect(() => {
          perKey = diffDatasets({ ...healthy, [key]: hostile } as unknown as DiffInput)
        }).not.toThrow()
        expect(perKey?.issues.length).toBeGreaterThan(0)
      }
    }
  })

  it('the all-traps fixture is lethal to every reflective operation named in the audit', () => {
    // Evidence that the fixture exercises the class the audit names: each
    // reflective operation detonates on the fixture itself. (Which is also
    // why the model must never run them on caller input — the entry-point
    // sweep above proves it never does.) `Array.isArray` stays TRUE: the
    // check itself does not detonate, exactly the shape that once let an
    // unguarded `Array.isArray`-then-reflect path look safe.
    const allTraps = makeAllTrapsProxy()
    expect(Array.isArray(allTraps)).toBe(true)
    expect(() => Array.from(allTraps as never)).toThrow()
    expect(() => [...(allTraps as unknown as Iterable<unknown>)]).toThrow()
    expect(() => Object.keys(allTraps as object)).toThrow()
    expect(() => Object.values(allTraps as object)).toThrow()
    expect(() => Object.entries(allTraps as object)).toThrow()
    expect(() => JSON.stringify(allTraps)).toThrow()
    expect(() => String(allTraps)).toThrow()
    expect(() => `${allTraps as never}`).toThrow()
    expect(() => (allTraps as { length: number }).length).toThrow()
    expect(() => (allTraps as unknown[])[0]).toThrow()
    expect(() => new Set(allTraps as never)).toThrow()
    // and the revoked fixture is even stricter: the isArray check itself throws
    const revoked = makeRevokedProxy()
    expect(() => Array.isArray(revoked)).toThrow()
    expect(() => JSON.stringify(revoked)).toThrow()
    expect(() => Object.keys(revoked as object)).toThrow()
  })
})

describe('totality — every public entry point survives every hostile-shape fixture', () => {
  const FIXTURES: readonly { readonly name: string; readonly make: () => unknown }[] = [
    { name: 'array Proxy', make: makeProxyArray },
    { name: 'object Proxy', make: makeProxyObject },
    { name: 'revoked Proxy', make: makeRevokedProxy },
    { name: 'all-traps Proxy', make: makeAllTrapsProxy },
    { name: 'throwing getter', make: () => makeThrowingGetter('value', { name: 'n', count: 3 }) },
    { name: 'unstringifiable', make: makeUnstringifiable },
    { name: 'null-prototype object', make: () => Object.create(null) },
  ]

  const validSchema = [{ name: 'x', type: 'DOUBLE' }]
  const validProfile = {
    rowCount: 10,
    columns: [
      {
        name: 'x',
        type: 'DOUBLE',
        kind: 'numeric',
        nullCount: 0,
        distinctCount: 5,
        numeric: {
          min: 0,
          max: 9,
          mean: 4.5,
          stddev: 2.5,
          quantiles: { p50: 4, p90: 8, p95: 8.5, p99: 9 },
        },
      },
    ],
  }

  it('binIndex / deriveBins', () => {
    for (const { make } of FIXTURES) {
      const hostile = make()
      expect(() => binIndex(hostile as never, hostile as never)).not.toThrow()
      expect(() => binIndex(hostile as never, 3)).not.toThrow()
      expect(() => binIndex([1, 2, 3], hostile as never)).not.toThrow()
      expect(() => deriveBins(hostile as never)).not.toThrow()
    }
  })

  it('psi / jensenShannon', () => {
    for (const { make } of FIXTURES) {
      const hostile = make()
      for (const position of ['edges', 'A', 'B'] as const) {
        const args = {
          edges: position === 'edges' ? hostile : [10],
          a: position === 'A' ? hostile : [50, 50],
          b: position === 'B' ? hostile : [50, 50],
        }
        expect(() => psi(args.edges as never, args.a as never, args.b as never)).not.toThrow()
        expect(() =>
          jensenShannon(args.edges as never, args.a as never, args.b as never),
        ).not.toThrow()
        expect(psi(args.edges as never, args.a as never, args.b as never)).toBeNull()
      }
    }
  })

  it('totalVariation / newCategories / vanishedCategories', () => {
    for (const { make } of FIXTURES) {
      const hostile = make()
      expect(() => totalVariation(hostile as never, 10, [], 10)).not.toThrow()
      expect(() => totalVariation([], 10, hostile as never, 10)).not.toThrow()
      expect(() => totalVariation([], 10, [], hostile as never)).not.toThrow()
      expect(() => newCategories(hostile as never, hostile as never)).not.toThrow()
      expect(() => newCategories(hostile as never, [])).not.toThrow()
      expect(() => newCategories([], hostile as never)).not.toThrow()
      expect(() => vanishedCategories(hostile as never, hostile as never)).not.toThrow()
    }
  })

  it('distributionDeltas / schemaDrift / nullabilityDrift', () => {
    for (const { make } of FIXTURES) {
      const hostile = make()
      let result: unknown
      expect(() => {
        result = distributionDeltas(hostile as never, validProfile as never)
      }).not.toThrow()
      expect(() => {
        result = distributionDeltas(validProfile as never, hostile as never)
      }).not.toThrow()
      expect((result as { deltas: unknown }).deltas).toEqual([]) // hostile side degrades, never fabricates
      expect(() => schemaDrift(hostile as never, validSchema as never)).not.toThrow()
      expect(() => schemaDrift(validSchema as never, hostile as never)).not.toThrow()
      expect(() => nullabilityDrift(hostile as never, validProfile as never)).not.toThrow()
      expect(() => nullabilityDrift(validProfile as never, hostile as never)).not.toThrow()
    }
  })

  it('diffDatasets (each input key hostile, separately)', () => {
    const healthy = {
      schemaA: validSchema,
      schemaB: validSchema,
      profileA: validProfile,
      profileB: validProfile,
    }
    for (const { make } of FIXTURES) {
      for (const key of ['schemaA', 'schemaB', 'profileA', 'profileB'] as const) {
        const input = { ...healthy, [key]: make() } as unknown as DiffInput
        let report: ReturnType<typeof diffDatasets> | undefined
        expect(() => {
          report = diffDatasets(input)
        }).not.toThrow()
        expect(report?.issues.length).toBeGreaterThan(0) // attributed, never silent
        for (const issue of report?.issues ?? []) {
          expect(issue.message.length).toBeGreaterThan(0)
        }
        expect(Array.isArray(report?.schemaDrift)).toBe(true)
        expect(Array.isArray(report?.columnDeltas)).toBe(true)
      }
    }
  })

  it('roundForReport / describeDiffIssue / hasSchemaOrProfileDifferences', () => {
    for (const { make } of FIXTURES) {
      const hostile = make()
      expect(() => roundForReport(hostile as never)).not.toThrow()
      expect(roundForReport(hostile as never)).toBe(hostile) // passthrough: no coercion
      let rendered: string | undefined
      expect(() => {
        rendered = describeDiffIssue(hostile as never)
      }).not.toThrow()
      expect(rendered).toContain('(unreadable)')
      expect(() => hasSchemaOrProfileDifferences(hostile as never)).not.toThrow()
      expect(hasSchemaOrProfileDifferences(hostile as never)).toBe(false)
    }
  })
})
