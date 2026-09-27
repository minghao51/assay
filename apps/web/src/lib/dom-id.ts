// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Injective DOM-id and tree-path encoding (AR-W11 grammar, shared app-wide).
 *
 * Dataset-derived text — column names, record keys, node paths — can contain
 * any code point, and the old `[^A-Za-z0-9_-] → -` sanitizing mapping was
 * **lossy**: `a.b` and `a-b` both became `a-b`, so two siblings produced the
 * same DOM id and one `aria-controls`/`htmlFor` pointed at the other node.
 * `encodeIdText` encodes **every** code point as hex joined by `-`; because a
 * hex run can never contain `-`, the join is unambiguous and the encoding is
 * injective, so distinct inputs always yield distinct ids. Ids are
 * intentionally opaque and stable across renders.
 *
 * `encodePathSegment`/`encodePath` extend the same discipline to the record
 * inspector's *expansion keys* (AR-W11's sibling bug, S4): keys used to be
 * joined raw as `` `${path}/${child.key}` ``, so a struct key literally named
 * `x/y` was indistinguishable from a child `y` of `x` and toggling one
 * expanded the other. Safe segments (`[A-Za-z0-9_-]+`) pass through so familiar
 * paths stay readable; anything else is prefixed with `~` (outside the safe
 * set) and hex-encoded. Neither form can contain `/`, so joining the encoded
 * segments with `/` is unambiguous.
 *
 * Call sites: `FilterBar.tsx` (filter-input ids), `SchemaPanel.tsx`
 * (schema-field ids AND struct/union expansion keys) and
 * `RecordInspector.tsx` + `record-tree.ts` (record-node ids and expansion
 * keys).
 */

/** Hex-encode every code point, joining with `-` (injective; lone surrogates ok). */
export function encodeIdText(value: string): string {
  return Array.from(value, (char) => (char.codePointAt(0) ?? 0).toString(16)).join('-')
}

/** Build a prefixed, DOM-id-safe, injective id from untrusted text. */
export function domId(prefix: string, value: string): string {
  return `${prefix}-${encodeIdText(value)}`
}

/** One tree-path segment: safe segments pass through, others become `~`+hex. */
export function encodePathSegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : `~${encodeIdText(segment)}`
}

/** Join path segments into an unambiguous expansion key (`/` is only a separator). */
export function encodePath(segments: readonly string[]): string {
  return segments.map(encodePathSegment).join('/')
}
