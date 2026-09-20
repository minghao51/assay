import { describe, expect, it } from 'vitest'
import { REPORT_DECIMALS, roundForReport } from './rounding'

/**
 * The ONE documented report-rounding convention: half away from zero at 6
 * fractional digits, `-0` normalized, non-finite passthrough. `0` rounds to
 * `0` — the identity pin survives rounding (pinned here and in the report
 * identity tests).
 */
describe('roundForReport — the documented convention', () => {
  it('rounds to 6 fractional digits (half away from zero)', () => {
    expect(roundForReport(0.27465307216702745)).toBe(0.274653)
    expect(roundForReport(1.2345678)).toBe(1.234568)
    expect(roundForReport(1.2345674)).toBe(1.234567)
    expect(roundForReport(2.5000005e-6)).toBe(3e-6) // half case, positive
    expect(roundForReport(-2.5000005e-6)).toBe(-3e-6) // half case, negative: away from zero
  })

  it('0 rounds to 0, and -0 never leaks', () => {
    expect(roundForReport(0)).toBe(0)
    expect(roundForReport(-0)).toBe(0)
    expect(Object.is(roundForReport(0), -0)).toBe(false)
  })

  it('tiny magnitudes collapse to exactly 0 (never -0)', () => {
    expect(roundForReport(-1e-9)).toBe(0)
    expect(roundForReport(1e-9)).toBe(0)
    expect(Object.is(roundForReport(-1e-9), -0)).toBe(false)
  })

  it('passes non-finite through (totality; model metrics are finite-or-null)', () => {
    expect(roundForReport(Infinity)).toBe(Infinity)
    expect(roundForReport(-Infinity)).toBe(-Infinity)
    expect(roundForReport(NaN)).toBeNaN()
  })

  it('does not lose huge magnitudes to the scaling step', () => {
    expect(roundForReport(1e300)).toBe(1e300)
  })

  it('exposes the documented digit count', () => {
    expect(REPORT_DECIMALS).toBe(6)
  })
})
