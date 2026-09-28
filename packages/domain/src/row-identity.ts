// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Logical row identity for the edit overlay (m4-1).
 *
 * ADR 0011 makes dataset identity logical, not file-based, and ADR 0012 adds:
 * "stable row identity is required; temporary positional row numbers are not
 * durable identity." The M4 queue (docs/process/handoff.md §6, m4-1 scoping
 * note) rules the implementation mechanism *within* those ADRs — no new ADR:
 *
 *   stable logical row ids = base-row anchor + overlay insert sequence
 *
 * - **Base rows** are anchored to the immutable base dataset version (ADR
 *   0011): `baseRowId(baseAnchor, ordinal)` where `ordinal` is the row's
 *   position in the *base version itself* (its natural file/table order),
 *   computed once when the overlay is opened. The id is never derived from a
 *   sort/filter/window position, so it survives re-sorting, re-filtering and
 *   window refreshes; the base version is immutable, so the ordinal can never
 *   drift underneath the id within a session.
 * - **Inserted rows** are assigned from the overlay's monotonic insert
 *   sequence: `insertRowId(overlayAnchor, seq)` (see `overlay.ts` — the fold
 *   state carries `nextInsertSeq`).
 *
 * ## Survival boundary (the contract m4-2/m4-3 build on)
 *
 * **What survives:**
 * - Re-opening the *same* base file version: the host supplies the same
 *   `baseAnchor`, so every base row derives the identical id again.
 * - Sort / filter / paging / window refresh: ids are functions of
 *   (anchor, ordinal), never of presentation order or viewport offsets.
 * - Undo/redo within a session: ids referenced by history entries are stable
 *   strings; tombstoned rows keep their ids so `row-restore` is exact.
 *
 * **What does not survive — and is deliberately not solved here:**
 * - Content changes on disk. A changed file is a *different base version*
 *   (ADR 0011); the host then supplies a different `baseAnchor` and every
 *   base row re-anchors to a new id. Old ids become foreign — the overlay
 *   reports `row-anchor-mismatch` conflicts for ops that carry them. The
 *   consequence, documented and accepted for v1: sessions, transformation
 *   histories and pinned row selections do **not** carry across base-version
 *   changes; callers must discard (or explicitly re-anchor) them. Cross-
 *   version row identity is ADR 0011 DatasetVersion/lineage territory and
 *   stays out of scope here.
 * - Insert ids are unique within one overlay session (one `overlayAnchor`);
 *   they have no meaning across sessions.
 *
 * Anchors are opaque host-supplied tokens (e.g. an engine table/version
 * token). They are concatenated into ids, never hashed — deriving identity
 * from content digests would invent a cryptographic primitive (ADR 0007
 * spirit) and would silently re-key rows under legitimate edits. Ids are
 * plain structured strings, so they cross the worker boundary (structured
 * clone) and log persistence unchanged.
 */

/** Type-level brand: a `RowId` is a logical row identity, not arbitrary text. */
declare const RowIdBrand: unique symbol

/**
 * A stable logical row id (ADR 0011/0012, mechanism per the M4 queue scoping
 * note). Shape: `base:<baseAnchor>#<ordinal>` or `ins:<overlayAnchor>#<seq>`
 * — derive only via {@link baseRowId}/{@link insertRowId}; parse only via
 * {@link parseRowId}.
 */
export type RowId = string & { readonly [RowIdBrand]: true }

/**
 * Derive the logical id of a base row: `base:<anchor>#<ordinal>`.
 *
 * `ordinal` is the row's position in the immutable base version's natural
 * order (0-based) — never a sort/filter/window position (see the module doc).
 * Hosts must pass a non-negative integer; the derivation is total and
 * injective for any anchor text (the `#` separator is unambiguous because
 * `String(ordinal)` never contains `#`, so `parseRowId` splits at the *last*
 * `#` and recovers the exact pair).
 */
export function baseRowId(baseAnchor: string, ordinal: number): RowId {
  return `base:${baseAnchor}#${String(ordinal)}` as RowId
}

/**
 * Derive the logical id of an overlay-inserted row: `ins:<anchor>#<seq>`.
 *
 * `seq` comes from the overlay's monotonic insert sequence
 * (`OverlayState.nextInsertSeq`) so ids are never reused within a session
 * (see `overlay.ts`); the canonical decimal form is enforced by
 * {@link parseRowId} (no leading zeros, no signs).
 */
export function insertRowId(overlayAnchor: string, seq: number): RowId {
  return `ins:${overlayAnchor}#${String(seq)}` as RowId
}

/** A `RowId` parsed back into its structured parts (total; see {@link parseRowId}). */
export type ParsedRowId =
  | { readonly origin: 'base'; readonly anchor: string; readonly ordinal: number }
  | { readonly origin: 'insert'; readonly anchor: string; readonly seq: number }

/**
 * Parse a `RowId` into its parts. Total and never-throwing (repo convention):
 * returns `null` for anything not derivable by {@link baseRowId} or
 * {@link insertRowId} — wrong prefix, missing/ non-canonical ordinal
 * (e.g. `007`, `-1`, `1.5`), or empty anchor. Parse splits at the last `#`,
 * which keeps the mapping injective even for anchors containing `#`.
 */
export function parseRowId(id: RowId): ParsedRowId | null {
  if (id.startsWith('base:')) {
    return parseTail(id.slice('base:'.length), 'base')
  }
  if (id.startsWith('ins:')) {
    return parseTail(id.slice('ins:'.length), 'insert')
  }
  return null
}

/**
 * Anchor-free display form of a logical row key. The anchor token is
 * host-derived (a file-version/session fingerprint) and is never rendered;
 * the ordinal/sequence is the part a human needs. The wording is the shared
 * grammar of every surface (CLI reports, the web validation/diff panels):
 * `base #12` / `insert #3`. Unparsable keys cannot occur from the executor
 * (it guarantees resolvable keys) and degrade to `unknown row` rather than
 * echo the raw token.
 */
export function displayRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown row'
  return parsed.origin === 'base'
    ? `base #${String(parsed.ordinal)}`
    : `insert #${String(parsed.seq)}`
}

/**
 * Anchor-free export form of a logical row key (`base:<ordinal>` /
 * `insert:<seq>`) — stable enough to join back against the source data
 * without carrying the anchor fingerprint into an exported file. Unparsable
 * keys degrade to `unknown` rather than echo the raw token.
 */
export function exportRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown'
  return parsed.origin === 'base'
    ? `base:${String(parsed.ordinal)}`
    : `insert:${String(parsed.seq)}`
}

function parseTail(tail: string, origin: 'base' | 'insert'): ParsedRowId | null {
  const hash = tail.lastIndexOf('#')
  // No separator at all, or nothing after it (empty ordinal) → malformed.
  // An *empty anchor* (`base:#0`) is derivable, so it parses back — parse is
  // the exact left inverse of derivation, keeping the mapping injective.
  if (hash === -1 || hash === tail.length - 1) return null
  const anchor = tail.slice(0, hash)
  const indexText = tail.slice(hash + 1)
  // Canonical non-negative decimal integer only — this is the exact shape
  // String(number) produces, so parse ∘ derive is the identity and ids that
  // were never derived (e.g. `#007`) are rejected rather than aliased onto a
  // real row.
  if (!/^(0|[1-9][0-9]*)$/.test(indexText)) return null
  const index = Number(indexText)
  if (!Number.isSafeInteger(index)) return null
  return origin === 'base'
    ? { origin: 'base', anchor, ordinal: index }
    : { origin: 'insert', anchor, seq: index }
}
