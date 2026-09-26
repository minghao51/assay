// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic key-inference proposer (m6-1, checkpoint C2).
 *
 * **Inference is a proposal, never a key.** The output feeds a human
 * decision (web UI confirmation) or a disclosed CLI choice (`--infer`,
 * m6-3, which must print the disclosure strings verbatim) — the compiler
 * requires explicit keys and is deliberately blind to this module; an
 * empty key set is a binding error there, never an implicit guess.
 *
 * ## The evidence boundary (what profiles can honestly prove)
 *
 * A profile column carries per-column aggregates only (`nullCount`,
 * `distinctCount`, `rowCount`). From those, a **single** column can be
 * proven to be a usable key component on one side:
 * `nullCount === 0` (non-null) and `distinctCount === rowCount` (every row
 * a distinct value — `distinctCount` counts non-null values only, so this
 * one equality is exactly "no NULLs and no duplicates").
 *
 * **Joint uniqueness across column pairs is NOT derivable** from
 * per-column aggregates: distinct(a) = rowCount and distinct(b) = rowCount
 * does not imply that the pair (a, b) is unique (both could be constant-
 * per-group in correlated ways) — and any claimed multi-column proof from
 * these numbers would be invented evidence. The proposer therefore
 * restricts v1 proposals to **single-column candidates** — exactly what
 * the profiles prove — and documents the boundary in every outcome
 * disclosure. Multi-column keys remain fully supported by the compiler;
 * only inference is single-column v1.
 *
 * ## Candidacy and ranking (deterministic, documented)
 *
 * A column is a candidate iff, on **both** sides (A = reference, B =
 * current):
 *
 * - it exists under the exact, case-sensitive name (the package-wide
 *   matching policy);
 * - `rowCount ≥ 1` on that side (a zero-row side has observed nothing —
 *   `distinctCount 0 === rowCount 0` would be vacuous "uniqueness");
 * - `nullCount === 0` and `distinctCount === rowCount`;
 * - the two sides' type spellings are compatible under the documented
 *   key policy (`keyTypesCompatible` — a proposal the compiler would
 *   reject is noise, so the proposer applies the same one policy
 *   function).
 *
 * Ranking: all v1 candidates are single-column (minimal by construction);
 * ties resolve by **profile-A column order** — the natural, documented
 * deterministic order. No floating point, no locale, no map-iteration
 * order anywhere.
 *
 * ## Totality and never-silence
 *
 * Hostile profiles degrade through the m6-0 guarded validators
 * (`validateProfile` — reused, never re-validated differently): typed,
 * attributed issues are collected (side A before side B), candidates come
 * back empty when a side is unusable, and nothing throws. The result
 * always carries a top-level `disclosure` line — for zero candidates too
 * ("no candidate is provable" is an outcome, not a silence) — and every
 * candidate carries its own per-candidate `disclosure` for verbatim
 * surface rendering. Numbers in disclosures render through the exact
 * `String()` form (the never-echo rule: no rounding, no re-formatting).
 */

import type { DiffIssue } from './issues.js'
import type { DatasetProfile } from './profile.js'
import { validateProfile } from './input-validation.js'
import { keyTypesCompatible } from './row-diff-compile.js'

/** Machine-readable evidence for one candidate (what the profiles prove). */
export interface KeyCandidateEvidence {
  /** The proposed key column's exact name. */
  readonly column: string
  /** Side A's engine type spelling. */
  readonly typeA: string
  /** Side B's engine type spelling. */
  readonly typeB: string
  /** Side A's row count. */
  readonly rowCountA: number
  /** Side B's row count. */
  readonly rowCountB: number
  /** Side A's NULL count (0 for a candidate). */
  readonly nullCountA: number
  /** Side B's NULL count (0 for a candidate). */
  readonly nullCountB: number
  /** Side A's distinct non-null count (=== rowCountA for a candidate). */
  readonly distinctCountA: number
  /** Side B's distinct non-null count (=== rowCountB for a candidate). */
  readonly distinctCountB: number
}

