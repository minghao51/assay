// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compileRowDiffPlan, keyTypesCompatible } from './row-diff-compile'
import type { RowDiffBindingErrorCode } from './row-diff-errors'
import { describeRowDiffBindingError } from './row-diff-errors'
import type { RowDiffPlan } from './row-diff-plan'
import { DIFF_PLAN_KIND, DIFF_PLAN_VERSION, ROW_DIFF_ASPECTS } from './row-diff-plan'
import { inferRowDiffKeys } from './key-inference'
import {
  genHostileInferenceProfile,
  genHostileKeys,
  genHostileRowDiffOptions,
  genHostileSchema,
  genRowDiffInputs,
  makeHostileShapeSpy,
  makeRowDiffFeatureSpy,
  makeAllTrapsProxy,
  makeRevokedProxy,
  makeTestRng,
  ROW_DIFF_PLAN_FUNCTIONS,
  ROW_DIFF_PLAN_KEYWORDS,
  scanOrdinalScopes,
  scanPlanSql,
} from './diff-property-testing'
import type { HostileShapeCounts, RowDiffFeatureCounts } from './diff-property-testing'

/**
 * Seeded property suites for the row-diff plan compiler + key inference
 * (m6-1). Repo convention: mulberry32, fixed seeds (never `Math.random`),
 * so a failing case reproduces exactly. Non-vacuity is pinned EXACTLY —
 * the generators are deterministic to the bit, so every hostile-family
 * total and feature count over the pinned seeds is a constant: disabling
 * any single generator weave (or drifting any probability) changes at
 * least one pinned total and fails right here (the m6-0 round-2 lesson:
 * lower bounds stayed green with a weave disabled; exact pins cannot).
 */

const TOTALITY_SEEDS = [20261211, 20261212, 20261213]
const TOTALITY_CASES = 250
const STRUCTURE_SEEDS = [20261201, 20261202]
const STRUCTURE_CASES = 200
const INFERENCE_HOSTILE_SEEDS = [20261221, 20261222]
const INFERENCE_HOSTILE_CASES = 250

const KNOWN_CODES: ReadonlySet<string> = new Set<RowDiffBindingErrorCode>([
  'invalid-options',
  'invalid-schema-input',
  'duplicate-schema-column',
  'invalid-keys-input',
  'duplicate-key-column',
  'empty-key-set',
  'no-shared-columns',
  'missing-key-column',
  'key-type-mismatch',
])

/**
 * Exact per-family hostile-shape totals over TOTALITY_SEEDS × TOTALITY_CASES
 * draws of the m6-1 composition (2× genHostileSchema + genHostileKeys +
 * genHostileRowDiffOptions, all weaving into one spy per draw).
 * Deterministic constants — recomputed and pinned; a deliberate generator
 * change updates them WITH the change, never by relaxing to a bound.
 */
const EXPECTED_COMPILE_SHAPE_TOTALS: Readonly<HostileShapeCounts> = {
  proxyArrays: 208,
  explodingObjects: 54,
  throwingGetters: 596,
  unstringifiable: 355,
}

/** Exact feature totals over STRUCTURE_SEEDS × STRUCTURE_CASES draws. */
const EXPECTED_FEATURE_TOTALS: Readonly<RowDiffFeatureCounts> & {
  accepted: number
  rejected: number
} = {
  multiKeyDraws: 133,
  hostileNameDraws: 390,
  unsharedExtraDraws: 235,
  jsonColumnDraws: 86,
  limitedDraws: 272,
  accepted: 251,
  rejected: 149,
}

/**
 * Exact per-family hostile-shape totals over INFERENCE_HOSTILE_SEEDS ×
 * INFERENCE_HOSTILE_CASES draws (2× genHostileInferenceProfile per draw).
 */
const EXPECTED_INFERENCE_SHAPE_TOTALS: Readonly<HostileShapeCounts> = {
  proxyArrays: 84,
  explodingObjects: 42,
  throwingGetters: 96,
  unstringifiable: 60,
}

