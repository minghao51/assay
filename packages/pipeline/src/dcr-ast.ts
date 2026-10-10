// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical DCR artifact AST v1 (p3-1; ADR 0046, ruling D17).
 *
 * `DcrArtifactV1` is the portable, engine-independent meaning of a Dataset
 * Change Request artifact (ADR 0014): what the YAML format *says*, stripped
 * of formatting. It is the file form the domain `DatasetChangeRequest`
 * aggregate will be built from; per D17-Q10 the artifact itself carries **no
 * identity and no status** — it is a standalone report file (the m5-3/m6-4
 * export precedent), and hosted review (M10/G3) owns workflow state.
 *
 * ## Ruled field schema (D17; ADR 0046 §Decision.4)
 *
 * - **Stamp (Q1):** `format: assay-dcr` + `version: 1` on every artifact.
 * - **Sides (Q4):** `base` and `candidate` are DatasetVersion *references*
 *   with one shared shape — logical id + schema fingerprint + provenance +
 *   a materialization reference. **No full content hash** (connector-
 *   specific, infeasible for large/lazy outputs); provenance carries
 *   `transformationRecipe`/`parentVersionIds` only — the domain
 *   `Provenance.createdAt` wall-clock is deliberately outside the canonical
 *   core (Q11: no wall-clock anywhere in canonical bytes).
 * - **Deltas (Q2):** M6's aspects mirrored verbatim — `schemaDrift` /
 *   `columnDeltas` / `rowDiff`. ADR 0014's four delta names map onto them:
 *   schema delta = `schemaDrift`; "profile delta" = profile-derived
 *   nullability findings (in `schemaDrift`) + distribution deltas (in
 *   `columnDeltas`) — **no standalone profile diff in v1**; row delta =
 *   `rowDiff`. The payload shapes below mirror `@assay/diff`'s
 *   `SchemaDriftFinding` / `ColumnDistributionDelta` and the engine's
 *   executed row-diff result **structurally** (the
 *   `engine-duckdb/src/diff-plan-wire.ts` precedent: mirrors, never imports,
 *   at the package boundary — the pipeline package's allowed `@assay` deps
 *   are contracts/domain/validation). Drift is caught by the golden
 *   fixtures + round-trip pins, not by a type dependency.
 * - **Value-free deltas:** the numeric delta carries the four shift metrics;
 *   `@assay/diff`'s side-A `bins` scaffold (a recomputation seam, not review
 *   content) is deliberately not carried. Categorical new/vanished entries
 *   carry the M6-sanctioned delta labels (audit AR-C1 — the same content the
 *   M6 surfaces already emit), with counts; no other dataset values exist in
 *   the grammar (there is no field a cell value or SQL text could occupy).
 * - **Row-diff keys (Q7):** a `rowDiff` block exists **only** when explicit
 *   keys were supplied; it *requires* them (typed located error otherwise),
 *   and silent inference is rejected by construction. Sample row keys stay
 *   in the anchor-free `base:<ordinal>` / `insert:<seq>` / `b:<ordinal>`
 *   export grammar (spec §5; cf. `@assay/domain`'s `exportRowKey`) — the
 *   host-derived anchor of the m4-3 grid form can never enter the artifact.
 * - **Validation:** the value-free verdict shape the P2 validate gates and
 *   the m5-4 CLI report already use — verdict (`valid`/`violatedRules`,
 *   `PipelineRunGateResult`'s validate class) plus the report's per-rule
 *   rows (`ruleId`/`failCount`/`failPercent`) **minus the sample rows**
 *   (samples carry dataset values; ADR 0025).
 * - **Lineage:** P2-derived — the candidate's dataset-version inputs
 *   (ADR 0011) and the ordered topological producing-node list (p2-6; order
 *   is meaning there, so it is preserved, not sorted).
 * - **Privacy findings (Q6a):** a required slot carrying the *exact*
 *   canonical "not computed" disclosure — an honesty statement, not a
 *   placeholder a producer can vary (two artifacts of the same facts must be
 *   byte-identical).
 * - **Evaluations (Q8), comments/approvals/policy (M10/G3):** omitted
 *   entirely — no reserved fields.
 * - **Extensibility (Q12):** v1 is additive-only. A perceived need for a
 *   non-additive change is a STOP-and-report; a version bump is
 *   maintainer-visible.
 *
 * ## Canonical normalization
 *
 * - Name-keyed collections where order is not meaning are sorted ascending
 *   (code-unit order, never `localeCompare`) and rejected on duplicates:
 *   `schemaDrift` (column, then documented kind order), `columnDeltas`
 *   (column), `validation` verdicts (node id) and their `rules` (rule id),
 *   `rowDiff.aspects` (documented aspect order), `changedColumns`,
 *   `parentVersionIds`, `inputVersionIds`.
 * - Producer-meaningful orders are preserved, never sorted: `rowDiff`
 *   samples (the aspect query's natural order) and categorical
 *   new/vanished entries (top-k frequency order).
 * - Empty collections are spelled by absence (one shape per meaning), as are
 *   `validation`/`lineage` with nothing to carry.
 *
 * Purity: types + helpers only — no React, no browser APIs, no engine (the
 * pipeline package's lint-enforced boundary; ADR 0030).
 */

/** The literal `format` stamp carried by every DCR artifact (D17-Q1). */
export const DCR_FORMAT = 'assay-dcr' as const

/** The only supported DCR artifact version (D17-Q12: additive-only within v1). */
export const DCR_VERSION = 1 as const

/** The literal schema-version discriminator carried by every {@link DcrArtifactV1}. */
export type DcrVersion = typeof DCR_VERSION

/**
 * The DCR format's reserved namespace (D17-Q9). Identifier-shaped fields the
 * format or its producers generate must live under this prefix, so user
 * content in id positions is refused it (see `reserved-identifier`), exactly
 * as the Pipeline IR reserves `assay_*` node ids.
 */
export const DCR_RESERVED_PREFIX = 'assay_dcr_' as const

/**
 * The one canonical privacyFindings disclosure (D17-Q6a). The format fixes
 * the exact string so two artifacts of the same facts are byte-identical;
 * any other spelling is a parse/build error, not a variation.
 */
export const DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE =
  'Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046, ruling D17-Q6).'

/** The schema-drift finding classes (mirrors `@assay/diff` `SchemaDriftKind`). */
export const DCR_SCHEMA_DRIFT_KINDS = [
  'column-added',
  'column-removed',
  'type-changed-same-family',
  'type-changed-cross-family',
  'type-changed-unclassifiable',
  'nullability-changed',
] as const

export type DcrSchemaDriftKind = (typeof DCR_SCHEMA_DRIFT_KINDS)[number]

/**
 * Documented kind order for same-column findings (mirrors `@assay/diff`
 * `KIND_ORDER`) — the canonical sort key after the column name.
 */
const DCR_SCHEMA_DRIFT_KIND_ORDER: Readonly<Record<DcrSchemaDriftKind, number>> = {
  'column-added': 0,
  'column-removed': 1,
  'type-changed-cross-family': 2,
  'type-changed-same-family': 3,
  'type-changed-unclassifiable': 4,
  'nullability-changed': 5,
}

/**
 * The m5-1 type-family vocabulary (mirrors `@assay/validation`
 * `ColumnTypeFamily` — the classifier the diff model reuses).
 */
export const DCR_COLUMN_FAMILIES = [
  'numeric',
  'textual',
  'boolean',
  'temporal',
  'uuid',
  'json',
  'blob',
  'other',
] as const

export type DcrColumnTypeFamily = (typeof DCR_COLUMN_FAMILIES)[number]

/** Profile column kinds (mirrors `@assay/diff` `ProfileColumnKind`). */
export const DCR_PROFILE_COLUMN_KINDS = ['numeric', 'categorical', 'other'] as const

export type DcrProfileColumnKind = (typeof DCR_PROFILE_COLUMN_KINDS)[number]

/** Is `value` a recognized profile column kind? */
export function isDcrProfileColumnKind(value: unknown): value is DcrProfileColumnKind {
  return (
    typeof value === 'string' && (DCR_PROFILE_COLUMN_KINDS as readonly string[]).includes(value)
  )
}

/** Is `value` a recognized schema-drift kind? */
export function isDcrSchemaDriftKind(value: unknown): value is DcrSchemaDriftKind {
  return typeof value === 'string' && (DCR_SCHEMA_DRIFT_KINDS as readonly string[]).includes(value)
}

/** Is `value` a recognized type family? */
export function isDcrColumnTypeFamily(value: unknown): value is DcrColumnTypeFamily {
  return typeof value === 'string' && (DCR_COLUMN_FAMILIES as readonly string[]).includes(value)
}

/** A schema fingerprint (ADR 0011; mirrors the domain `SchemaFingerprint`). */
export interface DcrSchemaFingerprint {
  readonly algorithm: string
  readonly value: string
}

/**
 * Provenance inside the canonical core (ADR 0011): the transformation recipe
 * and parent versions, **without** the domain `Provenance.createdAt`
 * wall-clock — D17-Q11 keeps timestamps outside the canonical bytes.
 */
export interface DcrProvenance {
  readonly transformationRecipe?: string
  /** Canonical order: ascending code-unit; duplicates are a build error. */
  readonly parentVersionIds?: readonly string[]
}

/**
 * A materialization reference (D17-Q4): the pipeline run node whose output
 * the version is, **or** the export artifact path (the runner's value-free
 * `exportPath`). Exactly one of the two — presence is the discriminator
 * (one shape per meaning; no `kind` field to drift out of sync).
 */
export type DcrMaterializationRef = { readonly node: string } | { readonly export: string }

/**
 * One side of the comparison (D17-Q4): logical id + schema fingerprint +
 * provenance + materialization reference. **No full content hash** — ruled
 * out of v1 (connector-specific, infeasible for large/lazy outputs).
 */
export interface DcrVersionRef {
  readonly datasetId: string
  readonly versionId: string
  readonly schemaFingerprint: DcrSchemaFingerprint
  readonly provenance?: DcrProvenance
  readonly materialization: DcrMaterializationRef
}

/** One schema-drift finding (mirrors `@assay/diff` `SchemaDriftFinding`). */
export interface DcrSchemaDriftFinding {
  readonly kind: DcrSchemaDriftKind
  readonly column: string
  /** Type findings carry the engine spellings of both sides. */
  readonly typeA?: string
  readonly typeB?: string
  /** Type findings carry the classifier families of both sides. */
  readonly familyA?: DcrColumnTypeFamily
  readonly familyB?: DcrColumnTypeFamily
  /**
   * Nullability findings carry the observed null shares (`null` = not
   * observed — that side had zero rows); shares live in [0, 1].
   */
  readonly nullShareA?: number | null
  readonly nullShareB?: number | null
}

/** Numeric distribution delta metrics (mirrors `@assay/diff`, minus the `bins` recomputation seam). */
export interface DcrNumericDistributionDelta {
  /** `(meanB − meanA) / stddevA` — standardized against side A. */
  readonly meanShiftStandardized: number | null
  /** `σB²/σA² − 1` — relative variance change referenced to side A. */
  readonly varianceShiftStandardized: number | null
  /** `p50B − p50A` in the column's own units. */
  readonly p50Shift: number | null
  /** `p90B − p50A`'s sibling: `p90B − p90A` in the column's own units. */
  readonly p90Shift: number | null
}

/** One top-k categorical entry (mirrors `@assay/diff` `CategoricalTopKEntry`). */
export interface DcrCategoricalTopKEntry {
  /** The M6-sanctioned delta label (audit AR-C1), engine-rendered text form. */
  readonly value: string
  readonly count: number
}

/** Categorical distribution delta (mirrors `@assay/diff` `CategoricalDistributionDelta`). */
export interface DcrCategoricalDistributionDelta {
  /** Total-variation distance over `top-k ∪ {other}` — a value in [0, 1]. */
  readonly totalVariation: number | null
  /** Values in B's top-k absent from A's, in B's top-k order (preserved). */
  readonly newCategories: readonly DcrCategoricalTopKEntry[]
  /** Values in A's top-k absent from B's, in A's top-k order (preserved). */
  readonly vanishedCategories: readonly DcrCategoricalTopKEntry[]
  /**
   * Bounding disclosure (D19-OQ-4; p3-1b): present — and only ever spelled
   * exactly `true` — when the candidate-side profile's at-most-k top-k hit
   * its M6 bound, so `newCategories` may be incomplete. **Absence is
   * meaning**: absent is the one spelling of "not bounded" (there is no
   * `false` — one shape per meaning), so artifacts without bounding
   * serialize byte-identically to before. Additive-only within v1
   * (D17-Q12); the literal `true` type keeps the AST honest at compile
   * time.
   */
  readonly newCategoriesBounded?: true
  /** As {@link DcrCategoricalDistributionDelta.newCategoriesBounded}, for the base-side top-k behind `vanishedCategories`. */
  readonly vanishedCategoriesBounded?: true
}

/** One shared column's distribution delta (mirrors `@assay/diff` `ColumnDistributionDelta`). */
export interface DcrColumnDistributionDelta {
  readonly column: string
  readonly typeA: string
  readonly typeB: string
  readonly kindA: DcrProfileColumnKind
  readonly kindB: DcrProfileColumnKind
  readonly numeric?: DcrNumericDistributionDelta
  readonly categorical?: DcrCategoricalDistributionDelta
}

/** The row-diff aspects, in canonical order (mirrors the m6-1 plan order). */
export const DCR_ROW_DIFF_ASPECTS = ['added', 'removed', 'changed'] as const

export type DcrRowDiffAspect = (typeof DCR_ROW_DIFF_ASPECTS)[number]

/**
 * The anchor-free row-key export grammar (spec §5; cf. `@assay/domain`
 * `exportRowKey`): `base:<ordinal>` / `insert:<seq>` / `b:<ordinal>` with a
 * canonical decimal (no leading zeros, no signs). Row keys are ordinals —
 * never dataset values, and never the host-derived grid anchor of the m4-3
 * `base:<anchor>#<ordinal>` form (ADR 0025 shape-pin).
 */
const ANCHOR_FREE_ROW_KEY_PATTERN = /^(?:base|insert|b):(?:0|[1-9][0-9]*)$/

/** Is `rowKey` in the anchor-free export grammar? */
export function isAnchorFreeRowKey(rowKey: string): boolean {
  return ANCHOR_FREE_ROW_KEY_PATTERN.test(rowKey)
}

/** Is `value` a recognized row-diff aspect? */
export function isDcrRowDiffAspect(value: unknown): value is DcrRowDiffAspect {
  return typeof value === 'string' && (DCR_ROW_DIFF_ASPECTS as readonly string[]).includes(value)
}

/**
 * One sampled row of a row-diff aspect (mirrors the engine's
 * `EngineRowDiffSample`): a side, an anchor-free row key, and — `changed`
 * only — the *names* of the shared non-key columns that differ. Column
 * names are schema, never values (ADR 0025); the grammar has no field a
 * cell value could occupy.
 */
export interface DcrRowDiffSample {
  readonly side: 'A' | 'B'
  /** Anchor-free export grammar: `base:<ordinal>` / `insert:<seq>` / `b:<ordinal>`. */
  readonly rowKey: string
  /** Canonical order: ascending code-unit; duplicates are a build error. */
  readonly changedColumns?: readonly string[]
}

/** Per-aspect result: the exact count plus bounded samples (mirrors the engine's aspect result). */
export interface DcrRowDiffAspectResult {
  readonly aspect: DcrRowDiffAspect
  /** The exact count over the full relations (never the sample bound). */
  readonly count: number
  /** Bounded samples, in the aspect query's natural order (preserved). */
  readonly samples: readonly DcrRowDiffSample[]
}

/**
 * The row-diff block (D17-Q7): present **only** when explicit keys were
 * supplied, and requiring them — no silent inference inside a review
 * artifact. Absent `rowDiff` is the one canonical spelling of "no keys were
 * supplied, so there is no row delta".
 */
export interface DcrRowDiff {
  /** The explicit key columns, deduplicated case-insensitively (the m6-1 binding rule). */
  readonly keys: readonly string[]
  /** The K of the sample bound (≥ 1); exact counts travel regardless of K. */
  readonly sampleLimit: number
  readonly rowCountA: number
  readonly rowCountB: number
  /** Canonical order: added, removed, changed — each exactly once. */
  readonly aspects: readonly DcrRowDiffAspectResult[]
}

/**
 * One per-rule, value-free report row (the m5-4 report row **minus the
 * sample rows**, which carry dataset values — ADR 0025).
 */
export interface DcrValidationRuleRow {
  readonly ruleId: string
  /** The plan rule kind (the m5-1 vocabulary); absent degrades to an untyped row. */
  readonly kind?: string
  /** The constrained column; absent for dataset-level rules (one spelling — never `null`). */
  readonly column?: string
  readonly failCount: number
  /** The engine's frozen integer half-up share, in [0, 100]. */
  readonly failPercent: number
}

/**
 * One validate gate's value-free verdict: the P2 gate shape
 * (`PipelineRunGateResult`'s validate class) plus the optional m5-4 report
 * detail (`rowCount`, `rules`). The verdict is authoritative; `rules` is
 * detail, not a re-derivation of `violatedRules`.
 */
export interface DcrValidationVerdict {
  /** The validate node's id in the producing run. */
  readonly nodeId: string
  /** The table reference the gate validated. */
  readonly input: string
  readonly valid: boolean
  /** How many rules were violated (0 when valid). */
  readonly violatedRules: number
  readonly rowCount?: number
  readonly rules?: readonly DcrValidationRuleRow[]
}

/**
 * P2-derived lineage for the candidate: the dataset-version inputs
 * (ADR 0011; a set — canonical order) and the ordered topological producing
 * node list (p2-6; order is meaning — preserved, never sorted).
 */
export interface DcrLineage {
  readonly inputVersionIds?: readonly string[]
  readonly nodes?: readonly string[]
}

/** The privacyFindings slot: the one canonical "not computed" spelling (D17-Q6a). */
export interface DcrPrivacyFindings {
  readonly status: 'not-computed'
  readonly disclosure: string
}

/** The `deltas` block: M6's aspects mirrored (D17-Q2); empty aspects spelled by absence. */
export interface DcrDeltas {
  /** Canonical order: column ascending, then the documented kind order. */
  readonly schemaDrift?: readonly DcrSchemaDriftFinding[]
  /** Canonical order: column ascending. */
  readonly columnDeltas?: readonly DcrColumnDistributionDelta[]
  /** Present only when explicit keys were supplied (D17-Q7). */
  readonly rowDiff?: DcrRowDiff
}

/**
 * A parsed, structurally validated DCR artifact v1 (from `parseDcr` or a
 * correctly built AST). Collections are canonical: sorted where order is not
 * meaning, empty collections absent.
 */
export interface DcrArtifactV1 {
  readonly format: typeof DCR_FORMAT
  readonly version: DcrVersion
  readonly base: DcrVersionRef
  readonly candidate: DcrVersionRef
  readonly deltas: DcrDeltas
  /** Absent when the run carried no validate verdicts. */
  readonly validation?: readonly DcrValidationVerdict[]
  /** Absent when the producer had no lineage to carry. */
  readonly lineage?: DcrLineage
  readonly privacyFindings: DcrPrivacyFindings
}

/**
 * Canonical string ordering: ascending code-unit comparison. Deterministic
 * and locale-independent (never `localeCompare`) — mirrors
 * `compareNodeIds`.
 */
export function compareDcrStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Canonical order of two schema-drift findings: column, then documented kind order. */
export function compareDcrSchemaDriftFindings(
  a: DcrSchemaDriftFinding,
  b: DcrSchemaDriftFinding,
): number {
  const byColumn = compareDcrStrings(a.column, b.column)
  if (byColumn !== 0) return byColumn
  const kindA = DCR_SCHEMA_DRIFT_KIND_ORDER[a.kind]
  const kindB = DCR_SCHEMA_DRIFT_KIND_ORDER[b.kind]
  if (kindA !== kindB) return kindA - kindB
  return 0
}

/** Canonical order of two row-diff aspect results: the documented aspect order. */
export function compareDcrAspects(a: DcrRowDiffAspectResult, b: DcrRowDiffAspectResult): number {
  const indexA = DCR_ROW_DIFF_ASPECTS.indexOf(a.aspect)
  const indexB = DCR_ROW_DIFF_ASPECTS.indexOf(b.aspect)
  if (indexA !== indexB) return indexA - indexB
  return 0
}
