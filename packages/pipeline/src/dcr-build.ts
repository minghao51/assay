// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure DCR artifact builder (p3-1; ADR 0046/D17-Q5): typed producer
 * inputs → a canonical {@link DcrArtifactV1}, never a throw.
 *
 * This is the one seam both ruled entry points share (D17-Q5: the CLI
 * subcommand and the web panel action off a gated run) — p3-2 derives the
 * candidate reference, p3-3/p3-4 wire the surfaces, and all of them call
 * this builder so neither surface can invent a different artifact shape.
 *
 * ## Contract
 *
 * - **Normalizes to the canonical AST**: name-keyed collections are sorted
 *   (order is not meaning), producer orders preserved (samples, top-k
 *   lists, topological nodes), empty collections spelled by absence, the
 *   `format`/`version` stamp and the canonical `privacyFindings` disclosure
 *   (D17-Q6a) supplied by the builder — a producer cannot vary them.
 * - **Validates the ruled contract**, degrading to collected typed
 *   {@link DcrError}s with AST paths (never a throw): non-empty NUL-free
 *   strings, the reserved `assay_dcr_*` namespace refused in id positions
 *   (D17-Q9), the anchor-free row-key grammar (spec §5), exact integer/range
 *   domains, the m6-1 case-insensitive key-uniqueness rule, and D17-Q7's
 *   explicit-keys requirement for a `rowDiff` block.
 * - **Supplies nothing else**: no timestamps (D17-Q11 — no wall-clock field
 *   exists), no identity/status (D17-Q10), no hosted fields (M10/G3).
 *
 * Purity: no React, no browser APIs, no engine, no clock (lint-enforced).
 */
import {
  DCR_FORMAT,
  DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
  DCR_PROFILE_COLUMN_KINDS,
  DCR_RESERVED_PREFIX,
  DCR_SCHEMA_DRIFT_KINDS,
  DCR_VERSION,
  compareDcrAspects,
  compareDcrSchemaDriftFindings,
  compareDcrStrings,
  isAnchorFreeRowKey,
  isDcrColumnTypeFamily,
  isDcrProfileColumnKind,
  isDcrRowDiffAspect,
  isDcrSchemaDriftKind,
} from './dcr-ast.js'
import type {
  DcrArtifactV1,
  DcrCategoricalTopKEntry,
  DcrColumnDistributionDelta,
  DcrDeltas,
  DcrLineage,
  DcrProvenance,
  DcrRowDiff,
  DcrRowDiffAspectResult,
  DcrRowDiffSample,
  DcrSchemaDriftFinding,
  DcrSchemaFingerprint,
  DcrValidationRuleRow,
  DcrValidationVerdict,
  DcrVersionRef,
} from './dcr-ast.js'
import type { DcrBuildResult, DcrError, DcrErrorCode } from './dcr-errors.js'

/**
 * The producer-facing builder input: the compared sides, the mirrored M6
 * aspects, and the optional validation/lineage sections. The `format`/
 * `version` stamp and the `privacyFindings` disclosure are supplied by the
 * builder itself (D17-Q1/Q6a) — they are format facts, not producer facts.
 */
export interface DcrBuilderInput {
  /** The reference side of the comparison. */
  readonly base: DcrVersionRef
  /** The candidate side of the comparison (the D17-Q4 identity). */
  readonly candidate: DcrVersionRef
  /** The compared aspects (D17-Q2: M6's schemaDrift / columnDeltas / rowDiff). */
  readonly deltas: DcrDeltas
  /** Value-free validate verdicts; an empty list is spelled by absence. */
  readonly validation?: readonly DcrValidationVerdict[]
  /** P2-derived lineage; nothing to carry is spelled by absence. */
  readonly lineage?: DcrLineage
}

interface BuildContext {
  readonly errors: DcrError[]
}

function fail(ctx: BuildContext, code: DcrErrorCode, message: string, path: string): null {
  ctx.errors.push({ code, message, path })
  return null
}