describe('property — row-diff plans over generated inputs (seeded, structural + determinism)', () => {
  it('2×200 generated input sets: plan well-formed, deterministic, JSON-stable, structurally injection-safe', () => {
    const features = makeRowDiffFeatureSpy()
    let accepted = 0
    let rejected = 0
    let ordinalWindows = 0
    for (const seed of STRUCTURE_SEEDS) {
      for (let i = 0; i < STRUCTURE_CASES; i++) {
        const rng = makeTestRng(seed + i)
        const draw = genRowDiffInputs(rng, features)
        let result: ReturnType<typeof compileRowDiffPlan> | undefined
        expect(() => {
          result = compileRowDiffPlan(draw.schemaA, draw.schemaB, draw.keys, draw.options)
        }).not.toThrow()
        if (result === undefined) throw new Error('unreachable: compiler returned nothing')
        if (result.ok) {
          accepted += 1
          const plan = result.plan
          // plan identity + echoed metadata
          expect(plan.planKind).toBe(DIFF_PLAN_KIND)
          expect(plan.planVersion).toBe(DIFF_PLAN_VERSION)
          expect(plan.keys).toEqual(draw.keys)
          expect(plan.relationA).toBe(draw.options.relationA)
          expect(plan.relationB).toBe(draw.options.relationB)
          const expectedK = draw.options.sampleLimit ?? 20
          expect(plan.sampleLimit).toBe(expectedK)
          // shared columns: exact, case-sensitive intersection minus keys,
          // in schema-A order (recomputed independently here)
          const keySet = new Set(draw.keys)
          const sharedA = draw.schemaA.filter(
            (column) =>
              !keySet.has(column.name) && draw.schemaB.some((other) => other.name === column.name),
          )
          expect(plan.sharedColumns).toEqual(sharedA.map((column) => column.name))
          // every aspect query is bounded by exactly K and carries the count
          for (const sql of [plan.addedSql, plan.removedSql, plan.changedSql]) {
            expect(sql.endsWith(`LIMIT ${expectedK}`)).toBe(true)
            expect(sql).toContain('count(*) OVER () AS "assay_count"')
            expect(sql).toContain('"assay_row_ordinal"')
          }
          // aspect order and one arm per aspect in the totals query
          const arms = plan.totalsSql.split('\nUNION ALL\n')
          expect(arms).toHaveLength(ROW_DIFF_ASPECTS.length)
          ROW_DIFF_ASPECTS.forEach((aspect, i) => {
            expect((arms[i] as string).startsWith(`SELECT '${aspect}' AS "assay_aspect"`)).toBe(
              true,
            )
          })
          // determinism: recompiling is byte-identical (SQL and JSON)
          const second = compileRowDiffPlan(draw.schemaA, draw.schemaB, draw.keys, draw.options)
          expect(JSON.stringify(second)).toBe(JSON.stringify(result))
          // JSON round-trip of the plan payload
          expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
          // structural injection safety: scan every generated query
          assertStructurallySafe(plan, {
            relationA: draw.options.relationA,
            relationB: draw.options.relationB,
            keys: draw.keys,
          })
          // …and every query's ordinal window is pre-filter (non-vacuity is
          // pinned below as an exact total: 6 windows per accepted plan).
          for (const sql of [plan.addedSql, plan.removedSql, plan.changedSql, plan.totalsSql]) {
            ordinalWindows += scanOrdinalScopes(sql).ordinalWindows
          }
        } else {
          rejected += 1
          for (const error of result.errors) {
            expect(KNOWN_CODES.has(error.code)).toBe(true)
            expect(error.message.length).toBeGreaterThan(0)
            expect(error.message).not.toContain('[object') // never-echo of hostile shapes
            expect(JSON.parse(JSON.stringify(error))).toEqual(error)
          }
        }
      }
    }
    // EXACT non-vacuity pins: every generator feature branch and both
    // compile outcomes have deterministic constant totals over these seeds.
    // Disabling any branch (or drifting any probability) changes ≥ 1 total.
    expect(features.multiKeyDraws).toBe(EXPECTED_FEATURE_TOTALS.multiKeyDraws)
    expect(features.hostileNameDraws).toBe(EXPECTED_FEATURE_TOTALS.hostileNameDraws)
    expect(features.unsharedExtraDraws).toBe(EXPECTED_FEATURE_TOTALS.unsharedExtraDraws)
    expect(features.jsonColumnDraws).toBe(EXPECTED_FEATURE_TOTALS.jsonColumnDraws)
    expect(features.limitedDraws).toBe(EXPECTED_FEATURE_TOTALS.limitedDraws)
    expect(accepted).toBe(EXPECTED_FEATURE_TOTALS.accepted)
    expect(rejected).toBe(EXPECTED_FEATURE_TOTALS.rejected)
    // every accepted plan carries exactly six ordinal windows (added +
    // removed + changed + three totals arms) and the scan above proved none
    // shares a SELECT scope with a WHERE — a post-filter regression fails
    // inside `assertStructurallySafe`, and this exact total fails if the
    // scan silently stops seeing windows (the m6-0 non-vacuity lesson).
    expect(ordinalWindows).toBe(EXPECTED_FEATURE_TOTALS.accepted * 6)
  })
})

