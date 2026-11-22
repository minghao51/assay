// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { formatCell } from './format'
import { parseDuckDbType } from '../schema/parseType'

describe('formatCell (total, deterministic DOM projection of cell values)', () => {
  it('formats scalars through String()', () => {
    expect(formatCell(123456n)).toBe('123456')
    expect(formatCell(1.5)).toBe('1.5')
    expect(formatCell('row-7')).toBe('row-7')
    expect(formatCell(false)).toBe('false')
  })

  it('renders NULL as an empty cell (row data-status distinguishes placeholders)', () => {
    expect(formatCell(null)).toBe('')
    expect(formatCell(undefined)).toBe('')
  })

  it('formats timestamps as ISO strings', () => {
    expect(formatCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
  })

  it('renders typed temporals from their delivered epoch-ms/µs payloads (wf-01)', () => {
    // The measured delivery (WF-01P §2): no payload is ever a `Date`, so the
    // `Date` branch above never fires for engine data. DATE/TIMESTAMP arrive as
    // epoch milliseconds (fractional when µs are carried); TIME as bigint µs.
    expect(formatCell(1709164800000, 'DATE')).toBe('2024-02-29')
    expect(formatCell(1709214312123.456, 'TIMESTAMP')).toBe('2024-02-29T13:45:12.123456Z')
    expect(formatCell(1709214312123, 'TIMESTAMP_MS')).toBe('2024-02-29T13:45:12.123Z')
    expect(formatCell(1709214312000, 'TIMESTAMP_S')).toBe('2024-02-29T13:45:12Z')
    expect(formatCell(49512123456n, 'TIME')).toBe('13:45:12.123456')
    // The lossy `TIMESTAMP_NS` delivery is not recoverable: raw number, never a
    // truncated instant.
    expect(formatCell(1709214312123.4568, 'TIMESTAMP_NS')).toBe('1709214312123.4568')
    // A parsed type tree passed by the grid behaves exactly like the string.
    expect(formatCell(1709214312123.456, undefined, parseDuckDbType('TIMESTAMP'))).toBe(
      '2024-02-29T13:45:12.123456Z',
    )
  })

  it('summarizes binary values without dumping bytes', () => {
    expect(formatCell(new Uint8Array([1, 2, 3]))).toBe('<3 bytes>')
  })

  it('decodes Arrow decimal payloads when the column type is supplied (m4-4 fix round)', () => {
    // Arrow's `DecimalBigNum` is a Uint32Array subclass: the binary fallback
    // used to summarize it as `<16 bytes>`. The type-gated decoder beats that.
    const payload = new Uint8Array(16)
    payload.set([0x80, 0x58, 0x4f, 0x00]) // 5_200_000 little-endian
    expect(formatCell(payload, 'DECIMAL(10,2)')).toBe('52000.00')
    expect(formatCell(new Uint32Array(payload.buffer), 'DECIMAL(10,2)')).toBe('52000.00')
    // HUGEINT shares the payload shape with scale 0.
    expect(formatCell(new Uint8Array(16).fill(0xff), 'HUGEINT')).toBe('-1')
    // Without the type the old binary summary is preserved.
    expect(formatCell(payload)).toBe('<16 bytes>')
  })

  it('renders UHUGEINT (Arrow FixedSizeBinary(16)) as its exact unsigned 128-bit value', () => {
    // Byte order is verified, not assumed: a probe of the pinned transport
    // (duckdb-wasm 1.32.0 / engine v1.4.3 / Arrow 17) returned these exact
    // little-endian payloads for `::UHUGEINT`. See `uhugeint.ts`.
    const littleEndian = (bytes: readonly number[]): Uint8Array => {
      const payload = new Uint8Array(16)
      payload.set(bytes)
      return payload
    }
    expect(formatCell(new Uint8Array(16), 'UHUGEINT')).toBe('0')
    expect(formatCell(littleEndian([0x01]), 'UHUGEINT')).toBe('1')
    // 2^64 - 1 sets the low eight bytes only.
    expect(
      formatCell(littleEndian([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 'UHUGEINT'),
    ).toBe('18446744073709551615')
    // 2^128 - 1 is the unsigned maximum (never `-1`: UHUGEINT is unsigned).
    expect(formatCell(new Uint8Array(16).fill(0xff), 'UHUGEINT')).toBe(
      '340282366920938463463374607431768211455',
    )
    // The parsed-tree form (the grid precomputes it per column) agrees.
    expect(formatCell(littleEndian([0x01]), undefined, parseDuckDbType('UHUGEINT'))).toBe('1')
    // Without the declared type the honest binary summary is preserved.
    expect(formatCell(littleEndian([0x01]))).toBe('<16 bytes>')
    // A payload of the wrong width is never mis-decoded.
    expect(formatCell(new Uint8Array(8), 'UHUGEINT')).toBe('<8 bytes>')
  })

  it('leaves the sibling byte-ish types on their existing paths (m4-4 audit)', () => {
    // UUID arrives as Arrow Utf8 (plain string).
    expect(formatCell('123e4567-e89b-12d3-a456-426614174000', 'UUID')).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    )
    // BLOB is Arrow Binary (Uint8Array) and stays a byte summary — including a
    // 16-byte BLOB, which must not borrow the UHUGEINT decoder.
    expect(formatCell(new Uint8Array([1, 2, 3, 4]), 'BLOB')).toBe('<4 bytes>')
    expect(formatCell(new Uint8Array(16).fill(0xff), 'BLOB')).toBe('<16 bytes>')
    // HUGEINT is signed Arrow Decimal(38,0) and keeps its own decoder.
    expect(formatCell(new Uint8Array(16).fill(0xff), 'HUGEINT')).toBe('-1')
  })

  it('formats nested struct/list values through the bounded nested preview (m3-2)', () => {
    // Same compact JSON text as before for small values — but now bounded.
    expect(formatCell({ name: 'n1', tags: ['x', 'y'] })).toBe('{"name":"n1","tags":["x","y"]}')
    // Depth-aware: the depth-3 leaf elides with an honest marker.
    expect(formatCell({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":…}}}')
    // Length-capped: a huge value can never flood the cell or a tooltip.
    const capped = formatCell({ s: 'x'.repeat(500) })
    expect(capped.length).toBe(120)
    expect(capped.endsWith('…')).toBe(true)
  })

  it('renders raw Arrow list slices (array-like {length, get}) as arrays (m3-2)', () => {
    // m3-1 worker-boundary contract: list cells arrive as Vector slices, not
    // Arrays — the preview must read them positionally.
    const slice = { length: 2, get: (index: number) => ['x', 'y'][index] }
    expect(formatCell(slice)).toBe('["x","y"]')
  })
})
