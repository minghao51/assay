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