/**
 * The structural-injection assertion shared by the property suite: every
 * identifier in every generated query is double-quoted and drawn from the
 * caller's names or the plan's reserved namespace; every string literal is
 * an internal constant or a changed-column NAME; nothing outside quotes
 * parses beyond the fixed keyword/function vocabulary.
 */
function assertStructurallySafe(
  plan: RowDiffPlan,
  draw: {
    relationA: string
    relationB: string
    keys: readonly string[]
  },
): void {
  const reserved = new Set([
    'a',
    'b',
    'ai',
    'bi', // documented range names
    'assay_antijoin_source', // the anti-join's ordinal-preserving derived table
    'assay_side',
    'assay_row_ordinal',
    'assay_changed',
    'assay_count',
    'assay_aspect',
    'sample_index',
    'assay_present_a',
    'assay_present_b',
    'assay_added_rows',
    'assay_removed_rows',
    'assay_changed_rows',
    'assay_added_total',
    'assay_removed_total',
    'assay_changed_total',
    ...plan.keys.map((_, i) => `assay_key_${i}`),
    ...plan.sharedColumns.map((_, j) => `assay_col_${j}`),
  ])
  const allowedIdentifiers = new Set([
    draw.relationA,
    draw.relationB,
    ...draw.keys,
    ...plan.sharedColumns,
    ...reserved,
  ])
  const allowedLiterals = new Set(['A', 'B', 'added', 'removed', 'changed', ...plan.sharedColumns])
  for (const sql of [plan.addedSql, plan.removedSql, plan.changedSql, plan.totalsSql]) {
    const { literals, identifiers, unquoted } = scanPlanSql(sql)
    for (const id of identifiers) expect(allowedIdentifiers.has(id)).toBe(true)
    for (const lit of literals) expect(allowedLiterals.has(lit)).toBe(true)
    const words = unquoted.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
    for (const word of words) {
      expect(
        ROW_DIFF_PLAN_KEYWORDS.has(word) || ROW_DIFF_PLAN_FUNCTIONS.has(word),
        `unquoted token '${word}' outside the keyword vocabulary in: ${sql}`,
      ).toBe(true)
    }
    // every ordinal window is computed pre-filter (m6-1 round-1 fix): its
    // SELECT scope carries no sibling WHERE over all generated aspects.
    expect(scanOrdinalScopes(sql).violations).toEqual([])
  }
}

