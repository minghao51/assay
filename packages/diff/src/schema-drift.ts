/**
 * Schema-drift classification over two engine-shaped schemas plus the
 * profile-derived nullability drift.
 *
 * Schemas are `EngineSchema` from `@assay/validation` — the engine's
 * `schema()` shape (`Array<{ name, type }>`, the verbatim `DESCRIBE`
 * spellings for engine-duckdb). The m5-1 **type-family classifier is
 * reused, never reimplemented** (`@assay/validation` is the pre-authorized
 * dependency for exactly this).
 *
 * ## Classification
 *
 * - `column-added` / `column-removed` — presence by exact, case-sensitive
 *   name. Matching is exact because engine spellings are canonical (the
 *   m5-1 compiler's policy); case-folding names across datasets would be a
 *   guess.
 * - `type-changed-same-family` — the textual spellings differ but both
 *   classify into one family (`INTEGER` → `BIGINT`, `VARCHAR(3)` →
 *   `VARCHAR`, `DECIMAL(10,2)` → `DOUBLE`): same rule-binding behavior,
 *   still a real schema change.
 * - `type-changed-cross-family` — the families differ (`INTEGER` →
 *   `VARCHAR`): the strongest drift signal short of row-level comparison.
 * - `type-changed-unclassifiable` — either side classifies `'other'`
 *   (arrays, `STRUCT`/`MAP`/`UNION`/`ENUM`, unknown spellings).
 *   **Nested-shape drift is reported from the textual type difference plus
 *   the classifier family** — DuckDB type strings are never structurally
 *   parsed here; the textual difference *is* the finding (honest, and all
 *   m6-0 needs).
 *
 * ## Nullability drift is profile-derived — documented
 *
 * Engine `DESCRIBE` carries no nullability, so observed nullability is
 * computed from the profiles' null shares (`nullCount / rowCount`): a
 * `nullability-changed` finding fires when exactly one side observed at
 * least one NULL in a non-empty dataset. Both shares travel on the finding
 * at full precision (`roundForReport` before rendering). A side with zero
 * rows has observed nothing either way — the finding is suppressed
 * (documented). Null-share *magnitudes* changing while both sides stay
 * non-null is distribution-level signal, not nullability drift, and is
 * deliberately not a finding here.
 *
 * Findings are plain data in a documented, deterministic order: column name
 * ascending (UTF-16 code-unit), then the kind order added → removed →
 * cross-family → same-family → unclassifiable → nullability.
 */

import type { ColumnTypeFamily, EngineSchema } from '@assay/validation'
import { classifyColumnType } from '@assay/validation'
import type { DiffIssue } from './issues.js'
import type { DatasetProfile } from './profile.js'
import type { ValidatedProfile, ValidatedSchema } from './input-validation.js'
import { validateProfile, validateSchema } from './input-validation.js'

/** The schema-drift finding classes (see module doc). */
export type SchemaDriftKind =
  | 'column-added'
  | 'column-removed'
  | 'type-changed-same-family'
  | 'type-changed-cross-family'
  | 'type-changed-unclassifiable'
  | 'nullability-changed'

/** Documented kind order for same-column findings (deterministic reports). */
const KIND_ORDER: Readonly<Record<SchemaDriftKind, number>> = {
  'column-added': 0,
  'column-removed': 1,
  'type-changed-cross-family': 2,
  'type-changed-same-family': 3,
  'type-changed-unclassifiable': 4,
  'nullability-changed': 5,
}

/**
 * One schema-drift finding, keyed by column name. Type findings carry the
 * engine spellings and classifier families of both sides; nullability
 * findings carry the observed null shares (`null` = not observed — the
 * side had zero rows).
 */
export interface SchemaDriftFinding {
  readonly kind: SchemaDriftKind
  readonly column: string
  readonly typeA?: string
  readonly typeB?: string
  readonly familyA?: ColumnTypeFamily
  readonly familyB?: ColumnTypeFamily
  readonly nullShareA?: number | null
  readonly nullShareB?: number | null
}

/** Schema-drift findings plus the collected input issues of the aspect. */
export interface SchemaDriftResult {
  readonly findings: readonly SchemaDriftFinding[]
  readonly issues: readonly DiffIssue[]
}