/**
 * One proposed key. `columns` is a single-element array in v1 — the shape
 * is a list so a future proposer that can honestly evidence multi-column
 * candidates does not break consumers (the documented evidence boundary
 * means v1 never fills a second element).
 */
export interface KeyCandidate {
  readonly columns: readonly string[]
  readonly evidence: KeyCandidateEvidence
  /** Human-readable, deterministic disclosure — surfaces emit it verbatim. */
  readonly disclosure: string
}

/** The inference outcome: ranked candidates, issues, and the outcome disclosure. */
export interface KeyInferenceResult {
  /** Ranked candidates: minimal-first (single-column), then profile-A column order. Empty when nothing is provable. */
  readonly candidates: readonly KeyCandidate[]
  /** One-line outcome disclosure — present for the zero-candidates case too (never silent). */
  readonly disclosure: string
  /** Collected input issues (documented order); empty for well-formed profiles. */
  readonly issues: readonly DiffIssue[]
}

/** Exact integer rendering for disclosures (never-echo: String() only). */
function n(value: number): string {
  return String(value)
}

/**
 * Propose row-diff key candidates from the two validated profile
 * summaries (see module doc). Total over hostile input; deterministic.
 */
export function inferRowDiffKeys(
  profileA: DatasetProfile,
  profileB: DatasetProfile,
): KeyInferenceResult {
  const issues: DiffIssue[] = []
  const a = validateProfile(profileA as unknown, 'A', issues)
  const b = validateProfile(profileB as unknown, 'B', issues)
  if (a === null || b === null) {
    return {
      candidates: [],
      issues,
      disclosure:
        'no key candidate is provable: a profile side is unusable (see the collected issues); inference proposes only what both profiles prove',
    }
  }
  const candidates: KeyCandidate[] = []
  for (const columnA of a.columns) {
    const columnB = b.byName.get(columnA.name)
    if (columnB === undefined) continue // must exist on both sides, exact name
    if (!isProvenKeySide(columnA.nullCount, columnA.distinctCount, a.rowCount)) continue
    if (!isProvenKeySide(columnB.nullCount, columnB.distinctCount, b.rowCount)) continue
    if (!keyTypesCompatible(columnA.type, columnB.type)) continue
    candidates.push({
      columns: [columnA.name],
      evidence: {
        column: columnA.name,
        typeA: columnA.type,
        typeB: columnB.type,
        rowCountA: a.rowCount as number,
        rowCountB: b.rowCount as number,
        nullCountA: columnA.nullCount as number,
        nullCountB: columnB.nullCount as number,
        distinctCountA: columnA.distinctCount as number,
        distinctCountB: columnB.distinctCount as number,
      },
      disclosure: candidateDisclosure(
        columnA.name,
        columnA.type,
        columnB.type,
        a.rowCount as number,
        b.rowCount as number,
      ),
    })
  }
  return {
    candidates,
    issues,
    disclosure:
      candidates.length > 0
        ? `${n(candidates.length)} key candidate(s) proposed (single columns the profiles prove non-null and unique on both sides, ranked by profile-A column order); inference is a proposal — confirm keys explicitly before compiling a row diff`
        : 'no key candidate is provable from the profiles: v1 proposes single columns that are non-null and unique on BOTH sides (multi-column joint uniqueness is not derivable from per-column aggregates); choose key columns explicitly',
  }
}

/** Non-null, unique, over at least one observed row — what proves a key side. */
function isProvenKeySide(
  nullCount: number | null,
  distinctCount: number | null,
  rowCount: number | null,
): boolean {
  if (rowCount === null || rowCount < 1) return false
  return nullCount === 0 && distinctCount === rowCount
}

/** The verbatim per-candidate disclosure (deterministic; exact numbers). */
function candidateDisclosure(
  column: string,
  typeA: string,
  typeB: string,
  rowCountA: number,
  rowCountB: number,
): string {
  return (
    `key candidate: column '${column}' is unique and non-null on both sides ` +
    `(A: ${typeA}, 0 nulls, ${n(rowCountA)} distinct of ${n(rowCountA)} rows; ` +
    `B: ${typeB}, 0 nulls, ${n(rowCountB)} distinct of ${n(rowCountB)} rows)`
  )
}