/** Build the canonical artifact. Total: never throws; malformed input yields typed errors. */
export function buildDcrArtifact(input: DcrBuilderInput): DcrBuildResult {
  const ctx: BuildContext = { errors: [] }
  const record = asRecord(input)
  const base = walkRef(ctx, asRecord(record.base), 'base')
  const candidate = walkRef(ctx, asRecord(record.candidate), 'candidate')
  const deltas = walkDeltas(ctx, asRecord(record.deltas))
  const validation = walkValidation(ctx, record.validation, 'validation')
  const lineage = walkLineage(ctx, asRecord(record.lineage))
  if (ctx.errors.length > 0 || base === null || candidate === null || deltas === null) {
    return { ok: false, errors: ctx.errors }
  }
  // A null validation/lineage here would mean a collected error — absent is
  // the only honest spelling at this point.
  const verdicts = validation === null ? undefined : validation
  const lineageBlock = lineage === null ? undefined : lineage
  const artifact: DcrArtifactV1 = {
    format: DCR_FORMAT,
    version: DCR_VERSION,
    base,
    candidate,
    deltas,
    ...(verdicts !== undefined ? { validation: verdicts } : {}),
    ...(lineageBlock !== undefined ? { lineage: lineageBlock } : {}),
    // D17-Q6a: the builder supplies the canonical disclosure — an honesty
    // statement no producer can vary or omit.
    privacyFindings: { status: 'not-computed', disclosure: DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE },
  }
  return { ok: true, artifact }
}

// --- defensive readers --------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** A required non-empty NUL-free string at `record[path]`. */
function reqText(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = record[key]
  if (typeof value !== 'string') {
    return fail(
      ctx,
      'wrong-type',
      `${path}: expected a non-empty string${value === undefined ? '' : ` (got a ${typeof value} value)`}`,
      path,
    )
  }
  if (value.length === 0) {
    return fail(ctx, 'out-of-range', `${path}: must be a non-empty string`, path)
  }
  if (value.includes('\u0000')) {
    return fail(ctx, 'out-of-range', `${path}: must not contain a NUL character`, path)
  }
  return value
}

/** An optional non-empty NUL-free string; absent stays absent. */
function optText(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  const text = reqText(ctx, { [key]: value }, key, path)
  return text
}

/** A required non-empty string in an id position: the reserved namespace is refused. */
function reqIdText(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const text = reqText(ctx, record, key, path)
  if (text === null) return null
  if (text.toLowerCase().startsWith(DCR_RESERVED_PREFIX)) {
    return fail(
      ctx,
      'reserved-identifier',
      `${path}: identifiers beginning with "${DCR_RESERVED_PREFIX}" are reserved for the DCR format itself (D17-Q9) — choose another id`,
      path,
    )
  }
  return text
}

/** A required safe integer within `[min, max]`. */
function reqInt(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number | null {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail(ctx, 'wrong-type', `${path}: expected an integer within ±2^53`, path)
  }
  const num = value === 0 ? 0 : value
  if (num < min || num > max) {
    return fail(
      ctx,
      'out-of-range',
      `${path}: must be between ${String(min)} and ${String(max)} (got ${String(num)})`,
      path,
    )
  }
  return num
}

/** An optional safe integer within `[min, max]`; absent stays absent. */
function optInt(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number | undefined | null {
  if (record[key] === undefined) return undefined
  return reqInt(ctx, record, key, path, min, max)
}

/** A required finite number or explicit `null`, within `[min, max]` when a number. */
function reqFiniteOrNull(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number = -Number.MAX_VALUE,
  max: number = Number.MAX_VALUE,
): number | null {
  const value = record[key]
  if (value === undefined) {
    fail(ctx, 'missing-key', `${path}: expected a finite number or null`, path)
    return null
  }
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx, 'wrong-type', `${path}: expected a finite number or null`, path)
    return null
  }
  const num = value === 0 ? 0 : value
  if (num < min || num > max) {
    fail(
      ctx,
      'out-of-range',
      `${path}: must be between ${String(min)} and ${String(max)} (got ${String(num)})`,
      path,
    )
    return null
  }
  return num
}

