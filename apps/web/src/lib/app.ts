export const APP_NAME = 'Assay' as const

/** The descriptive tagline — "data workbench" is the category, Assay is the product (ADR 0039). */
export const TAGLINE = 'The local-first data workbench' as const

/** Keep in sync with the roadmap status (docs/product/10-execution-roadmap.md §4 and
 * docs/product/11-post-mvp-track.md). Honest as of 2026-09-22 (audit AR-W6): the MVP
 * (M0–M6) is complete; the post-MVP track is underway. */
export const SCAFFOLD_STATUS = 'MVP complete (M0–M6) — post-MVP track in progress' as const

export const NEXT_MILESTONE =
  'PT-0: launch readiness to gate G0 (then the D12-chosen engineering track)' as const
