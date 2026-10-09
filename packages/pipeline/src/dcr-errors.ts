// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed errors for the DCR artifact format (p3-1; ADR 0046).
 *
 * Two total surfaces share one vocabulary, mirroring the Pipeline IR:
 *
 * - `parseDcr` (YAML → AST) never throws; malformed and hostile input
 *   degrades to `DcrError[]` with a machine-readable `code`, an actionable
 *   value-free `message`, a document `path`
 *   (`deltas.rowDiff.samples[0].rowKey`), and 1-based `line`/`column`
 *   pointing at the offending YAML.
 * - `buildDcrArtifact` (inputs → AST) never throws either; caller bugs and
 *   contract violations degrade to the same {@link DcrError} shape with the
 *   AST `path` but no line/column (the inputs are position-free), which is
 *   why `line`/`column` are optional on the shared type.
 *
 * Messages are value-free where the value could be sensitive: they name the
 * *location* and the *kind* of problem, never a dataset value (ADR 0025,
 * extended to DCR diagnostics — the `errors.ts` discipline).
 */
import type { DcrArtifactV1 } from './dcr-ast.js'

/** Machine-readable failure classes (one switch-able vocabulary). */
export type DcrErrorCode =
  /** Not parseable YAML, or a YAML corner the format refuses (unresolved tags, alias cycles). */
  | 'yaml-syntax'
  /** A `format` other than `assay-dcr` — reported alone instead of guessing other formats' semantics. */
  | 'unsupported-format'
  /** A `version` other than 1 — reported alone instead of guessing other versions' semantics. */
  | 'unsupported-version'
  /** A required key is absent (`format`, `version`, `base`, `candidate`, `deltas`, …). */
  | 'missing-key'
  /** A mapping key that is not valid at its location (unknown or misplaced). */
  | 'unknown-key'
  /** A value has the wrong YAML type for its key (string where a mapping/list was required, …). */
  | 'wrong-type'
  /** A value violates its domain: a non-finite number, an empty name, a NUL-bearing string. */
  | 'out-of-range'
  /** The same mapping key twice in one mapping. */
  | 'duplicate-key'
  /** The same entry twice in a name-keyed collection (finding, delta, verdict, aspect, id list). */
  | 'duplicate-reference'
  /** An id-position field uses the reserved `assay_dcr_*` namespace (D17-Q9). */
  | 'reserved-identifier'
  /** A written number would be silently altered by the YAML→number parse (exact-or-rejected). */
  | 'imprecise-number'
  /** A row-diff sample key is outside the anchor-free export grammar (spec §5). */
  | 'invalid-reference'

/**
 * One actionable failure. Plain data — render it however the surface wants
 * (see {@link describeDcrError} for the canonical one-liner).
 */
export interface DcrError {
  readonly code: DcrErrorCode
  readonly message: string
  /** Path into the document/AST; `document` is the root, `candidate.materialization.node` an id field, … */
  readonly path: string
  /** 1-based line of the offending YAML (parse errors only). */
  readonly line?: number
  /** 1-based column within the line (parse errors only). */
  readonly column?: number
}

/** A parse outcome. `ok` discriminates: never a raw throw. */
export type DcrParseResult =
  | { readonly ok: true; readonly artifact: DcrArtifactV1 }
  | { readonly ok: false; readonly errors: readonly DcrError[] }

/** A build outcome. `ok` discriminates: never a raw throw. */
export type DcrBuildResult =
  | { readonly ok: true; readonly artifact: DcrArtifactV1 }
  | { readonly ok: false; readonly errors: readonly DcrError[] }

/**
 * Canonical one-line rendering, compiler-style and greppable:
 * `deltas.rowDiff.keys:3:9: row-diff requires an explicit key list …`. The
 * structured fields remain the primary surface; this is for humans and logs.
 */
export function describeDcrError(error: DcrError): string {
  const location =
    error.line !== undefined && error.column !== undefined
      ? `${error.path}:${error.line}:${error.column}`
      : error.path
  return `${location}: ${error.message}`
}
