/**
 * Overlay base anchors (m4-3) — the host tokens the domain's `OverlayBase`
 * needs, derived in the composition root.
 *
 * ## Why this module exists
 *
 * ADR 0011 makes dataset identity logical, and the m4-1 survival boundary
 * (`@assay/domain` `row-identity.ts`) rules that base row ids are stable
 * **for a given base version**: `base:<baseAnchor>#<ordinal>`. m4-3 owns the
 * host side, so it must supply an anchor that is *the same function of the
 * same file version* — otherwise re-opening an unchanged file would mint a
 * different id space and old histories/ids would become foreign.
 *
 * ## The v1 anchor choice (documented, honest)
 *
 * `fileVersionAnchor` derives the anchor from the browser `File` metadata
 * that is stable for an unchanged file version: byte size and last-modified
 * time. It deliberately does **not** hash content: AGENTS.md / ADR 0007
 * forbid inventing cryptographic primitives, and a content digest could not
 * be computed cheaply before opening a multi-GB local file anyway (the whole
 * point of the local-first engine is that opening is lazy). The consequence,
 * stated plainly: a different file that happens to share size + mtime would
 * collide, and a rewrite that preserves both (rare) would look like the same
 * version. Content-addressed versions are ADR 0011 `DatasetVersion`
 * territory and are the M4+ follow-up; the survival boundary stays exactly
 * what `row-identity.ts` documents.
 *
 * Privacy (ADR 0025): the anchor is not a filename and carries no dataset
 * content — just size and mtime. It is still treated as opaque plumbing:
 * never rendered in the DOM and never logged. It appears only inside
 * logical-row-id strings passed to the engine/domain.
 */

/** The metadata slice the anchor needs (satisfied by a browser `File`). */
export interface FileVersionMetadata {
  readonly size: number
  readonly lastModified: number
}

/**
 * Stable anchor for a base file *version*: `fv-<size>-<lastModified>`.
 * Same unchanged file ⇒ same anchor ⇒ same base row ids (ADR 0011); a
 * different version ⇒ a different anchor ⇒ typed `row-anchor-mismatch`
 * conflicts for old ids (the documented survival boundary).
 */
export function fileVersionAnchor(file: FileVersionMetadata): string {
  return `fv-${String(file.size)}-${String(file.lastModified)}`
}

/**
 * Monotonic per-session insert-id scope. Insert ids (`ins:<anchor>#<seq>`)
 * only need uniqueness within one editing session; a process-local counter
 * is sufficient and avoids any crypto/random primitive (ADR 0007). Two
 * independent tabs may coincidentally share an anchor, but they never share
 * a history, so no collision is observable.
 */
let nextOverlayAnchor = 1

/** Allocate a fresh opaque overlay-session anchor. Test-visible via reset only. */
export function createOverlayAnchor(): string {
  const anchor = `ov-${String(nextOverlayAnchor)}`
  nextOverlayAnchor += 1
  return anchor
}
