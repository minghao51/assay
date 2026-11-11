// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact-precision temporal display for scalar grid cells (WF-01, WFD-06 = B).
 *
 * A measured probe of the real engine (DuckDB-WASM → Arrow 17, recorded in
 * `docs/reviews/2026-11-10-wf01p-temporal-matrix.md`) observed **zero** `Date`
 * payloads in 152 cells: the Arrow→rows projection hands the main thread
 *
 * - `DATE` as an integral number of **epoch milliseconds** (`1709164800000`);
 * - `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS` and
 *   `TIMESTAMP WITH TIME ZONE` as a number of **epoch milliseconds** that is
 *   often **fractional** (`1709214312123.456`, i.e. the delivered µs folded
 *   into a float ms), so `formatCell`'s `value instanceof Date` branch never
 *   fired and every typed temporal cell rendered as a raw number;
 * - `TIME` / `TIME WITH TIME ZONE` as a **bigint of microseconds since
 *   midnight** (`49512123456n`) — never an instant, never a date.
 *
 * The approved contract (approval record §9) is: render UTC, deterministic,
 * ISO-like text at the **exactly delivered** precision, and fall back to the
 * raw delivered text whenever that precision is not exactly recoverable — never
 * truncate, never round to a fabricated instant, never throw.
 *
 * | family    | delivered                       | render                                     |
 * | --------- | ------------------------------- | ------------------------------------------ |
 * | date      | epoch ms (integral)             | `YYYY-MM-DD` (UTC)                         |
 * | timestamp | epoch ms (may be fractional)    | `YYYY-MM-DDTHH:mm:ss[.SSS[SSS]]Z` (UTC)     |
 * | time      | µs since midnight (bigint)       | `HH:mm:ss[.SSSSSS]`                        |
 *
 * Exactness rules (the whole point of option B over the editor's ms-only
 * draft):
 *
 * - Timestamps are decoded through `us = Math.round(ms * 1000)`, and **only**
 *   when `ms * 1000` is exactly integral. `TIMESTAMP_NS` delivers
 *   `1709214312123.4568`, whose `× 1000` is not integral (ns are already lost
 *   inside the float ms), so it keeps its raw text instead of pretending to a
 *   precision the transport does not carry.
 * - The calendar/clock fields come from `new Date(floor(ms))` — **never** from
 *   a fractional millisecond, because `new Date(0.4)` silently truncates.
 *   The sub-millisecond remainder is appended explicitly, which is what makes
 *   `-0.001` render `1969-12-31T23:59:59.999999Z` instead of snapping to
 *   `1970-01-01T00:00:00.000Z`.
 * - The fraction **width** follows the value, not the column type: `.123000`
 *   renders `.123Z`, `.123456` renders `.123456Z`, and a whole second carries
 *   no fraction at all.
 *
 * Scope (approval record §9): scalar grid cells and the focused display-value
 * copy — both compose through `formatCell`, so they can never diverge. Raw
 * rows, overlay data, editor drafts, filters, casts and export are untouched;
 * nested previews, the Record tree and untyped SQL results intentionally keep
 * their raw temporals (WF-O2).
 *
 * Total by construction: every unrecognized shape returns `null` so the caller
 * keeps its existing formatting path. Nothing here reads the host timezone, the
 * locale or `Intl`, and no dataset value is ever logged (ADR 0025).
 */
import type { DuckDbType } from '../schema/parseType'

/** The display family a declared/parsed column type belongs to. */
export type TemporalDisplayFamily = 'date' | 'timestamp' | 'time'

/** Microseconds per millisecond — the delivered ms → µs recovery factor. */
const US_PER_MS = 1_000
/** Microseconds per second (the width of the `time` fraction). */
const US_PER_SECOND = 1_000_000
/** Microseconds per day — a `TIME` value outside `[0, this)` is not a time. */
const US_PER_DAY = 86_400_000_000
/** JS `Date`'s maximum magnitude in milliseconds (±100 000 000 days). */
const MAX_DATE_MS = 8.64e15
/** `new Date(ms).toISOString()` for a 4-digit year, e.g. `2024-02-29T13:45:12.123Z`. */
const ISO_MS_LENGTH = 24

/**
 * The leading keyword of a parsed primitive label: `DECIMAL(21,1)` →
 * `DECIMAL`, `TIMESTAMP WITH TIME ZONE` → `TIMESTAMP`, `TIME WITH TIME ZONE` →
 * `TIME`. `parseDuckDbType` only produces `primitive` labels for these, so the
 * split is total.
 */
