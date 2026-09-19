/**
 * Exact numeric intent for rule values (m5-0 round 2).
 *
 * v1 rule numbers (`min`/`max`, `allowed-values` entries, shares, integers)
 * are carried in the AST as JavaScript numbers. The YAML parser hands us the
 * *double nearest* to the written literal — silently: `9007199254740993`
 * arrives as `9007199254740992`, and the canonical serializer would then emit
 * that different constraint. For a format whose vocabulary includes
 * `BIGINT`/`HUGEINT`, silently rounding a bound is data corruption, so the
 * policy is **exact or rejected**: a written number is accepted only when the
 * double it parses to denotes the very same decimal the author wrote.
 *
 * The check compares *decimal* values (not doubles — everything compares
 * equal through a lossy parse): the literal is canonicalized into a unique
 * sign + significant-digits + exponent form and compared against the same
 * canonicalization of `String(value)` (the shortest decimal that round-trips
 * to the double — i.e. what the serializer would emit). Equal canonical
 * forms ⇔ the literal, the double, and the serialized bytes all carry one
 * value; otherwise the parse would have changed the contract.
 *
 * Not part of the public surface: exercised through `parseContract` (which
 * supplies the source text the literals are sliced from).
 *
 * Purity: pure string/number logic — no YAML, no React, no browser APIs.
 */

/**
 * Unique canonical form of a finite decimal: value =
 * (negative ? −1 : 1) × digits × 10^exponent, where `digits` is a decimal
 * integer string with no leading or trailing zeros — `'0'` (with exponent 0
 * and negative false) denotes zero itself, so `-0` and `0` share a form and
 * two forms are equal exactly when the values are.
 */
export interface CanonicalDecimal {
  readonly negative: boolean
  readonly digits: string
  readonly exponent: number
}

/**
 * A plain decimal literal: optional sign, digits with optional fraction
 * (`1`, `1.5`, `1.`, `.5`), optional exponent (`1e2`, `9.0e+15`). This is
 * the only spelling this format verifies; anything else (hexadecimal, tagged
 * scalars, underscores) fails closed — see {@link isExactDecimalLiteral}.
 */
const DECIMAL_LITERAL = /^([-+]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([-+]?\d+))?$/

/** Canonical decimal form of a literal text; `null` when it is not one. */
export function canonicalDecimal(text: string): CanonicalDecimal | null {
  const match = DECIMAL_LITERAL.exec(text.trim())
  if (match === null) return null
  const intPart = match[2] ?? ''
  const fracPart = (match[3] ?? '') + (match[4] ?? '')
  const explicitExponent = match[5] === undefined ? 0 : Number(match[5])
  let digits = (intPart + fracPart).replace(/^0+/, '')
  if (digits === '') return { negative: false, digits: '0', exponent: 0 } // ±0 is one value
  let exponent = explicitExponent - fracPart.length
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exponent += 1
  }
  return { negative: match[1] === '-', digits, exponent }
}

/**
 * Does the JS number faithfully represent the decimal the literal wrote?
 * `false` when the literal denotes a *different* decimal than the number's
 * canonical rendering (`'9007199254740993'` vs the double 9007199254740992)
 * — the silent-corruption case — and also when the literal is not a plain
 * decimal spelling at all (`'0x1F'`, a tagged scalar): exact intent cannot
 * be verified there, and unverifiable is rejected.
 */
export function isExactDecimalLiteral(raw: string, value: number): boolean {
  const written = canonicalDecimal(raw)
  if (written === null) return false
  const readBack = canonicalDecimal(String(value))
  if (readBack === null) return false // unreachable for finite numbers
  return (
    written.negative === readBack.negative &&
    written.digits === readBack.digits &&
    written.exponent === readBack.exponent
  )
}
