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
 *
 * The `genHostile*` generators additionally weave in the hostile *shapes*
 * that JSON-ish value corruption cannot reach (a totality sweep over plain
 * corrupted values never detonates a getter, so it cannot detect a totality
 * regression — the m6-0 fix-round lesson): array Proxies whose traps throw,
 * object Proxies that explode on every read, throwing getters on structural
 * fields (array indices, length-like counts, payloads), and values whose
 * `Symbol.toPrimitive`/`toString`/`valueOf` all throw. Weaving is optional
 * (pass a `HostileShapeCounts` spy) and counted per draw, so the property
 * suites can pin non-vacuity **per hostile family** — the suite fails if a
 * run stops producing any of them. The family totals over the pinned seeds
 * are deterministic (mulberry32: pure integer arithmetic, platform-exact),
 * so the pins are EXACT counts, not lower bounds — disabling any single
 * weave (or otherwise drifting the generators) changes at least one total
 * and fails the suite (the fix-round-2 drill, run for every weave).
 *
 * Two further fixtures cover the reflective-throw class itself (used by the
 * dedicated pins, not the woven draws): {@link makeRevokedProxy} — a Proxy
 * whose `revoke()` has fired, on which even `Array.isArray` throws (`IsArray`
 * on a revoked Proxy is a TypeError) — and {@link makeAllTrapsProxy} — a
 * Proxy where EVERY handler trap throws (`get`, `ownKeys`,
 * `getOwnPropertyDescriptor`, …), so spreads, `Object.keys/values/entries`,
 * `JSON.stringify` and iteration all detonate, not just property reads.
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
 * Counters for the hostile-shape families the generators weave into a draw
 * (see the factories below). The totality suites pass a fresh spy per draw
 * and pin the run totals: a run that stops producing *any* family fails the
 * suite — the m5-5 non-vacuity lesson applied to the hostile domain itself.
 * JSON-ish value corruption (the original generator) cannot detect a
 * totality regression, because it never detonates a getter, a Proxy trap,
 * or a stringification path.
 */
export interface HostileShapeCounts {
  /** Array Proxies whose traps throw (they pass `Array.isArray`). */
  proxyArrays: number
  /** Object Proxies whose `get` trap throws on every read. */
  explodingObjects: number
  /** Plain objects carrying one or more throwing getters. */
  throwingGetters: number
  /** Values whose `Symbol.toPrimitive`/`toString`/`valueOf` all throw. */
  unstringifiable: number
}

/** A fresh zeroed spy for one generated draw. */
export function makeHostileShapeSpy(): HostileShapeCounts {
  return { proxyArrays: 0, explodingObjects: 0, throwingGetters: 0, unstringifiable: 0 }
}

function weave<T>(
  rng: TestRng,
  spy: HostileShapeCounts | undefined,
  family: keyof HostileShapeCounts,
  p: number,
  make: () => T,
): T | undefined {
  if (!rng.bool(p)) return undefined
  if (spy !== undefined) spy[family] += 1
  return make()
}

/**
 * Guarded field write for building hostile column entries: the thrown-getter
 * weaves install getter-only properties, and a later corruption writing the
 * same field would throw a TypeError *in the generator* — the corruption is
 * already there, so the write is skipped.
 */
function setField(target: Record<string, unknown>, key: string, value: unknown): void {
  try {
    target[key] = value
  } catch {
    // getter-only hostile property — the corruption stands
  }
}

/**
 * A value that detonates on every stringification path: `String(value)` —
 * via `Symbol.toPrimitive`, `toString`, or `valueOf` — throws. Hostile
 * coercion shapes like this are why issue *construction* must never route
 * through the offending value (the never-echo discipline's totality half).
 */
export function makeUnstringifiable(): unknown {
  const boom = (): never => {
    throw new Error('stringification exploded')
  }
  return { [Symbol.toPrimitive]: boom, toString: boom, valueOf: boom }
}

/**
 * A plain object with a throwing getter on `field` (the remaining fields
 * stay readable): unguarded property access throws, a guarded read
 * (`readField`) degrades. Used for structural fields — array indices,
 * `length`-like counts, entry payloads — so the model's field guards are
 * what stands between the caller and the throw.
 */
export function makeThrowingGetter(field: string, rest: Record<string, unknown> = {}): unknown {
  const hostile: Record<string, unknown> = { ...rest }
  Object.defineProperty(hostile, field, {
    get() {
      throw new Error(`getter '${field}' exploded`)
    },
    enumerable: true,
    configurable: true,
  })
  return hostile
}

/**
 * An array Proxy that passes `Array.isArray` but detonates on every element
 * access: `length`, numeric indices, the iterator, and array methods all
 * throw. This is the shape `Array.isArray`-then-iterate code cannot survive.
 */
export function makeProxyArray(): unknown {
  const boom = (): never => {
    throw new Error('array getter exploded')
  }
  return new Proxy([] as unknown[], {
    get(_target, prop) {
      if (prop === 'then') return undefined // never thenable: keeps inspection paths plain
      boom()
    },
  })
}

