import { describe, expect, it } from 'vitest'
import { MAX_RANGE_ROWS, validateRowWindow } from './range-window'

describe('validateRowWindow (M1-4: visible-window sized range fetches)', () => {
  it('accepts a well-formed window unchanged', () => {
    expect(validateRowWindow(0, 50)).toEqual({
      valid: true,
      startRow: 0,
      endRow: 50,
      clamped: false,
    })
    expect(validateRowWindow(120, 180)).toEqual({
      valid: true,
      startRow: 120,
      endRow: 180,
      clamped: false,
    })
  })

  it('accepts an empty window (schema-only fetch beyond the data end)', () => {
    expect(validateRowWindow(10, 10)).toEqual({
      valid: true,
      startRow: 10,
      endRow: 10,
      clamped: false,
    })
  })

  it('clamps oversized windows to MAX_RANGE_ROWS instead of rejecting', () => {
    const result = validateRowWindow(0, 10_000_000)
    expect(result).toEqual({
      valid: true,
      startRow: 0,
      endRow: MAX_RANGE_ROWS,
      clamped: true,
    })
    // The clamp is relative to the start (OFFSET must stay intact).
    expect(validateRowWindow(5000, 9000)).toEqual({
      valid: true,
      startRow: 5000,
      endRow: 5000 + MAX_RANGE_ROWS,
      clamped: true,
    })
  })

  it('does not clamp a window exactly at the cap', () => {
    expect(validateRowWindow(0, MAX_RANGE_ROWS)).toEqual({
      valid: true,
      startRow: 0,
      endRow: MAX_RANGE_ROWS,
      clamped: false,
    })
  })

  it('rejects negative, non-integer, and unsafe bounds (caller bugs are not repaired)', () => {
    expect(validateRowWindow(-1, 5).valid).toBe(false)
    expect(validateRowWindow(0, -5).valid).toBe(false)
    expect(validateRowWindow(1.5, 5).valid).toBe(false)
    expect(validateRowWindow(0, 2.5).valid).toBe(false)
    expect(validateRowWindow(Number.NaN, 5).valid).toBe(false)
    expect(validateRowWindow(Number.POSITIVE_INFINITY, 5).valid).toBe(false)
    expect(validateRowWindow(0, Number.MAX_SAFE_INTEGER + 1).valid).toBe(false)
    // Non-numeric junk from across the boundary.
    expect(validateRowWindow('0', 5).valid).toBe(false)
    expect(validateRowWindow(undefined, 5).valid).toBe(false)
    expect(validateRowWindow(null, 5).valid).toBe(false)
  })

  it('rejects inverted windows', () => {
    const result = validateRowWindow(10, 5)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('endRow')
    }
  })

  it('rejects invalid windows with a human-readable reason, clamps carry no reason', () => {
    const invalid = validateRowWindow('x', 1)
    expect(invalid.valid).toBe(false)
    if (!invalid.valid) expect(invalid.reason).toBeTruthy()
    const clamped = validateRowWindow(0, Number.MAX_SAFE_INTEGER)
    if (clamped.valid) expect(clamped.clamped).toBe(true)
  })
})