function reqBoolean(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | null {
  const value = record[key]
  if (typeof value !== 'boolean') {
    return fail(ctx, 'wrong-type', `${path}: expected true or false`, path)
  }
  return value
}

function reqEnum<T extends string>(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  label: string,
  is: (value: unknown) => value is T,
): T | null {
  const text = reqText(ctx, record, key, path)
  if (text === null) return null
  if (!is(text)) {
    return fail(
      ctx,
      'out-of-range',
      `${path}: unknown ${label} ${JSON.stringify(text)} — expected one of: ${allowed.join(', ')}`,
      path,
    )
  }
  return text
}

/** An optional enum-valued field; absent stays absent, foreign values are errors. */
function optEnum<T extends string>(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
  is: (value: unknown) => value is T,
): T | undefined | null {
  if (record[key] === undefined) return undefined
  const text = reqText(ctx, record, key, path)
  if (text === null) return null
  if (!is(text)) {
    return fail(ctx, 'out-of-range', `${path}: unrecognized value ${JSON.stringify(text)}`, path)
  }
  return text
}

/**
 * An optional finite number or explicit `null`, within `[min, max]` when a
 * number. Three states: `undefined` = absent (or a read error — collected in
 * `ctx.errors`, which aborts the build at the end), `null` = the explicit
 * "not observed" spelling, a number = the value.
 */
function optFiniteOrNull(
  ctx: BuildContext,
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
): number | null | undefined {
  if (record[key] === undefined) return undefined
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx, 'wrong-type', `${path}: expected a finite number or null`, path)
    return undefined
  }
  const num = value === 0 ? 0 : value
  if (num < min || num > max) {
    fail(
      ctx,
      'out-of-range',
      `${path}: must be between ${String(min)} and ${String(max)} (got ${String(num)})`,
      path,
    )
    return undefined
  }
  return num
}

/**
 * A string list, canonicalized: sorted ascending, duplicates refused (order
 * is not meaning).
 */
function sortedUniqueSeq(
  ctx: BuildContext,
  value: unknown,
  path: string,
  noun: string,
): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    return fail(ctx, 'wrong-type', `${path}: expected a sequence of strings`, path)
  }
  const out: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\u0000')) {
      return fail(
        ctx,
        'wrong-type',
        `${path}[${String(index)}]: expected a non-empty string without a NUL character`,
        path,
      )
    }
    out.push(item)
  }
  const seen = new Set<string>()
  for (const text of out) {
    if (seen.has(text)) {
      return fail(
        ctx,
        'duplicate-reference',
        `${path}: duplicate ${noun} ${JSON.stringify(text)} — each may appear at most once`,
        path,
      )
    }
    seen.add(text)
  }
  return [...out].sort(compareDcrStrings)
}

/** A string list whose order is meaning: duplicates refused, order preserved. */
function orderedUniqueSeq(
  ctx: BuildContext,
  value: unknown,
  path: string,
  noun: string,
): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    return fail(ctx, 'wrong-type', `${path}: expected a sequence of strings`, path)
  }
  const out: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\u0000')) {
      return fail(
        ctx,
        'wrong-type',
        `${path}[${String(index)}]: expected a non-empty string without a NUL character`,
        path,
      )
    }
    out.push(item)
  }
  const seen = new Set<string>()
  for (const text of out) {
    if (seen.has(text)) {
      return fail(
        ctx,
        'duplicate-reference',
        `${path}: duplicate ${noun} ${JSON.stringify(text)} — each may appear at most once`,
        path,
      )
    }
    seen.add(text)
  }
  return out
}

// --- section builders -----------------------------------------------------------