/** An object Proxy whose `get` trap throws on every read. */
export function makeProxyObject(): unknown {
  const boom = (): never => {
    throw new Error('object getter exploded')
  }
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'then') return undefined
      boom()
    },
  })
}

/**
 * A Proxy whose `revoke()` has already fired (array target, so it is the
 * exact shape the reviewer's probe used). Every internal-method access on a
 * revoked Proxy throws — including `Array.isArray`, because the spec's
 * `IsArray` reaches for the (now-unavailable) target state. This is the
 * one hostile shape a throwing-`get` Proxy cannot model: the trap table
 * itself is gone, so *any* reflection, guarded or not, detonates.
 */
export function makeRevokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable([] as unknown[], {})
  revoke()
  return proxy
}

/**
 * A Proxy over an array target where EVERY handler trap throws: `get`,
 * `set`, `has`, `deleteProperty`, `ownKeys`, `apply`, `construct`,
 * `getPrototypeOf`, `setPrototypeOf`, `isExtensible`, `preventExtensions`,
 * `getOwnPropertyDescriptor`, `defineProperty`. It still answers `true` to
 * `Array.isArray` (IsArray inspects the target, not the traps), so an
 * `isArray`-then-reflect code path gets past the check and then detonates
 * on whatever it touches next: a spread, `Object.keys/values/entries`,
 * `JSON.stringify`, `for…of`, `Array.from`, a `length` or indexed read.
 * The trap-throwing-at-every-step pin for the revoked-proxy class.
 */
export function makeAllTrapsProxy(): unknown {
  const boom = (): never => {
    throw new Error('trap exploded')
  }
  const handler = {
    getPrototypeOf: boom,
    setPrototypeOf: boom,
    isExtensible: boom,
    preventExtensions: boom,
    getOwnPropertyDescriptor: boom,
    defineProperty: boom,
    has: boom,
    get: boom,
    set: boom,
    deleteProperty: boom,
    ownKeys: boom,
    apply: boom,
    construct: boom,
  }
  return new Proxy([] as unknown[], handler)
}

/**
 * Return a corrupted copy of a valid profile: each corruption point fires
 * with the documented probability, seeded — hostile input for the totality
 * sweep, never thrown at, always attributed. Beyond the JSON-ish value
 * corruption, hostile *shapes* are woven in (pass a spy to count them):
 * array Proxies over `columns`/`topK`, an object Proxy as the whole
 * profile, throwing getters on structural fields, and unstringifiable
 * values on fields whose messages echo them.
 */