function primitiveBase(label: string): string {
  return label.trim().toUpperCase().split(/[\s(]/)[0] ?? ''
}

/**
 * Classify a parsed column type into its display family, or `null` when the
 * column is not a temporal scalar (composites, unknown leaves, `INTERVAL` and
 * every ordinary numeric/text type stay on their existing paths).
 *
 * The label set is the one the engine actually delivers plus its documented
 * aliases: `DATE`; `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS`,
 * `TIMESTAMP WITH TIME ZONE` (the engine prints this — `TIMESTAMPTZ` never
 * appears in a delivered schema) and `DATETIME`; `TIME`, `TIME WITH TIME ZONE`
 * and `TIMETZ`.
 */
export function temporalDisplayFamily(type: DuckDbType | null): TemporalDisplayFamily | null {
  if (type === null || type.kind !== 'primitive') return null
  const base = primitiveBase(type.label)
  if (base === 'DATE') return 'date'
  if (base === 'TIME' || base === 'TIMETZ') return 'time'
  if (base === 'DATETIME' || base.startsWith('TIMESTAMP')) return 'timestamp'
  return null
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function pad3(value: number): string {
  return String(value).padStart(3, '0')
}

/** The UTC calendar day of an epoch-ms `DATE` payload, or `null`. */
function formatDateDisplay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  if (Math.abs(ms) > MAX_DATE_MS) return null
  // A `DATE` is a whole day, so a fractional payload is a contradiction — the
  // honest answer is the raw number, never a silently truncated day.
  if (!Number.isInteger(ms)) return null
  const iso = new Date(ms).toISOString()
  // Beyond year 9999 `toISOString()` switches to `±YYYYYY`; that layout is not
  // part of the approved `YYYY-MM-DD` contract, so the raw value stands.
  if (iso.length !== ISO_MS_LENGTH) return null
  return iso.slice(0, 10)
}

/**
 * The UTC ISO-like instant of an epoch-ms `TIMESTAMP` payload, or `null` when
 * the delivered precision is not exactly recoverable.
 */
function formatTimestampDisplay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  if (Math.abs(ms) > MAX_DATE_MS) return null
  // The recovery precondition: µs are exactly recoverable only when the
  // delivered milliseconds scale to a whole microsecond. `TIMESTAMP_NS`
  // payloads (and every other lossy delivery) fail this and stay raw.
  if (!Number.isInteger(ms * US_PER_MS)) return null
  // Floor to whole milliseconds for the calendar/clock fields and carry the
  // sub-millisecond remainder separately: `new Date(0.4)` would truncate, and
  // `new Date(-0.001)` would snap a pre-1970 value onto the epoch.
  let wholeMs = Math.floor(ms)
  // µs *inside* that millisecond (0…1000), recovered from the float remainder.
  // The remainder carries a few tens of nanoseconds of representation noise
  // (`…123.456` resolves to 456.0547 µs), so it is rounded to the nearest
  // microsecond — exactly the delivered precision the precondition above
  // guarantees, so nothing is invented and nothing delivered is lost.
  let micros = Math.round((ms - wholeMs) * US_PER_MS)
  // Float noise can present a whole sub-ms unit as `0.999999…`; carrying it
  // into the next millisecond keeps the two fields contiguous (never `:60`).
  if (micros >= US_PER_MS) {
    wholeMs += 1
    micros = 0
  }
  const iso = new Date(wholeMs).toISOString()
  if (iso.length !== ISO_MS_LENGTH) return null
  const base = iso.slice(0, 19) // YYYY-MM-DDTHH:mm:ss
  const millisText = iso.slice(20, 23) // SSS
  if (micros === 0) {
    return millisText === '000' ? `${base}Z` : `${base}.${millisText}Z`
  }
  return `${base}.${millisText}${pad3(micros)}Z`
}

/** The wall-clock time of a `TIME` payload (µs since midnight), or `null`. */
function formatTimeDisplay(value: unknown): string | null {
  let micros: number
  if (typeof value === 'bigint') {
    // A `TIME` is a wall-clock time: the day bound is the contract, and the
    // conversion is exact because the accepted range is far below 2^53.
    if (value < 0n || value >= BigInt(US_PER_DAY)) return null
    micros = Number(value)
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null
    micros = value
  } else {
    return null
  }
  if (micros < 0 || micros >= US_PER_DAY) return null
  const hours = Math.floor(micros / 3_600_000_000)
  const minutes = Math.floor((micros % 3_600_000_000) / 60_000_000)
  const seconds = Math.floor((micros % 60_000_000) / US_PER_SECOND)
  const fraction = micros % US_PER_SECOND
  const base = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
  return fraction === 0 ? base : `${base}.${String(fraction).padStart(6, '0')}`
}

/**
 * Format a scalar cell value for the parsed type at its position. Returns
 * `null` for non-temporal types and for every payload whose exact reading is
 * not recoverable (non-finite, out of range, non-integral, contradiction
 * between the declared family and the delivered shape), so `formatCell` keeps
 * today's raw `String(value)` text.
 *
 * A `Date` input is deliberately **not** handled here: `formatCell` keeps its
 * existing `toISOString()` branch for non-engine callers, byte for byte.
 */
export function formatTemporalForParsedType(
  value: unknown,
  type: DuckDbType | null,
): string | null {
  const family = temporalDisplayFamily(type)
  if (family === null) return null
  if (family === 'time') return formatTimeDisplay(value)
  if (typeof value !== 'number') return null
  return family === 'date' ? formatDateDisplay(value) : formatTimestampDisplay(value)
}