/**
 * Schema drift over the two engine-shaped schemas: added/removed columns
 * and classified type changes (see module doc). Total over hostile input —
 * an unusable side skips the aspect with its issue, never fabricates
 * findings. Nullability drift is a separate aspect
 * ({@link nullabilityDrift}); `diffDatasets` merges both.
 */
export function schemaDrift(schemaA: EngineSchema, schemaB: EngineSchema): SchemaDriftResult {
  const issues: DiffIssue[] = []
  const a = validateSchema(schemaA as unknown, 'A', issues)
  const b = validateSchema(schemaB as unknown, 'B', issues)
  if (a === null || b === null) return { findings: [], issues }
  return { findings: typeDriftFindings(a, b), issues }
}

/**
 * Nullability drift from the two profile summaries (see module doc for why
 * this is profile-derived and when it fires). Total over hostile input.
 */
export function nullabilityDrift(
  profileA: DatasetProfile,
  profileB: DatasetProfile,
): SchemaDriftResult {
  const issues: DiffIssue[] = []
  const a = validateProfile(profileA as unknown, 'A', issues)
  const b = validateProfile(profileB as unknown, 'B', issues)
  if (a === null || b === null) return { findings: [], issues }
  return { findings: nullabilityFindings(a, b), issues }
}

/** Type drift over validated schemas (shared by `schemaDrift` and `diffDatasets`). */
export function typeDriftFindings(a: ValidatedSchema, b: ValidatedSchema): SchemaDriftFinding[] {
  const findings: SchemaDriftFinding[] = []
  for (const column of a.columns) {
    const other = b.byName.get(column.name)
    if (other === undefined) {
      findings.push({
        kind: 'column-removed',
        column: column.name,
        typeA: column.type,
        familyA: classifyColumnType(column.type),
      })
      continue
    }
    if (other.type !== column.type) findings.push(typeChangeFinding(column, other))
  }
  for (const column of b.columns) {
    if (!a.byName.has(column.name)) {
      findings.push({
        kind: 'column-added',
        column: column.name,
        typeB: column.type,
        familyB: classifyColumnType(column.type),
      })
    }
  }
  return sortFindings(findings)
}

/**
 * Nullability findings over validated profiles (shared by
 * `nullabilityDrift` and `diffDatasets`).
 */
export function nullabilityFindings(
  a: ValidatedProfile,
  b: ValidatedProfile,
): SchemaDriftFinding[] {
  const findings: SchemaDriftFinding[] = []
  for (const column of a.columns) {
    const other = b.byName.get(column.name)
    if (other === undefined) continue // presence is type drift's concern
    const shareA = nullShare(column.nullCount, a.rowCount)
    const shareB = nullShare(other.nullCount, b.rowCount)
    if (shareA === null || shareB === null) continue // no observation on a side → no finding
    const hadNullsA = column.nullCount !== 0
    const hadNullsB = other.nullCount !== 0
    if (hadNullsA !== hadNullsB) {
      findings.push({
        kind: 'nullability-changed',
        column: column.name,
        nullShareA: shareA,
        nullShareB: shareB,
      })
    }
  }
  return sortFindings(findings)
}

/** Observed null share, or `null` when not observed (zero rows / unknown counts). */
function nullShare(nullCount: number | null, rowCount: number | null): number | null {
  if (nullCount === null || rowCount === null || rowCount <= 0) return null
  return nullCount / rowCount
}

function typeChangeFinding(
  a: { readonly name: string; readonly type: string },
  b: { readonly name: string; readonly type: string },
): SchemaDriftFinding {
  const familyA = classifyColumnType(a.type)
  const familyB = classifyColumnType(b.type)
  const kind: SchemaDriftKind =
    familyA === 'other' || familyB === 'other'
      ? 'type-changed-unclassifiable'
      : familyA === familyB
        ? 'type-changed-same-family'
        : 'type-changed-cross-family'
  return { kind, column: a.name, typeA: a.type, typeB: b.type, familyA, familyB }
}

/** Documented deterministic order: column name ascending, then kind order. */
export function sortFindings(findings: SchemaDriftFinding[]): SchemaDriftFinding[] {
  return findings.sort((f, g) => {
    if (f.column !== g.column) return f.column < g.column ? -1 : 1
    return KIND_ORDER[f.kind] - KIND_ORDER[g.kind]
  })
}