describe('property — totality over hostile shapes (compile: schemas × keys × options)', () => {
  it('3×250 hostile compositions: never throws, errors typed + JSON-stable, every family counted exactly', () => {
    const totals = makeHostileShapeSpy()
    let rejectedDraws = 0
    let acceptedDraws = 0
    for (const seed of TOTALITY_SEEDS) {
      for (let i = 0; i < TOTALITY_CASES; i++) {
        const rng = makeTestRng(seed + i)
        const spy = makeHostileShapeSpy()
        const schemaA = genHostileSchema(rng, spy)
        const schemaB = genHostileSchema(rng, spy)
        const keys = genHostileKeys(rng, spy)
        const options = genHostileRowDiffOptions(rng, spy)
        let result: ReturnType<typeof compileRowDiffPlan> | undefined
        expect(() => {
          result = compileRowDiffPlan(
            schemaA as never,
            schemaB as never,
            keys as never,
            options as never,
          )
        }).not.toThrow()
        if (result === undefined) throw new Error('unreachable: compiler returned nothing')
        if (result.ok) {
          acceptedDraws += 1
          // even hostile surviving inputs produce a fully governed plan
          expect(result.plan.planKind).toBe(DIFF_PLAN_KIND)
          expect(JSON.parse(JSON.stringify(result.plan))).toEqual(result.plan)
        } else {
          rejectedDraws += 1
          for (const error of result.errors) {
            expect(KNOWN_CODES.has(error.code)).toBe(true)
            expect(error.message.length).toBeGreaterThan(0)
            expect(error.message).not.toContain('[object')
            expect(JSON.parse(JSON.stringify(error))).toEqual(error)
          }
        }
        totals.proxyArrays += spy.proxyArrays
        totals.explodingObjects += spy.explodingObjects
        totals.throwingGetters += spy.throwingGetters
        totals.unstringifiable += spy.unstringifiable
      }
    }
    // Non-vacuity: the hostile composition really produces both outcomes…
    expect(rejectedDraws).toBeGreaterThan(0)
    // …and every hostile-shape family is counted EXACTLY (deterministic
    // constants — disabling any weave, changing any probability, or
    // otherwise drifting a generator fails one of these pins; the
    // per-weave disable drills are demonstrated in the m6-1 report).
    expect(totals.proxyArrays).toBe(EXPECTED_COMPILE_SHAPE_TOTALS.proxyArrays)
    expect(totals.explodingObjects).toBe(EXPECTED_COMPILE_SHAPE_TOTALS.explodingObjects)
    expect(totals.throwingGetters).toBe(EXPECTED_COMPILE_SHAPE_TOTALS.throwingGetters)
    expect(totals.unstringifiable).toBe(EXPECTED_COMPILE_SHAPE_TOTALS.unstringifiable)
    expect(rejectedDraws + acceptedDraws).toBe(TOTALITY_SEEDS.length * TOTALITY_CASES)
  })
})

