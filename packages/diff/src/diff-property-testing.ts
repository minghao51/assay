/**
 * Deterministic generators for the m6-0 property tests (test support only —
 * NOT part of the public surface; `index.ts` never re-exports this module).
 *
 * Repo convention is determinism: no `Math.random`. Everything derives from
 * a seedable PRNG (mulberry32, the same construction as `@assay/validation`
 * and `@assay/contracts`' private copies — packages are lint-forbidden from
 * importing each other) so a failing seed reproduces exactly; seeds are
 * fixed in the test files on purpose.
 *
 * Two generator families:
 * - `genValid*` produce constraint-respecting profiles/schemas (counts in
 *   range, payload/kind coupling, top-k sums within the non-null mass,
 *   unique names, finite stats) — the domain the *property* suites reason
 *   over (identity, symmetry, bounds).
 * - `genHostile*` corrupt valid shapes along a documented probability
 *   table (NaN/±Infinity where numbers belong, negative and overflowing
 *   counts, unknown kinds, swapped/missing payloads, duplicated names and
 *   top-k values, NUL names, `__proto__` spellings, non-object entries) —
 *   the domain the *totality* sweep must survive without throwing.
 */

import type { ColumnTypeFamily } from '@assay/validation'
import type {
  CategoricalColumnStats,
  CategoricalTopKEntry,
  ColumnProfile,
  DatasetProfile,
  NumericColumnStats,
  NumericQuantiles,
} from './profile'

/** mulberry32 — 32-bit seeded PRNG, deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Small deterministic RNG facade over mulberry32. */
export interface TestRng {
  /** Next float in [0, 1). */
  float(): number
  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Uniform pick; list must be non-empty. */
  pick<T>(items: readonly T[]): T
  /** True with probability p (default 0.5). */
  bool(p?: number): boolean
  /** Fisher–Yates shuffle (returns a fresh array). */
  shuffle<T>(items: readonly T[]): T[]
}

export function makeTestRng(seed: number): TestRng {
  const next = mulberry32(seed)
  const rng: TestRng = {
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    bool: (p = 0.5) => next() < p,
    shuffle: (items) => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = out[i] as (typeof out)[number]
        out[i] = out[j] as (typeof out)[number]
        out[j] = tmp
      }
      return out
    },
  }
  return rng
}

/** Column names incl. prototype-spelling keys (must stay inert — Map/Set lookup). */
const NAME_POOL = [
  'id',
  'amount',
  'score',
  'country',
  'joined_at',
  'flag',
  '__proto__',
  'toString',
  'constructor',
  'hasOwnProperty',
]

/** Engine type spellings across every classifier family + unclassifiable ones. */
const TYPE_POOL: Readonly<Record<string, ColumnTypeFamily>> = {
  BIGINT: 'numeric',
  INTEGER: 'numeric',
  DOUBLE: 'numeric',
  'DECIMAL(10,2)': 'numeric',
  VARCHAR: 'textual',
  'VARCHAR(3)': 'textual',
  BOOLEAN: 'boolean',
  DATE: 'temporal',
  TIMESTAMP: 'temporal',
  UUID: 'uuid',
  JSON: 'json',
  BLOB: 'blob',
  'INTEGER[]': 'other',
  'STRUCT(a INTEGER)': 'other',
  WEIRD_TYPE: 'other',
}

/** Categorical values incl. prototype-spelling keys and the empty string. */
const VALUE_POOL = ['US', 'GB', 'DE', '__proto__', 'toString', '', 'ünï', 'has space']

/** Generate an engine-shaped schema with unique names (mostly valid). */
export function genValidSchema(rng: TestRng): { name: string; type: string }[] {
  const names = rng.shuffle(Object.keys(TYPE_POOL)).slice(0, rng.int(1, 6))
  return names.map((name) => ({ name, type: rng.pick(Object.keys(TYPE_POOL)) }))
}

function genValidQuantiles(rng: TestRng): NumericQuantiles {
  const base = rng.int(-1000, 1000)
  let p50: number | null = base
  let p90: number | null = p50 + rng.int(0, 100)
  let p95: number | null = p90 + rng.int(0, 50)
  let p99: number | null = p95 + rng.int(0, 50)
  // sprinkle nulls (short columns) while preserving ascending order
  if (rng.bool(0.15)) p99 = null
  if (rng.bool(0.1)) p95 = null
  if (rng.bool(0.05)) {
    p50 = null
    p90 = null
  }
  return { p50, p90, p95, p99 }
}