function walkRef(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrVersionRef | null {
  const datasetId = reqText(ctx, record, 'datasetId', `${path}.datasetId`)
  const versionId = reqText(ctx, record, 'versionId', `${path}.versionId`)
  const fingerprintRecord = asRecord(record.schemaFingerprint)
  const algorithm = reqText(
    ctx,
    fingerprintRecord,
    'algorithm',
    `${path}.schemaFingerprint.algorithm`,
  )
  const fingerprintValue = reqText(
    ctx,
    fingerprintRecord,
    'value',
    `${path}.schemaFingerprint.value`,
  )
  const materialization = walkMaterialization(ctx, record, path)
  const provenance = walkProvenance(ctx, record.provenance, `${path}.provenance`)
  if (
    datasetId === null ||
    versionId === null ||
    algorithm === null ||
    fingerprintValue === null ||
    materialization === null
  ) {
    return null
  }
  if (provenance === null) return null // the error is already collected
  const schemaFingerprint: DcrSchemaFingerprint = { algorithm, value: fingerprintValue }
  return {
    datasetId,
    versionId,
    schemaFingerprint,
    ...(provenance !== undefined ? { provenance } : {}),
    materialization,
  }
}

function walkProvenance(
  ctx: BuildContext,
  value: unknown,
  path: string,
): DcrProvenance | undefined | null {
  if (value === undefined) return undefined
  const record = asRecord(value)
  const recipe = optText(ctx, record, 'transformationRecipe', `${path}.transformationRecipe`)
  if (recipe === null) return null
  const parents = sortedUniqueSeq(
    ctx,
    record.parentVersionIds,
    `${path}.parentVersionIds`,
    'parent version id',
  )
  if (parents === null) return null
  if (recipe === undefined && (parents === undefined || parents.length === 0)) {
    return fail(
      ctx,
      'out-of-range',
      `${path}: carries no provenance — omit the provenance block, or name a transformation recipe / parent versions`,
      path,
    )
  }
  return {
    ...(recipe !== undefined ? { transformationRecipe: recipe } : {}),
    ...(parents !== undefined && parents.length > 0 ? { parentVersionIds: parents } : {}),
  }
}

function walkMaterialization(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrVersionRef['materialization'] | null {
  const refRecord = asRecord(record.materialization)
  const hasNode = refRecord.node !== undefined
  const hasExport = refRecord['export'] !== undefined
  if (hasNode === hasExport) {
    return fail(
      ctx,
      hasNode ? 'out-of-range' : 'missing-key',
      hasNode
        ? `${path}.materialization: exactly one of "node" / "export" may be present (one shape per meaning)`
        : `${path}.materialization: exactly one of "node" / "export" is required (the D17-Q4 materialization reference)`,
      `${path}.materialization`,
    )
  }
  if (hasNode) {
    const node = reqIdText(ctx, refRecord, 'node', `${path}.materialization.node`)
    return node === null ? null : { node }
  }
  // The runner's value-free export path (p3-2's discipline): non-empty,
  // NUL-free — the builder cannot judge sensitivity, the producer owns that.
  const exportPath = reqText(ctx, refRecord, 'export', `${path}.materialization.export`)
  return exportPath === null ? null : { export: exportPath }
}

function walkDeltas(ctx: BuildContext, record: Record<string, unknown>): DcrDeltas | null {
  let schemaDrift: readonly DcrSchemaDriftFinding[] | undefined
  if (record.schemaDrift !== undefined) {
    if (!Array.isArray(record.schemaDrift)) {
      fail(
        ctx,
        'wrong-type',
        'deltas.schemaDrift: expected a sequence of findings',
        'deltas.schemaDrift',
      )
      return null
    }
    const findings: DcrSchemaDriftFinding[] = []
    for (const [index, item] of asArray(record.schemaDrift).entries()) {
      const finding = walkFinding(ctx, asRecord(item), `deltas.schemaDrift[${String(index)}]`)
      if (finding === null) return null
      findings.push(finding)
    }
    const seen = new Set<string>()
    for (const finding of findings) {
      const id = `${JSON.stringify(finding.column)}\u0000${finding.kind}`
      if (seen.has(id)) {
        fail(
          ctx,
          'duplicate-reference',
          `deltas.schemaDrift: duplicate finding for column ${JSON.stringify(finding.column)} and kind "${finding.kind}"`,
          'deltas.schemaDrift',
        )
        return null
      }
      seen.add(id)
    }
    schemaDrift = findings.sort(compareDcrSchemaDriftFindings)
  }

  let columnDeltas: readonly DcrColumnDistributionDelta[] | undefined
  if (record.columnDeltas !== undefined) {
    if (!Array.isArray(record.columnDeltas)) {
      fail(
        ctx,
        'wrong-type',
        'deltas.columnDeltas: expected a sequence of deltas',
        'deltas.columnDeltas',
      )
      return null
    }
    const deltas: DcrColumnDistributionDelta[] = []
    for (const [index, item] of asArray(record.columnDeltas).entries()) {
      const delta = walkColumnDelta(ctx, asRecord(item), `deltas.columnDeltas[${String(index)}]`)
      if (delta === null) return null
      deltas.push(delta)
    }
    const seen = new Set<string>()
    for (const delta of deltas) {
      if (seen.has(delta.column)) {
        fail(
          ctx,
          'duplicate-reference',
          `deltas.columnDeltas: duplicate delta for column ${JSON.stringify(delta.column)}`,
          'deltas.columnDeltas',
        )
        return null
      }
      seen.add(delta.column)
    }
    columnDeltas = deltas.sort((a, b) => compareDcrStrings(a.column, b.column))
  }

  const rowDiff = walkRowDiff(ctx, record.rowDiff)
  if (rowDiff === null) return null
  return {
    ...(schemaDrift !== undefined && schemaDrift.length > 0 ? { schemaDrift } : {}),
    ...(columnDeltas !== undefined && columnDeltas.length > 0 ? { columnDeltas } : {}),
    ...(rowDiff !== undefined ? { rowDiff } : {}),
  }
}

function walkFinding(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrSchemaDriftFinding | null {
  const kind = reqEnum(
    ctx,
    record,
    'kind',
    `${path}.kind`,
    DCR_SCHEMA_DRIFT_KINDS,
    'schema-drift kind',
    isDcrSchemaDriftKind,
  )
  const column = reqText(ctx, record, 'column', `${path}.column`)
  // The optional readers collect their own errors and return best-effort
  // values; any collected error aborts the build before an artifact ships.
  const typeA = optText(ctx, record, 'typeA', `${path}.typeA`)
  const typeB = optText(ctx, record, 'typeB', `${path}.typeB`)
  const familyA = optEnum(ctx, record, 'familyA', `${path}.familyA`, isDcrColumnTypeFamily)
  const familyB = optEnum(ctx, record, 'familyB', `${path}.familyB`, isDcrColumnTypeFamily)
  const nullShareA = optFiniteOrNull(ctx, record, 'nullShareA', `${path}.nullShareA`, 0, 1)
  const nullShareB = optFiniteOrNull(ctx, record, 'nullShareB', `${path}.nullShareB`, 0, 1)
  if (kind === null || column === null) return null
  if (typeA === null || typeB === null || familyA === null || familyB === null) return null
  return {
    kind,
    column,
    ...(typeA !== undefined ? { typeA } : {}),
    ...(typeB !== undefined ? { typeB } : {}),
    ...(familyA !== undefined ? { familyA } : {}),
    ...(familyB !== undefined ? { familyB } : {}),
    ...(nullShareA !== undefined ? { nullShareA } : {}),
    ...(nullShareB !== undefined ? { nullShareB } : {}),
  }
}

function walkColumnDelta(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrColumnDistributionDelta | null {
  const column = reqText(ctx, record, 'column', `${path}.column`)
  const typeA = reqText(ctx, record, 'typeA', `${path}.typeA`)
  const typeB = reqText(ctx, record, 'typeB', `${path}.typeB`)
  const kindA = reqEnum(
    ctx,
    record,
    'kindA',
    `${path}.kindA`,
    DCR_PROFILE_COLUMN_KINDS,
    'profile column kind',
    isDcrProfileColumnKind,
  )
  const kindB = reqEnum(
    ctx,
    record,
    'kindB',
    `${path}.kindB`,
    DCR_PROFILE_COLUMN_KINDS,
    'profile column kind',
    isDcrProfileColumnKind,
  )
  if (column === null || typeA === null || typeB === null || kindA === null || kindB === null)
    return null
  let numeric: DcrColumnDistributionDelta['numeric']
  if (record.numeric !== undefined) {
    // The four metrics are required (finite or explicit null); a violation
    // is collected and aborts the build, so the assembled placeholder below
    // never ships.
    const numericRecord = asRecord(record.numeric)
    numeric = {
      meanShiftStandardized: reqFiniteOrNull(
        ctx,
        numericRecord,
        'meanShiftStandardized',
        `${path}.numeric.meanShiftStandardized`,
      ),
      varianceShiftStandardized: reqFiniteOrNull(
        ctx,
        numericRecord,
        'varianceShiftStandardized',
        `${path}.numeric.varianceShiftStandardized`,
      ),
      p50Shift: reqFiniteOrNull(ctx, numericRecord, 'p50Shift', `${path}.numeric.p50Shift`),
      p90Shift: reqFiniteOrNull(ctx, numericRecord, 'p90Shift', `${path}.numeric.p90Shift`),
    }
  }
  let categorical: DcrColumnDistributionDelta['categorical']
  if (record.categorical !== undefined) {
    const categoricalRecord = asRecord(record.categorical)
    const newCategories = walkTopKSeq(
      ctx,
      categoricalRecord.newCategories,
      `${path}.categorical.newCategories`,
    )
    const vanishedCategories = walkTopKSeq(
      ctx,
      categoricalRecord.vanishedCategories,
      `${path}.categorical.vanishedCategories`,
    )
    categorical = {
      totalVariation: reqFiniteOrNull(
        ctx,
        categoricalRecord,
        'totalVariation',
        `${path}.categorical.totalVariation`,
        0,
        1,
      ),
      newCategories: newCategories ?? [],
      vanishedCategories: vanishedCategories ?? [],
    }
  }
  return {
    column,
    typeA,
    typeB,
    kindA,
    kindB,
    ...(numeric !== undefined ? { numeric } : {}),
    ...(categorical !== undefined ? { categorical } : {}),
  }
}

/** Producer-ordered top-k entries (frequency rank is meaning); duplicates refused. */
function walkTopKSeq(
  ctx: BuildContext,
  value: unknown,
  path: string,
): readonly DcrCategoricalTopKEntry[] | null {
  if (value === undefined) {
    // The categorical block always spells both lists (possibly empty).
    return []
  }
  if (!Array.isArray(value)) {
    return fail(ctx, 'wrong-type', `${path}: expected a sequence of {value, count} entries`, path)
  }
  const out: DcrCategoricalTopKEntry[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    const entryPath = `${path}[${String(index)}]`
    const entryRecord = asRecord(item)
    const entryValue = reqText(ctx, entryRecord, 'value', `${entryPath}.value`)
    const count = reqInt(ctx, entryRecord, 'count', `${entryPath}.count`, 0)
    if (entryValue === null || count === null) return null
    if (seen.has(entryValue)) {
      return fail(
        ctx,
        'duplicate-reference',
        `${path}: duplicate category ${JSON.stringify(entryValue)} — each category may appear at most once per list`,
        path,
      )
    }
    seen.add(entryValue)
    out.push({ value: entryValue, count })
  }
  return out
}

function walkRowDiff(ctx: BuildContext, value: unknown): DcrRowDiff | undefined | null {
  if (value === undefined) return undefined
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return undefined
  // D17-Q7: explicit keys REQUIRED — a rowDiff block with no (or an empty)
  // key list is a typed error, never an inference opportunity.
  const keysRecord = record.keys
  if (!Array.isArray(keysRecord) || keysRecord.length === 0) {
    return fail(
      ctx,
      Array.isArray(keysRecord) ? 'out-of-range' : 'wrong-type',
      Array.isArray(keysRecord)
        ? 'deltas.rowDiff.keys: a rowDiff block requires an explicit non-empty key list (D17-Q7: no silent inference; omit the whole rowDiff block when no keys were supplied)'
        : 'deltas.rowDiff.keys: expected a non-empty sequence of key column names',
      'deltas.rowDiff.keys',
    )
  }
  const seen = new Set<string>()
  const keys: string[] = []
  for (const [index, item] of keysRecord.entries()) {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\u0000')) {
      return fail(
        ctx,
        'wrong-type',
        `deltas.rowDiff.keys[${String(index)}]: expected a non-empty key column name without a NUL character`,
        'deltas.rowDiff.keys',
      )
    }
    const lower = item.toLowerCase()
    if (seen.has(lower)) {
      return fail(
        ctx,
        'duplicate-reference',
        `deltas.rowDiff.keys: duplicate key column ${JSON.stringify(item)} — key columns must be distinct (identifiers are case-insensitive)`,
        'deltas.rowDiff.keys',
      )
    }
    seen.add(lower)
    keys.push(item)
  }
  const sampleLimit = reqInt(ctx, record, 'sampleLimit', 'deltas.rowDiff.sampleLimit', 1)
  const rowCountA = reqInt(ctx, record, 'rowCountA', 'deltas.rowDiff.rowCountA', 0)
  const rowCountB = reqInt(ctx, record, 'rowCountB', 'deltas.rowDiff.rowCountB', 0)
  if (sampleLimit === null || rowCountA === null || rowCountB === null) return null
  if (!Array.isArray(record.aspects)) {
    fail(
      ctx,
      'wrong-type',
      'deltas.rowDiff.aspects: expected a sequence of aspect results',
      'deltas.rowDiff.aspects',
    )
    return null
  }
  const aspects: DcrRowDiffAspectResult[] = []
  const aspectSeen = new Set<string>()
  for (const [index, item] of record.aspects.entries()) {
    const aspect = walkAspect(ctx, asRecord(item), `deltas.rowDiff.aspects[${String(index)}]`)
    if (aspect === null) return null
    if (aspectSeen.has(aspect.aspect)) {
      return fail(
        ctx,
        'duplicate-reference',
        `deltas.rowDiff.aspects: duplicate aspect "${aspect.aspect}" — exactly one entry per aspect (added, removed, changed)`,
        'deltas.rowDiff.aspects',
      )
    }
    aspectSeen.add(aspect.aspect)
    aspects.push(aspect)
  }
  if (aspectSeen.size !== 3) {
    return fail(
      ctx,
      'missing-key',
      `deltas.rowDiff.aspects: expected exactly three aspects (added, removed, changed), got ${String(aspectSeen.size)}`,
      'deltas.rowDiff.aspects',
    )
  }
  return {
    keys,
    sampleLimit,
    rowCountA,
    rowCountB,
    aspects: aspects.sort(compareDcrAspects),
  }
}

function walkAspect(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrRowDiffAspectResult | null {
  const aspect = reqEnum(
    ctx,
    record,
    'aspect',
    `${path}.aspect`,
    DCR_ROW_DIFF_ASPECT_NAMES,
    'row-diff aspect',
    isDcrRowDiffAspect,
  )
  const count = reqInt(ctx, record, 'count', `${path}.count`, 0)
  if (aspect === null || count === null) return null
  if (!Array.isArray(record.samples)) {
    return fail(
      ctx,
      'wrong-type',
      `${path}.samples: expected a sequence of samples`,
      `${path}.samples`,
    )
  }
  const samples: DcrRowDiffSample[] = []
  for (const [index, item] of record.samples.entries()) {
    const sample = walkSample(ctx, asRecord(item), `${path}.samples[${String(index)}]`)
    if (sample === null) return null
    samples.push(sample)
  }
  if (samples.length > count) {
    return fail(
      ctx,
      'out-of-range',
      `${path}: ${String(samples.length)} samples exceed the aspect's exact count ${String(count)} — samples are a bounded subset of the counted rows`,
      path,
    )
  }
  return { aspect, count, samples }
}

const DCR_ROW_DIFF_ASPECT_NAMES = ['added', 'removed', 'changed'] as const

function walkSample(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrRowDiffSample | null {
  const side = reqEnum(
    ctx,
    record,
    'side',
    `${path}.side`,
    DCR_SAMPLE_SIDES,
    'row-diff side',
    isDcrSampleSide,
  )
  const rowKey = reqText(ctx, record, 'rowKey', `${path}.rowKey`)
  if (side === null || rowKey === null) return null
  // ADR 0025 shape-pin: anchor-free export grammar only — a host-derived
  // grid anchor can never enter the artifact.
  if (!isAnchorFreeRowKey(rowKey)) {
    // The key text is never echoed: a hostile key can carry a grid anchor
    // (a host/session fingerprint), so the diagnostic names the grammar,
    // not the value (ADR 0025 extends to diagnostics).
    return fail(
      ctx,
      'invalid-reference',
      `${path}.rowKey: is outside the anchor-free export grammar "base:<ordinal>" / "insert:<seq>" / "b:<ordinal>" (row keys are ordinals, never dataset values or grid anchors)`,
      `${path}.rowKey`,
    )
  }
  const changed = sortedUniqueSeq(
    ctx,
    record.changedColumns,
    `${path}.changedColumns`,
    'column name',
  )
  if (changed === null) return null
  return {
    side,
    rowKey,
    ...(changed !== undefined && changed.length > 0 ? { changedColumns: changed } : {}),
  }
}

const DCR_SAMPLE_SIDES = ['A', 'B'] as const

function isDcrSampleSide(value: unknown): value is 'A' | 'B' {
  return value === 'A' || value === 'B'
}

function walkValidation(
  ctx: BuildContext,
  value: unknown,
  path: string,
): readonly DcrValidationVerdict[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    return fail(ctx, 'wrong-type', `${path}: expected a sequence of verdicts`, path)
  }
  const verdicts: DcrValidationVerdict[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    const verdict = walkVerdict(ctx, asRecord(item), `${path}[${String(index)}]`)
    if (verdict === null) return null
    if (seen.has(verdict.nodeId)) {
      return fail(
        ctx,
        'duplicate-reference',
        `${path}: duplicate verdict for node ${JSON.stringify(verdict.nodeId)} — at most one verdict per node`,
        path,
      )
    }
    seen.add(verdict.nodeId)
    verdicts.push(verdict)
  }
  return verdicts.length > 0
    ? verdicts.sort((a, b) => compareDcrStrings(a.nodeId, b.nodeId))
    : undefined
}

function walkVerdict(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrValidationVerdict | null {
  const nodeId = reqIdText(ctx, record, 'nodeId', `${path}.nodeId`)
  const input = reqText(ctx, record, 'input', `${path}.input`)
  const valid = reqBoolean(ctx, record, 'valid', `${path}.valid`)
  const violatedRules = reqInt(ctx, record, 'violatedRules', `${path}.violatedRules`, 0)
  const rowCount = optInt(ctx, record, 'rowCount', `${path}.rowCount`, 0)
  if (nodeId === null || input === null || valid === null || violatedRules === null) return null
  if (rowCount === null) return null
  let rules: readonly DcrValidationRuleRow[] | undefined
  if (record.rules !== undefined) {
    if (!Array.isArray(record.rules)) {
      return fail(
        ctx,
        'wrong-type',
        `${path}.rules: expected a sequence of rule rows`,
        `${path}.rules`,
      )
    }
    const rows: DcrValidationRuleRow[] = []
    const ruleSeen = new Set<string>()
    for (const [index, item] of record.rules.entries()) {
      const rule = walkRule(ctx, asRecord(item), `${path}.rules[${String(index)}]`)
      if (rule === null) return null
      if (ruleSeen.has(rule.ruleId)) {
        return fail(
          ctx,
          'duplicate-reference',
          `${path}.rules: duplicate rule ${JSON.stringify(rule.ruleId)} — at most one row per rule id`,
          `${path}.rules`,
        )
      }
      ruleSeen.add(rule.ruleId)
      rows.push(rule)
    }
    rules = rows.length > 0 ? rows.sort((a, b) => compareDcrStrings(a.ruleId, b.ruleId)) : undefined
  }
  return {
    nodeId,
    input,
    valid,
    violatedRules,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(rules !== undefined ? { rules } : {}),
  }
}

function walkRule(
  ctx: BuildContext,
  record: Record<string, unknown>,
  path: string,
): DcrValidationRuleRow | null {
  const ruleId = reqText(ctx, record, 'ruleId', `${path}.ruleId`)
  const kind = optText(ctx, record, 'kind', `${path}.kind`)
  const column = optText(ctx, record, 'column', `${path}.column`)
  const failCount = reqInt(ctx, record, 'failCount', `${path}.failCount`, 0)
  const failPercent = reqInt(ctx, record, 'failPercent', `${path}.failPercent`, 0, 100)
  if (
    ruleId === null ||
    kind === null ||
    column === null ||
    failCount === null ||
    failPercent === null
  ) {
    return null
  }
  return {
    ruleId,
    ...(kind !== undefined ? { kind } : {}),
    ...(column !== undefined ? { column } : {}),
    failCount,
    failPercent,
  }
}

function walkLineage(
  ctx: BuildContext,
  record: Record<string, unknown>,
): DcrLineage | undefined | null {
  if (Object.keys(record).length === 0) return undefined
  const inputVersionIds = sortedUniqueSeq(
    ctx,
    record.inputVersionIds,
    'lineage.inputVersionIds',
    'version id',
  )
  if (inputVersionIds === null) return null
  const nodes = orderedUniqueSeq(ctx, record.nodes, 'lineage.nodes', 'node id')
  if (nodes === null) return null
  // Node ids are id-position fields: the reserved namespace is refused
  // (dataset-side version ids are user data and are not reserved).
  for (const node of nodes ?? []) {
    if (node.toLowerCase().startsWith(DCR_RESERVED_PREFIX)) {
      return fail(
        ctx,
        'reserved-identifier',
        `lineage.nodes: identifiers beginning with "${DCR_RESERVED_PREFIX}" are reserved for the DCR format itself (D17-Q9) — choose another id`,
        'lineage.nodes',
      )
    }
  }
  if (
    (inputVersionIds === undefined || inputVersionIds.length === 0) &&
    (nodes === undefined || nodes.length === 0)
  ) {
    return fail(
      ctx,
      'out-of-range',
      'lineage: carries no lineage — omit the lineage block, or name at least one input version / producing node',
      'lineage',
    )
  }
  return {
    ...(inputVersionIds !== undefined && inputVersionIds.length > 0 ? { inputVersionIds } : {}),
    ...(nodes !== undefined && nodes.length > 0 ? { nodes } : {}),
  }
}