describe('property — key inference over generated and hostile profiles (seeded)', () => {
  it('hostile profile pairs: never throws, candidates honest, issues typed, every family counted exactly', () => {
    const totals = makeHostileShapeSpy()
    let emptyResults = 0
    for (const seed of INFERENCE_HOSTILE_SEEDS) {
      for (let i = 0; i < INFERENCE_HOSTILE_CASES; i++) {
        const rng = makeTestRng(seed + i)
        const spy = makeHostileShapeSpy()
        const profileA = genHostileInferenceProfile(rng, spy)
        const profileB = genHostileInferenceProfile(rng, spy)
        let result: ReturnType<typeof inferRowDiffKeys> | undefined
        expect(() => {
          result = inferRowDiffKeys(profileA as never, profileB as never)
        }).not.toThrow()
        if (result === undefined) throw new Error('unreachable: inference returned nothing')
        // determinism under hostility too
        expect(JSON.stringify(inferRowDiffKeys(profileA as never, profileB as never))).toBe(
          JSON.stringify(result),
        )
        for (const candidate of result.candidates) {
          expect(candidate.columns).toHaveLength(1) // the documented v1 boundary
          expect(candidate.disclosure).toContain(candidate.evidence.column)
        }
        if (result.candidates.length === 0) emptyResults += 1
        expect(result.disclosure.length).toBeGreaterThan(0) // never silent
        for (const issue of result.issues) {
          expect(issue.message.length).toBeGreaterThan(0)
          expect(issue.message).not.toContain('[object')
        }
        totals.proxyArrays += spy.proxyArrays
        totals.explodingObjects += spy.explodingObjects
        totals.throwingGetters += spy.throwingGetters
        totals.unstringifiable += spy.unstringifiable
      }
    }
    expect(emptyResults).toBeGreaterThan(0)
    // EXACT per-family pins (see the compile suite's rationale).
    expect(totals.proxyArrays).toBe(EXPECTED_INFERENCE_SHAPE_TOTALS.proxyArrays)
    expect(totals.explodingObjects).toBe(EXPECTED_INFERENCE_SHAPE_TOTALS.explodingObjects)
    expect(totals.throwingGetters).toBe(EXPECTED_INFERENCE_SHAPE_TOTALS.throwingGetters)
    expect(totals.unstringifiable).toBe(EXPECTED_INFERENCE_SHAPE_TOTALS.unstringifiable)
  })
})

describe('totality — revoked/all-traps Proxies in every position of every new entry point', () => {
  const hostileFixtures = [makeRevokedProxy(), makeAllTrapsProxy()]
  const healthySchema = [{ name: 'x', type: 'DOUBLE' }]
  const healthyKeys = ['x']
  const healthyOptions = { relationA: 'ra', relationB: 'rb' }

  it('compileRowDiffPlan: each argument hostile, separately', () => {
    for (const hostile of hostileFixtures) {
      const positions = {
        schemaA: [hostile, healthySchema, healthyKeys, healthyOptions],
        schemaB: [healthySchema, hostile, healthyKeys, healthyOptions],
        keys: [healthySchema, healthySchema, hostile, healthyOptions],
        options: [healthySchema, healthySchema, healthyKeys, hostile],
      } as const
      for (const [name, args] of Object.entries(positions)) {
        let result: ReturnType<typeof compileRowDiffPlan> | undefined
        expect(() => {
          result = compileRowDiffPlan(
            args[0] as never,
            args[1] as never,
            args[2] as never,
            args[3] as never,
          )
        }).not.toThrow()
        expect(result?.ok).toBe(false) // a hostile argument cannot silently bind
        if (result !== undefined && !result.ok) {
          for (const error of result.errors) {
            expect(KNOWN_CODES.has(error.code)).toBe(true)
            expect(describeRowDiffBindingError(error).length).toBeGreaterThan(0)
          }
        }
        void name
      }
    }
  })

  it('inferRowDiffKeys / keyTypesCompatible / describeRowDiffBindingError: hostile arguments degrade', () => {
    for (const hostile of hostileFixtures) {
      expect(() =>
        inferRowDiffKeys(hostile as never, { rowCount: 2, columns: [] } as never),
      ).not.toThrow()
      expect(() =>
        inferRowDiffKeys({ rowCount: 2, columns: [] } as never, hostile as never),
      ).not.toThrow()
      // the policy predicate is total: a hostile "type" is simply not compatible
      let compatible: boolean | undefined
      expect(() => {
        compatible = keyTypesCompatible(hostile as never, 'BIGINT')
      }).not.toThrow()
      expect(compatible).toBe(false)
      expect(keyTypesCompatible('BIGINT', hostile as never)).toBe(false)
      // the error renderer stays total over a hostile error object
      expect(describeRowDiffBindingError(hostile as never)).toContain('(unreadable)')
    }
  })
})