function genValidNumericStats(rng: TestRng): NumericColumnStats {
  const q = genValidQuantiles(rng)
  const min = q.p50 !== null ? q.p50 - rng.int(0, 500) : rng.int(-2000, 0)
  const max = q.p99 !== null ? q.p99 + rng.int(0, 500) : rng.int(0, 2000)
  return {
    min,
    max,
    mean: rng.bool(0.9) ? rng.float() * 2000 - 1000 : null,
    stddev: rng.bool(0.85) ? rng.float() * 100 : null,
    quantiles: q,
  }
}

function genValidCategoricalStats(rng: TestRng, nonNull: number): CategoricalColumnStats {
  if (nonNull === 0) return { topK: [] }
  // k ≤ nonNull and each count ≤ floor(nonNull/k) ⇒ Σ ≤ nonNull (by construction)
  const k = Math.min(rng.int(1, 4), nonNull)
  const cap = Math.max(1, Math.floor(nonNull / k))
  const values = rng.shuffle(VALUE_POOL).slice(0, Math.min(k, VALUE_POOL.length))
  const topK: CategoricalTopKEntry[] = values.map((value) => ({
    value,
    count: rng.int(1, cap),
  }))
  return { topK }
}

/** Generate one valid profile column of a random kind. */
export function genValidColumnProfile(rng: TestRng, rowCount: number, name: string): ColumnProfile {
  const kind = rng.pick(['numeric', 'categorical', 'other'] as const)
  const nullCount = rng.int(0, rowCount)
  const nonNull = rowCount - nullCount
  const distinctCount = rng.int(0, nonNull)
  const column: ColumnProfile = {
    name,
    type: rng.pick(Object.keys(TYPE_POOL)),
    kind,
    nullCount,
    distinctCount,
  }
  if (kind === 'numeric') column.numeric = genValidNumericStats(rng)
  if (kind === 'categorical') column.categorical = genValidCategoricalStats(rng, nonNull)
  return column
}

/** Generate a valid profile (all documented invariants hold). */
export function genValidProfile(rng: TestRng): DatasetProfile {
  const rowCount = rng.int(0, 5000)
  const names = rng.shuffle(NAME_POOL).slice(0, rng.int(1, 5))
  return { rowCount, columns: names.map((name) => genValidColumnProfile(rng, rowCount, name)) }
}

/** A schema pair with drifting names/types (both sides individually valid). */
export function genSchemaPair(rng: TestRng): {
  a: { name: string; type: string }[]
  b: { name: string; type: string }[]
} {
  const a = genValidSchema(rng)
  const b = a
    .filter(() => rng.bool(0.85))
    .map((column) => ({
      name: column.name,
      type: rng.bool(0.6) ? column.type : rng.pick(Object.keys(TYPE_POOL)),
    }))
  if (rng.bool(0.5)) b.push({ name: 'arrived_late', type: rng.pick(Object.keys(TYPE_POOL)) })
  return { a, b }
}

/** Corruptions applied to valid shapes for the totality sweep. */
const HOSTILE_NUMBERS = [NaN, Infinity, -Infinity, 1.5, -1, 2 ** 60]

/**
 * Return a corrupted copy of a valid profile: each corruption point fires
 * with the documented probability, seeded — hostile input for the totality
 * sweep, never thrown at, always attributed.
 */
