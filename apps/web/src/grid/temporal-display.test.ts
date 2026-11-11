// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, it } from 'vitest'
import { parseDuckDbType } from '../schema/parseType'
import { formatCell } from './format'
import { formatTemporalForParsedType, temporalDisplayFamily } from './temporal-display'

/**
 * wf-01 (WFD-06 = B) unit matrix for exact-precision temporal display.
 *
 * Every literal below is the **observed** delivery shape from the read-only
 * WF-01P probe of the real engine (DuckDB-WASM → Arrow 17,
 * `docs/reviews/2026-11-10-wf01p-temporal-matrix.md` §2): `DATE`/`TIMESTAMP*`
 * cross as epoch **millisecond** numbers (fractional when the column carries
 * µs), `TIME` crosses as a **bigint of microseconds since midnight**, and no
 * payload is ever a `Date`. The expected strings are the approved approval
 * record §9 contract, not whatever the implementation happens to produce.
 *
 * The two rules that are easy to get wrong and are pinned hardest here:
 * 1. the fraction **width** follows the value (`.123Z` vs `.123456Z`), and
 * 2. a fractional millisecond is **never** handed to `new Date(...)` — the
 *    pre-1970 `-0.001` case proves the floor-plus-remainder split.
 */

const date = (label: string) => parseDuckDbType(label)
const formatted = (value: unknown, label: string) => formatTemporalForParsedType(value, date(label))

describe('temporalDisplayFamily — which declared labels map to which family', () => {
  it('classifies every delivered temporal label and its aliases', () => {
    for (const label of ['DATE']) expect(temporalDisplayFamily(date(label))).toBe('date')
    for (const label of [
      'TIMESTAMP',
      'TIMESTAMP_S',
      'TIMESTAMP_MS',
      'TIMESTAMP_NS',
      'TIMESTAMP WITH TIME ZONE',
      'TIMESTAMPTZ',
      'DATETIME',
      'timestamp with time zone',
      'DATETIME(6)',
    ]) {
      expect(temporalDisplayFamily(date(label)), label).toBe('timestamp')
    }
    for (const label of ['TIME', 'TIME WITH TIME ZONE', 'TIMETZ']) {
      expect(temporalDisplayFamily(date(label)), label).toBe('time')
    }
  })

  it('leaves every non-temporal family unclaimed', () => {
    for (const label of [
      'BIGINT',
      'UBIGINT',
      'HUGEINT',
      'DECIMAL(18,6)',
      'DOUBLE',
      'INTEGER',
      'VARCHAR',
      'BOOLEAN',
      'INTERVAL',
      'BLOB',
      'UUID',
      'STRUCT("ts" TIMESTAMP)',
      'TIMESTAMP[]',
      'MAP(VARCHAR, DATE)',
    ]) {
      expect(temporalDisplayFamily(date(label)), label).toBeNull()
    }
    expect(temporalDisplayFamily(null)).toBeNull()
  })
})

describe('DATE — YYYY-MM-DD in UTC', () => {
  it('renders the calendar day for the engine epoch-ms payload', () => {
    expect(formatted(1709164800000, 'DATE')).toBe('2024-02-29') // leap day
    expect(formatted(0, 'DATE')).toBe('1970-01-01') // epoch
    expect(formatted(-86400000, 'DATE')).toBe('1969-12-31') // pre-1970
    expect(formatted(253402214400000, 'DATE')).toBe('9999-12-31') // last 4-digit year
  })

  it('keeps the raw number when the day is not representable', () => {
    // Beyond JS `Date`'s ±8.64e15 ms range (DuckDB `DATE '275761-01-01'`).
    expect(formatted(8640009504000000, 'DATE')).toBeNull()
    expect(formatted(185542587100800000, 'DATE')).toBeNull() // unsafe/infinity-ish
    expect(formatted(-185542587100800000, 'DATE')).toBeNull()
    expect(formatted(86400000.5, 'DATE')).toBeNull() // a day is never fractional
    expect(formatted(Number.NaN, 'DATE')).toBeNull()
    expect(formatted(Number.POSITIVE_INFINITY, 'DATE')).toBeNull()
  })
})