export function genHostileProfile(rng: TestRng, spy?: HostileShapeCounts): unknown {
  const base = genValidProfile(rng)
  const profile: Record<string, unknown> = {
    rowCount:
      weave(rng, spy, 'unstringifiable', 0.05, makeUnstringifiable) ??
      (rng.bool(0.15) ? rng.pick([-1, NaN, 1.5, 'many', Infinity]) : base.rowCount),
    columns: base.columns.map((column) => {
      // A throwing getter on a structural field (issue + degrade, never a throw).
      const boomField = weave(rng, spy, 'throwingGetters', 0.1, () =>
        rng.pick(['name', 'type', 'kind', 'nullCount', 'numeric', 'categorical']),
      )
      const c: Record<string, unknown> =
        boomField !== undefined
          ? (makeThrowingGetter(boomField, { ...column }) as Record<string, unknown>)
          : { ...column }
      if (rng.bool(0.1)) setField(c, 'kind', rng.pick(['weird', 'NUMERIC', '', 42, null]))
      const weirdNullCount = weave(rng, spy, 'unstringifiable', 0.05, makeUnstringifiable)
      if (weirdNullCount !== undefined) setField(c, 'nullCount', weirdNullCount)
      else if (rng.bool(0.1))
        setField(c, 'nullCount', rng.pick([-1, base.rowCount + 5, NaN, 0.5, null]))
      if (rng.bool(0.08)) setField(c, 'distinctCount', rng.pick([-2, base.rowCount + 1, NaN]))
      if (rng.bool(0.1)) {
        try {
          delete c.kind // missing kind
        } catch {
          // hostile getter-only property — the corruption stands
        }
      }
      if (column.numeric !== undefined) {
        if (rng.bool(0.2))
          delete c.numeric // missing payload
        else {
          const stats: Record<string, unknown> = { ...column.numeric }
          const weirdMean = weave(rng, spy, 'unstringifiable', 0.06, makeUnstringifiable)
          if (weirdMean !== undefined) stats.mean = weirdMean
          else if (rng.bool(0.15)) stats.mean = rng.pick(HOSTILE_NUMBERS)
          const weirdStddev = weave(rng, spy, 'unstringifiable', 0.06, makeUnstringifiable)
          if (weirdStddev !== undefined) stats.stddev = weirdStddev
          else if (rng.bool(0.15)) stats.stddev = rng.pick([...HOSTILE_NUMBERS, -0.5])
          const explodingQuantiles = weave(rng, spy, 'explodingObjects', 0.05, makeProxyObject)
          if (explodingQuantiles !== undefined) setField(stats, 'quantiles', explodingQuantiles)
          else if (rng.bool(0.15))
            setField(
              stats,
              'quantiles',
              rng.pick([
                { p50: NaN, p90: 5, p95: 6, p99: 7 },
                { p50: 5, p90: 'nine', p95: 6, p99: 7 },
                { p50: 1, p90: 2, p95: 3 },
                'nope',
                null,
              ]),
            )
          setField(c, 'numeric', stats)
        }
      } else if (rng.bool(0.1)) {
        setField(c, 'numeric', {
          min: 0,
          max: 1,
          mean: 0.5,
          stddev: 0.1,
          quantiles: { p50: 0, p90: 1, p95: 1, p99: 1 },
        }) // payload on the wrong kind
      }
      if (column.categorical !== undefined) {
        if (rng.bool(0.2)) delete c.categorical
        else {
          const stats: Record<string, unknown> = { ...column.categorical }
          const topK = (column.categorical as CategoricalColumnStats).topK
          const proxyTopK = weave(rng, spy, 'proxyArrays', 0.12, makeProxyArray)
          if (proxyTopK !== undefined) {
            setField(stats, 'topK', proxyTopK)
          } else if (rng.bool(0.3) && topK.length > 0) {
            setField(
              stats,
              'topK',
              rng.pick([
                topK.map((e) => ({ value: e.value, count: 0 })),
                topK.map((e) => ({ value: e.value, count: -1 })),
                topK.map((e) => ({ value: e.value, count: NaN })),
                topK.map((e) => ({ value: e.value, count: 1.5 })),
                [...topK, { value: topK[0]?.value ?? 'x', count: 2 }], // duplicate value
                [...topK, { value: '__proto__', count: 2 }],
                'nope',
              ]),
            )
          } else if (topK.length > 0) {
            // an entry whose value detonates on stringification (total-echo path)
            const weirdValue = weave(rng, spy, 'unstringifiable', 0.25, makeUnstringifiable)
            if (weirdValue !== undefined) {
              setField(
                stats,
                'topK',
                topK.map((e, i) => ({
                  value: i === 0 ? (weirdValue as string) : e.value,
                  count: e.count,
                })),
              )
            }
          }
          setField(c, 'categorical', stats)
        }
      }
      return c
    }),
  }
  if (rng.bool(0.1)) {
    // duplicate a column (first-wins + issue); a hostile entry may detonate
    // on read (getter-only property) — skip the duplicate, the corruption stands
    const columns = profile.columns as Record<string, unknown>[]
    if (columns.length > 0) {
      try {
        columns.push({ ...(columns[0] as Record<string, unknown>) })
      } catch {
        // hostile getter fired during the spread — keep the entry as-is
      }
    }
  }
  const proxyColumns = weave(rng, spy, 'proxyArrays', 0.06, makeProxyArray)
  if (proxyColumns !== undefined) profile.columns = proxyColumns
  if (rng.bool(0.05)) profile.columns = rng.pick([null, 'nope', 42])
  const explodingProfile = weave(rng, spy, 'explodingObjects', 0.04, makeProxyObject)
  if (explodingProfile !== undefined) return explodingProfile
  if (rng.bool(0.05)) return rng.pick([null, 42, 'profile', []])
  return profile
}

/**
 * A hostile schema: valid entries corrupted (malformed entries, missing or
 * NUL-bearing names/types, duplicates, non-object entries) — plus the
 * hostile *shapes* (pass a spy to count them): throwing getters on entry
 * name/type, unstringifiable names, an array Proxy as the whole schema, and
 * an unstringifiable top-level schema (exercising the total echo in the
 * not-an-array message).
 */
export function genHostileSchema(rng: TestRng, spy?: HostileShapeCounts): unknown {
  const base = genValidSchema(rng)
  const schema: unknown[] = base.map((column) => {
    if (rng.bool(0.1)) return rng.pick([null, 42, 'column', [], {}])
    const c = { ...column }
    if (rng.bool(0.08)) c.name = rng.pick(['', 'na\u0000me', '__proto__'])
    if (rng.bool(0.08)) c.type = rng.pick(['', 'ty\u0000pe'])
    const boomField = weave(rng, spy, 'throwingGetters', 0.08, () => rng.pick(['name', 'type']))
    if (boomField !== undefined) return makeThrowingGetter(boomField, c)
    const weirdName = weave(rng, spy, 'unstringifiable', 0.05, makeUnstringifiable)
    if (weirdName !== undefined) c.name = weirdName as string
    return c
  })
  if (base.length > 0 && rng.bool(0.15)) schema.push({ ...base[0], type: 'DOUBLE' }) // duplicate name
  const proxySchema = weave(rng, spy, 'proxyArrays', 0.08, makeProxyArray)
  if (proxySchema !== undefined) return proxySchema
  if (rng.bool(0.05)) return rng.pick([null, 42, 'schema', {}])
  const unstringifiable = weave(rng, spy, 'unstringifiable', 0.04, makeUnstringifiable)
  if (unstringifiable !== undefined) return unstringifiable
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