export function genHostileProfile(rng: TestRng): unknown {
  const base = genValidProfile(rng)
  const profile: Record<string, unknown> = {
    rowCount: rng.bool(0.15) ? rng.pick([-1, NaN, 1.5, 'many', Infinity]) : base.rowCount,
    columns: base.columns.map((column) => {
      const c: Record<string, unknown> = { ...column }
      if (rng.bool(0.1)) c.kind = rng.pick(['weird', 'NUMERIC', '', 42, null])
      if (rng.bool(0.1)) c.nullCount = rng.pick([-1, base.rowCount + 5, NaN, 0.5, null])
      if (rng.bool(0.08)) c.distinctCount = rng.pick([-2, base.rowCount + 1, NaN])
      if (rng.bool(0.1)) delete c.kind // missing kind
      if (column.numeric !== undefined) {
        if (rng.bool(0.2))
          delete c.numeric // missing payload
        else {
          const stats: Record<string, unknown> = { ...column.numeric }
          if (rng.bool(0.15)) stats.mean = rng.pick(HOSTILE_NUMBERS)
          if (rng.bool(0.15)) stats.stddev = rng.pick([...HOSTILE_NUMBERS, -0.5])
          if (rng.bool(0.15))
            stats.quantiles = rng.pick([
              { p50: NaN, p90: 5, p95: 6, p99: 7 },
              { p50: 5, p90: 'nine', p95: 6, p99: 7 },
              { p50: 1, p90: 2, p95: 3 },
              'nope',
              null,
            ])
          c.numeric = stats
        }
      } else if (rng.bool(0.1)) {
        c.numeric = {
          min: 0,
          max: 1,
          mean: 0.5,
          stddev: 0.1,
          quantiles: { p50: 0, p90: 1, p95: 1, p99: 1 },
        } // payload on the wrong kind
      }
      if (column.categorical !== undefined) {
        if (rng.bool(0.2)) delete c.categorical
        else {
          const stats: Record<string, unknown> = { ...column.categorical }
          const topK = (column.categorical as CategoricalColumnStats).topK
          if (rng.bool(0.3) && topK.length > 0) {
            stats.topK = rng.pick([
              topK.map((e) => ({ value: e.value, count: 0 })),
              topK.map((e) => ({ value: e.value, count: -1 })),
              topK.map((e) => ({ value: e.value, count: NaN })),
              topK.map((e) => ({ value: e.value, count: 1.5 })),
              [...topK, { value: topK[0]?.value ?? 'x', count: 2 }], // duplicate value
              [...topK, { value: '__proto__', count: 2 }],
              'nope',
            ])
          }
          c.categorical = stats
        }
      }
      return c
    }),
  }
  if (rng.bool(0.1)) {
    // duplicate a column (first-wins + issue)
    const columns = profile.columns as Record<string, unknown>[]
    if (columns.length > 0) columns.push({ ...(columns[0] as Record<string, unknown>) })
  }
  if (rng.bool(0.05)) profile.columns = rng.pick([null, 'nope', 42])
  if (rng.bool(0.05)) return rng.pick([null, 42, 'profile', []])
  return profile
}

/**
 * A hostile schema: valid entries corrupted (malformed entries, missing or
 * NUL-bearing names/types, duplicates, non-object entries).
 */
export function genHostileSchema(rng: TestRng): unknown {
  const base = genValidSchema(rng)
  const schema: unknown[] = base.map((column) => {
    if (rng.bool(0.1)) return rng.pick([null, 42, 'column', [], {}])
    const c = { ...column }
    if (rng.bool(0.08)) c.name = rng.pick(['', 'na\u0000me', '__proto__'])
    if (rng.bool(0.08)) c.type = rng.pick(['', 'ty\u0000pe'])
    return c
  })
  if (base.length > 0 && rng.bool(0.15)) schema.push({ ...base[0], type: 'DOUBLE' }) // duplicate name
  if (rng.bool(0.05)) return rng.pick([null, 42, 'schema', {}])
  return schema
}

/** Random count vectors over `binCount` bins, with zero bins (the epsilon path). */
export function genCountVectors(rng: TestRng, binCount: number): { a: number[]; b: number[] } {
  const gen = () => {
    const counts: number[] = []
    for (let i = 0; i < binCount; i++) {
      // ~30% zero bins so both the epsilon path and the both-zero path occur
      counts.push(rng.bool(0.3) ? 0 : rng.int(1, 500))
    }
    if (counts.reduce((sum, c) => sum + c, 0) === 0) counts[0] = 1 // keep the side non-empty (a zero total is a documented null, tested separately)
    return counts
  }
  return { a: gen(), b: gen() }
}

/** A valid top-k pair over a shared non-null mass (for the symmetry suite). */
export function genTopKPair(rng: TestRng): {
  topKA: CategoricalTopKEntry[]
  nonNullA: number
  topKB: CategoricalTopKEntry[]
  nonNullB: number
} {
  // k ≤ nonNull and each count ≤ floor(nonNull/k) ⇒ Σ ≤ nonNull (by construction)
  const gen = (nonNull: number) => {
    if (nonNull === 0) return [] as CategoricalTopKEntry[]
    const k = Math.min(rng.int(1, 4), nonNull)
    const cap = Math.max(1, Math.floor(nonNull / k))
    return rng
      .shuffle(VALUE_POOL)
      .slice(0, Math.min(k, VALUE_POOL.length))
      .map((value) => ({
        value,
        count: rng.int(1, cap),
      }))
  }
  const nonNullA = rng.int(1, 5000)
  const nonNullB = rng.int(1, 5000)
  return {
    nonNullA,
    nonNullB,
    topKA: gen(nonNullA),
    topKB: gen(nonNullB),
  }
}