describe('TIMESTAMP — UTC ISO-like at the exactly delivered precision', () => {
  it('renders the three fraction widths from the value, not the column type', () => {
    // Whole second: no fraction at all (`TIMESTAMP_S` and any µs-free value).
    expect(formatted(1709214312000, 'TIMESTAMP_S')).toBe('2024-02-29T13:45:12Z')
    expect(formatted(1709214312000, 'TIMESTAMP')).toBe('2024-02-29T13:45:12Z')
    // Milliseconds only: three digits.
    expect(formatted(1709214312123, 'TIMESTAMP_MS')).toBe('2024-02-29T13:45:12.123Z')
    // Microseconds: six digits (the observed `TIMESTAMP` delivery).
    expect(formatted(1709214312123.456, 'TIMESTAMP')).toBe('2024-02-29T13:45:12.123456Z')
    // The width is a property of the VALUE in one and the same column type.
    expect(formatted(1709214312123.456, 'TIMESTAMP')).toBe('2024-02-29T13:45:12.123456Z')
    expect(formatted(1709214312123, 'TIMESTAMP')).toBe('2024-02-29T13:45:12.123Z')
    expect(formatted(1709214312000, 'TIMESTAMP')).toBe('2024-02-29T13:45:12Z')
    // A trailing-zero microsecond part is NOT shown as six digits.
    expect(formatted(1709214312123.5, 'TIMESTAMP')).toBe('2024-02-29T13:45:12.123500Z')
  })

  it('renders leap-day and midnight instants', () => {
    expect(formatted(1709164800000, 'TIMESTAMP')).toBe('2024-02-29T00:00:00Z')
    expect(formatted(1709164800123, 'TIMESTAMP')).toBe('2024-02-29T00:00:00.123Z')
  })

  it('renders the UTC instant for a zoned column (never the original offset)', () => {
    // `2024-02-29 13:45:12.123456+05:30` → the engine delivers the UTC instant.
    expect(formatted(1709194512123.456, 'TIMESTAMP WITH TIME ZONE')).toBe(
      '2024-02-29T08:15:12.123456Z',
    )
    expect(formatted(1709194512123.456, 'TIMESTAMPTZ')).toBe('2024-02-29T08:15:12.123456Z')
  })

  it('never snaps a pre-1970 sub-millisecond value onto the epoch', () => {
    // The rejected `new Date(ms)` decode renders `1970-01-01T00:00:00.000Z`
    // here; the approved contract is the exact instant (approval record §9).
    expect(formatted(-0.001, 'TIMESTAMP')).toBe('1969-12-31T23:59:59.999999Z')
    expect(formatted(-1, 'TIMESTAMP')).toBe('1969-12-31T23:59:59.999Z')
    expect(formatted(-1709214312123.456, 'TIMESTAMP')).toBe('1915-11-03T10:14:47.876544Z')
  })

  it('keeps the raw number when the delivered precision is not exactly recoverable', () => {
    // `TIMESTAMP_NS`: ns are already lost inside the float ms, so `ms * 1000`
    // is not integral — the approved fallback is the raw delivered number.
    expect(formatted(1709214312123.4568, 'TIMESTAMP_NS')).toBeNull()
    expect(formatted(-0.000001, 'TIMESTAMP_NS')).toBeNull()
    expect(formatted(Number.NaN, 'TIMESTAMP')).toBeNull()
    expect(formatted(Number.POSITIVE_INFINITY, 'TIMESTAMP')).toBeNull()
    expect(formatted(8640009504000000, 'TIMESTAMP')).toBeNull()
    // A shape mismatch (a bigint in a timestamp column) is not recovered.
    expect(formatted(1709214312123n, 'TIMESTAMP')).toBeNull()
    expect(formatted('2024-02-29T13:45:12Z', 'TIMESTAMP')).toBeNull()
  })
})

