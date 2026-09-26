// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  decimalSpecForType,
  decodeDecimal128,
  formatDecimalValue,
  formatUnscaledDecimal,
} from './decimal'

/**
 * Build a 16-byte little-endian two's-complement Arrow decimal128 payload —
 * exactly the byte layout `Vector.get()` hands over for `DECIMAL(p,s)` (and
 * Arrow's `HUGEINT` → `Decimal(38,0)` mapping).
 */
function decimalBytes(unscaled: bigint): Uint8Array {
  const bytes = new Uint8Array(16)
  let value = unscaled
  if (value < 0n) value += 1n << 128n
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number(value & 0xffn)
    value >>= 8n
  }
  return bytes
}

describe('decimalSpecForType — recognize the 128-bit decimal-like column types', () => {
  it('reads precision and scale from DECIMAL/NUMERIC, tolerating whitespace', () => {
    expect(decimalSpecForType('DECIMAL(10,2)')).toEqual({ precision: 10, scale: 2 })
    expect(decimalSpecForType('DECIMAL(38, 9)')).toEqual({ precision: 38, scale: 9 })
    expect(decimalSpecForType('NUMERIC(5,0)')).toEqual({ precision: 5, scale: 0 })
  })

  it('applies the bare DECIMAL default and the HUGEINT mapping', () => {
    // DuckDB's bare DECIMAL default is (18,3).
    expect(decimalSpecForType('DECIMAL')).toEqual({ precision: 18, scale: 3 })
    // HUGEINT is exported as Arrow Decimal(38,0).
    expect(decimalSpecForType('HUGEINT')).toEqual({ precision: 38, scale: 0 })
  })

  it('returns null for every other type (never guesses)', () => {
    expect(decimalSpecForType('BIGINT')).toBeNull()
    expect(decimalSpecForType('VARCHAR')).toBeNull()
    expect(decimalSpecForType('BLOB')).toBeNull()
    expect(decimalSpecForType('UHUGEINT')).toBeNull()
    expect(decimalSpecForType('STRUCT("a" DECIMAL(10,2))')).toBeNull()
    expect(decimalSpecForType('not a type at all')).toBeNull()
  })
})

describe('decodeDecimal128 — exact, signed, offset-aware little-endian decode', () => {
  it('decodes zero with scale (no negative zero, full fraction)', () => {
    expect(decodeDecimal128(decimalBytes(0n), 2)).toBe('0.00')
    expect(decodeDecimal128(decimalBytes(0n), 0)).toBe('0')
  })

  it('decodes positive values with scale 0 and scale 2', () => {
    expect(decodeDecimal128(decimalBytes(42n), 0)).toBe('42')
    expect(decodeDecimal128(decimalBytes(5_200_000n), 2)).toBe('52000.00')
    expect(decodeDecimal128(decimalBytes(1_234_567n), 2)).toBe('12345.67')
  })

  it('decodes negative values (two\u2019s-complement sign extension)', () => {
    expect(decodeDecimal128(decimalBytes(-7n), 0)).toBe('-7')
    expect(decodeDecimal128(decimalBytes(-1_234_500n), 2)).toBe('-12345.00')
    expect(decodeDecimal128(decimalBytes(-1n), 2)).toBe('-0.01')
    // Sign bit set in the top byte: -2^127 must not decode as a huge positive.
    const minInt = decimalBytes(-(1n << 127n))
    expect(minInt[15]).toBe(0x80)
    expect(decodeDecimal128(minInt, 0)).toBe('-170141183460469231731687303715884105728')
  })

  it('pads leading zeros instead of dropping the leading fraction digit', () => {
    expect(decodeDecimal128(decimalBytes(5n), 2)).toBe('0.05')
    expect(formatUnscaledDecimal(5n, 4)).toBe('0.0005')
    expect(formatUnscaledDecimal(1_000n, 3)).toBe('1.000')
  })

  it('keeps large values beyond 2^53 exact (no float rounding)', () => {
    const large = 99_999_999_999_999_999_999_999_999_999_999_999_999n
    expect(decodeDecimal128(decimalBytes(large), 0)).toBe('99999999999999999999999999999999999999')
    const largeScaled = 12_345_678_901_234_567_890n
    expect(decodeDecimal128(decimalBytes(largeScaled), 2)).toBe('123456789012345678.90')
  })

  it('honors byteOffset (Arrow subarrays share the parent buffer)', () => {
    const parent = new Uint8Array(48)
    parent.set(decimalBytes(5_200_000n), 16)
    const view = new Uint8Array(parent.buffer, 16, 16)
    expect(decodeDecimal128(view, 2)).toBe('52000.00')
    // The real Arrow shape is a Uint32Array subclass; byte decoding must be
    // identical for it.
    const asUint32 = new Uint32Array(parent.buffer, 16, 4)
    expect(decodeDecimal128(asUint32, 2)).toBe('52000.00')
  })

  it('returns null for a non-128-bit payload rather than mis-decoding it', () => {
    expect(decodeDecimal128(new Uint8Array(8), 2)).toBeNull()
    expect(decodeDecimal128(new Uint8Array(0), 2)).toBeNull()
  })
})

describe('formatDecimalValue — type-gated, total', () => {
  it('decodes DECIMAL and HUGEINT payloads and leaves unrelated types alone', () => {
    expect(formatDecimalValue(decimalBytes(5_200_000n), 'DECIMAL(10,2)')).toBe('52000.00')
    expect(formatDecimalValue(decimalBytes(1n), 'HUGEINT')).toBe('1')
    expect(formatDecimalValue(decimalBytes(-5n), 'HUGEINT')).toBe('-5')
    // BLOB / UHUGEINT / UUID are not decimal-like: fall through untouched.
    expect(formatDecimalValue(new Uint8Array([1, 2, 3]), 'BLOB')).toBeNull()
    expect(formatDecimalValue(new Uint8Array(16), 'UHUGEINT')).toBeNull()
    expect(formatDecimalValue('123e4567', 'UUID')).toBeNull()
  })

  it('accepts a bigint payload and rejects unrecognized shapes', () => {
    expect(formatDecimalValue(12345n, 'DECIMAL(10,2)')).toBe('123.45')
    expect(formatDecimalValue('52000.00', 'DECIMAL(10,2)')).toBeNull()
    expect(formatDecimalValue(null, 'DECIMAL(10,2)')).toBeNull()
  })
})
