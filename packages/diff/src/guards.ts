/**
 * Total-input discipline helpers (the m5-0/m5-1 hostile-input precedent).
 *
 * Every read of caller input in this package goes through these guards. The
 * aspect functions take *typed* parameters, but a caller bug behind a cast —
 * or a hostile object with throwing getters / an unreadable proxy — must
 * degrade to typed issues, never a throw and never inherited-member garbage
 * through the prototype (the m5-5 `__proto__`-spelling lesson). Column and
 * category matching in this package uses `Map`/`Set`, whose keys are inert;
 * plain objects are never used as lookup tables over input strings.
 *
 * Totality covers **iteration and stringification** too, not just field
 * reads: `Array.isArray` passes array Proxies whose traps throw, so every
 * element read over caller input goes through {@link readArray}'s snapshot,
 * and issue messages are built through {@link echoValue} because
 * `String(hostileValue)` can throw (a hostile `toString`/
 * `Symbol.toPrimitive`/`valueOf`, or `String(Object.create(null))`'s
 * TypeError). The error path itself never throws.
 */

/** Result of a guarded field read. */
export type GuardedRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/**
 * Read `target[key]` without ever throwing: a throwing getter, an exotic
 * proxy, or a non-object target degrades to `{ ok: false }`. Only
 * object-shaped targets are readable — field access is the only ingress
 * into caller input.
 */
export function readField(target: unknown, key: string): GuardedRead {
  try {
    if (target === null || typeof target !== 'object') return { ok: false }
    return { ok: true, value: (target as Record<string, unknown>)[key] }
  } catch {
    return { ok: false }
  }
}

/** Guarded two-step read (`target[k1][k2]`); any failed step is `{ ok: false }`. */
export function readFieldPath(target: unknown, k1: string, k2: string): GuardedRead {
  const first = readField(target, k1)
  return first.ok ? readField(first.value, k2) : { ok: false }
}

/**
 * Guarded element read of caller-supplied input: a plain snapshot of the
 * elements, or `null` when the value is not an array or cannot be read
 * (`Array.isArray` passes array Proxies whose traps throw — `length`, an
 * index, or the iterator can all be hostile). A throw at any point during
 * the snapshot marks the *whole* array unreadable: callers never iterate
 * caller input directly, and never see a partial view (which would make a
 * hostile report depend on where the trap fired).
 */
export function readArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null
    return Array.from(value)
  } catch {
    return null
  }
}

/**
 * Total description of a value for issue messages — building the message
 * must never throw, so this never routes through the value's own
 * `toString`/`Symbol.toPrimitive`/`valueOf` (a hostile one throws by
 * design) and never stringifies objects (`String(Object.create(null))` is
 * a TypeError). Primitives keep their exact rendering — for numbers via
 * {@link echoNumber}, so the never-echo convention is unchanged; strings
 * are quoted (mirroring `@assay/validation`'s option-value rendering).
 */
export function echoValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return `'${value}'`
    case 'number':
      return echoNumber(value)
    case 'bigint':
    case 'boolean':
      return String(value)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (value === null) return 'null'
      return Array.isArray(value)
        ? 'an array (no safe string form)'
        : 'an object (no safe string form)'
    default:
      return `a ${typeof value} value` // function or symbol
  }
}

/** `true` iff `value` is a finite number (NaN, ±Infinity, and other types are not). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Finite, non-negative real number (counts before integer checks). */
export function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

/** Safe non-negative integer — every count in a well-formed profile. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0
}

/**
 * Normalize `-0` to `+0` so outputs are JSON-stable (`JSON.stringify`
 * renders both as `0`, but structured equality and byte pins should never
 * see the difference in the first place).
 */
export function normZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

/**
 * Exact echo of a number for issue messages: `String(value)` is the
 * shortest exact rendering of a double. Messages never re-format, round,
 * or otherwise mangle an offending value (the m5-0 never-echo lesson).
 */
export function echoNumber(value: number): string {
  return String(value)
}