describe('TIME — HH:mm:ss[.SSSSSS] from microseconds since midnight', () => {
  it('renders the wall clock, never an instant and never a date', () => {
    expect(formatted(49512123456n, 'TIME')).toBe('13:45:12.123456')
    expect(formatted(0n, 'TIME')).toBe('00:00:00') // midnight
    expect(formatted(500000n, 'TIME')).toBe('00:00:00.500000')
    expect(formatted(86399999999n, 'TIME')).toBe('23:59:59.999999')
    expect(formatted(45_296_000_000n, 'TIME')).toBe('12:34:56')
    // The zoned spelling carries the same µs payload (the offset is not in it).
    expect(formatted(49512123456n, 'TIME WITH TIME ZONE')).toBe('13:45:12.123456')
    expect(formatted(49512123456n, 'TIMETZ')).toBe('13:45:12.123456')
    // A number µs payload (a defensive shape) reads the same.
    expect(formatted(49512123456, 'TIME')).toBe('13:45:12.123456')
  })

  it('keeps the raw value outside a day or for a non-integral payload', () => {
    expect(formatted(-1n, 'TIME')).toBeNull()
    expect(formatted(86_400_000_000n, 'TIME')).toBeNull()
    expect(formatted(86_400_000_000, 'TIME')).toBeNull()
    expect(formatted(1.5, 'TIME')).toBeNull()
    expect(formatted('13:45:12', 'TIME')).toBeNull()
    expect(formatted(new Date('2026-01-02T03:04:05Z'), 'TIME')).toBeNull()
  })
})

describe('non-temporal and edge families stay exactly where they were', () => {
  it('leaves BIGINT/DECIMAL/DOUBLE/VARCHAR/BOOLEAN renders unchanged', () => {
    // A BIGINT that *looks* like epoch ms is an ordinary integer.
    expect(formatCell(1700000000000n, 'BIGINT')).toBe('1700000000000')
    expect(formatCell(9007199254740993n, 'BIGINT')).toBe('9007199254740993')
    expect(formatCell(1709251200.5, 'DOUBLE')).toBe('1709251200.5')
    expect(formatCell('2024-02-29 13:45:12', 'VARCHAR')).toBe('2024-02-29 13:45:12')
    expect(formatCell(true, 'BOOLEAN')).toBe('true')
  })

  it('leaves an untyped (SQL-pane) number raw — no declared type, no decode', () => {
    expect(formatCell(1709214312123.456)).toBe('1709214312123.456')
    expect(formatCell(49512123456n)).toBe('49512123456')
    expect(formatCell(-0.001)).toBe('-0.001')
  })

  it('leaves INTERVAL on its existing summary path', () => {
    expect(formatCell(new Uint8Array(8), 'INTERVAL')).toBe('<8 bytes>')
  })

  it('renders NULL in a temporal column as an empty cell', () => {
    for (const label of ['DATE', 'TIMESTAMP', 'TIMESTAMP_NS', 'TIMESTAMP WITH TIME ZONE', 'TIME']) {
      expect(formatCell(null, label), label).toBe('')
      expect(formatCell(undefined, label), label).toBe('')
    }
  })

  it('keeps the existing Date branch for a `Date` input (non-engine caller)', () => {
    const value = new Date('2026-01-02T03:04:05.000Z')
    expect(formatCell(value, 'TIMESTAMP')).toBe('2026-01-02T03:04:05.000Z')
    expect(formatCell(value)).toBe('2026-01-02T03:04:05.000Z')
  })

  it('renders temporal leaves inside a structure raw (WF-O2 boundary, unchanged)', () => {
    // Nested previews get no declared-type channel for their scalar leaves, so
    // a temporal inside a struct keeps its raw delivered number. Pinned so a
    // later row cannot silently widen the scope.
    expect(formatCell({ ts: 1709214312123.456 }, 'STRUCT("ts" TIMESTAMP)')).toBe(
      '{"ts":1709214312123.456}',
    )
  })
})

describe('the formatter is pure UTC and host-timezone independent', () => {
  const inputs = [1709214312123.456, 1709164800000, -0.001, 253402214400000] as const
  const labels = ['TIMESTAMP', 'DATE', 'TIMESTAMP', 'TIMESTAMP'] as const
  const expected = [
    '2024-02-29T13:45:12.123456Z',
    '2024-02-29',
    '1969-12-31T23:59:59.999999Z',
    '9999-12-31T00:00:00Z',
  ] as const
  const hostTz = process.env['TZ']

  afterAll(() => {
    if (hostTz === undefined) delete process.env['TZ']
    else process.env['TZ'] = hostTz
  })

  it('renders identical text under UTC and under extreme non-UTC zones', () => {
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kathmandu']) {
      process.env['TZ'] = tz
      for (const [index, input] of inputs.entries()) {
        expect(formatted(input, labels[index]!), `${tz}: ${String(input)}`).toBe(expected[index])
      }
    }
  })
})
