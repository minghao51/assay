// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical DCR artifact serializer (p3-1; ADR 0046): one `DcrArtifactV1` →
 * one exact YAML text, byte-stable everywhere the format appears.
 *
 * ## Canonical form
 *
 * - Root keys in fixed order: `format`, `version`, `base`, `candidate`,
 *   `deltas`, `validation`, `lineage`, `privacyFindings`.
 * - Every nested mapping is rebuilt as an explicitly ordered `Map` or typed
 *   object — there is no generic/free-form mapping anywhere in the grammar,
 *   so canonical output depends on the AST only, never on JS key insertion
 *   order.
 * - Canonical collection orders are enforced defensively on the way out
 *   (sorted name-keyed collections, documented aspect order) so even a
 *   hand-assembled AST serializes canonically.
 * - Lists of scalars render as flow sequences (`[ a, b ]`); lists of
 *   mappings render block style; 2-space indent, `lineWidth: 0` (no
 *   folding), single trailing newline.
 * - `-0` normalizes to `0` (one shape per meaning, the contracts
 *   precedent); absent-but-empty collections stay absent.
 * - **No wall-clock exists anywhere in the output** (D17-Q11): there is no
 *   timestamp field in the grammar and none is synthesized.
 *
 * ## Trust boundary
 *
 * The parameter is *typed*: callers pass a `DcrArtifactV1` from `parseDcr`
 * or `buildDcrArtifact`. The function is still total — every field is read
 * defensively, so a caller bug degrades to deterministic, plain output
 * rather than a raw throw (such output is not guaranteed to re-parse as a
 * valid artifact).
 *
 * Purity: no React, no browser APIs, no engine (lint-enforced).
 */
import { Document, stringify } from 'yaml'
import {
  DCR_FORMAT,
  DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
  DCR_VERSION,
  compareDcrAspects,
  compareDcrSchemaDriftFindings,
  compareDcrStrings,
  isDcrColumnTypeFamily,
  isDcrProfileColumnKind,
  isDcrRowDiffAspect,
  isDcrSchemaDriftKind,
} from './dcr-ast.js'
import type {
  DcrArtifactV1,
  DcrCategoricalTopKEntry,
  DcrColumnDistributionDelta,
  DcrRowDiffAspectResult,
  DcrRowDiffSample,
  DcrSchemaDriftFinding,
  DcrValidationRuleRow,
  DcrValidationVerdict,
} from './dcr-ast.js'

/** Serialize a DCR artifact to its canonical YAML form. Total; see the module doc. */
export function serializeDcr(artifact: DcrArtifactV1): string {
  const doc = new Document()
  const root = new Map<string, unknown>([
    ['format', asText(artifact?.format) === DCR_FORMAT ? DCR_FORMAT : asText(artifact?.format)],
    ['version', safeInt(artifact?.version) ?? DCR_VERSION],
    ['base', serializeVersionRef(doc, artifact?.base)],
    ['candidate', serializeVersionRef(doc, artifact?.candidate)],
    ['deltas', serializeDeltas(doc, artifact?.deltas)],
    ...optionalEntry('validation', serializeValidation(artifact?.validation)),
    ...optionalEntry('lineage', serializeLineage(doc, artifact?.lineage)),
    ['privacyFindings', serializePrivacy(artifact?.privacyFindings)],
  ])
  doc.contents = doc.createNode(root)
  return stringify(doc, {
    lineWidth: 0, // never fold long scalars — folding would be another canonical degree-of-freedom
    indent: 2,
  })
}

/** Emit the entry only when the mapped value is defined (absent stays absent). */
function optionalEntry(key: string, value: unknown): [string, unknown][] {
  return value === undefined ? [] : [[key, value]]
}

// --- version references -----------------------------------------------------

function serializeVersionRef(doc: Document, ref: unknown): Map<string, unknown> {
  const record = asRecord(ref)
  const fingerprint = asRecord(record.schemaFingerprint)
  return new Map<string, unknown>([
    ['datasetId', asText(record.datasetId)],
    ['versionId', asText(record.versionId)],
    [
      'schemaFingerprint',
      new Map<string, unknown>([
        ['algorithm', asText(fingerprint.algorithm)],
        ['value', asText(fingerprint.value)],
      ]),
    ],
    ...optionalEntry('provenance', serializeProvenance(doc, record.provenance)),
    ['materialization', serializeMaterialization(record.materialization)],
  ])
}

function serializeProvenance(doc: Document, provenance: unknown): Map<string, unknown> | undefined {
  const record = asRecord(provenance)
  const entries: [string, unknown][] = []
  const recipe = asOptionalText(record.transformationRecipe)
  if (recipe !== undefined) entries.push(['transformationRecipe', recipe])
  const parents = sortedUniqueStrings(record.parentVersionIds)
  if (parents.length > 0)
    entries.push(['parentVersionIds', doc.createNode(parents, { flow: true })])
  return entries.length > 0 ? new Map<string, unknown>(entries) : undefined
}

function serializeMaterialization(materialization: unknown): Map<string, unknown> {
  const record = asRecord(materialization)
  // Exactly one of the two spellings is carried (one shape per meaning); a
  // caller bug carrying both degrades deterministically to `node`.
  const node = asOptionalText(record.node)
  if (node !== undefined) return new Map<string, unknown>([['node', node]])
  return new Map<string, unknown>([['export', asText(record['export'])]])
}

// --- deltas -----------------------------------------------------------------

function serializeDeltas(doc: Document, deltas: unknown): Map<string, unknown> {
  const record = asRecord(deltas)
  const entries: [string, unknown][] = []
  const drift = asArray(record.schemaDrift)
    .map(serializeFinding)
    .sort(compareDcrSchemaDriftFindings)
  if (drift.length > 0) entries.push(['schemaDrift', doc.createNode(drift)])
  const columnDeltas = asArray(record.columnDeltas)
    .map(serializeColumnDelta)
    .sort((a, b) => compareDcrStrings(a.column, b.column))
  if (columnDeltas.length > 0) entries.push(['columnDeltas', doc.createNode(columnDeltas)])
  const rowDiff = serializeRowDiff(doc, record.rowDiff)
  if (rowDiff !== undefined) entries.push(['rowDiff', rowDiff])
  return new Map<string, unknown>(entries)
}

function serializeFinding(value: unknown): DcrSchemaDriftFinding {
  const record = asRecord(value)
  const typeA = asOptionalText(record.typeA)
  const typeB = asOptionalText(record.typeB)
  const familyA = optionalEnum(record.familyA, isDcrColumnTypeFamily)
  const familyB = optionalEnum(record.familyB, isDcrColumnTypeFamily)
  const nullShareA = optionalShare(record.nullShareA)
  const nullShareB = optionalShare(record.nullShareB)
  return {
    kind: isDcrSchemaDriftKind(record.kind) ? record.kind : 'column-added',
    column: asText(record.column),
    ...(typeA !== undefined ? { typeA } : {}),
    ...(typeB !== undefined ? { typeB } : {}),
    ...(familyA !== undefined ? { familyA } : {}),
    ...(familyB !== undefined ? { familyB } : {}),
    ...(nullShareA !== undefined ? { nullShareA } : {}),
    ...(nullShareB !== undefined ? { nullShareB } : {}),
  }
}

function serializeColumnDelta(value: unknown): DcrColumnDistributionDelta {
  const record = asRecord(value)
  const numeric = serializeNumericDelta(record.numeric)
  const categorical = serializeCategoricalDelta(record.categorical)
  return {
    column: asText(record.column),
    typeA: asText(record.typeA),
    typeB: asText(record.typeB),
    kindA: optionalEnum(record.kindA, isDcrProfileColumnKind) ?? 'other',
    kindB: optionalEnum(record.kindB, isDcrProfileColumnKind) ?? 'other',
    ...(numeric !== undefined ? { numeric } : {}),
    ...(categorical !== undefined ? { categorical } : {}),
  }
}

function serializeNumericDelta(value: unknown): DcrColumnDistributionDelta['numeric'] | undefined {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return undefined
  return {
    meanShiftStandardized: finiteOrNull(record.meanShiftStandardized),
    varianceShiftStandardized: finiteOrNull(record.varianceShiftStandardized),
    p50Shift: finiteOrNull(record.p50Shift),
    p90Shift: finiteOrNull(record.p90Shift),
  }
}

function serializeCategoricalDelta(
  value: unknown,
): DcrColumnDistributionDelta['categorical'] | undefined {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return undefined
  return {
    totalVariation: finiteOrNull(record.totalVariation),
    newCategories: asArray(record.newCategories).map(serializeTopKEntry),
    vanishedCategories: asArray(record.vanishedCategories).map(serializeTopKEntry),
    // The D19-OQ-4 bounding disclosure (p3-1b): fixed key order, appended
    // after the three base keys; carried only when spelled exactly `true`
    // (the AST type admits no other), so artifacts without bounding emit
    // byte-identically to before — absence is meaning.
    ...(record.newCategoriesBounded === true ? { newCategoriesBounded: true } : {}),
    ...(record.vanishedCategoriesBounded === true ? { vanishedCategoriesBounded: true } : {}),
  }
}

function serializeTopKEntry(value: unknown): DcrCategoricalTopKEntry {
  const record = asRecord(value)
  return { value: asText(record.value), count: safeInt(record.count) ?? 0 }
}

// --- row diff ---------------------------------------------------------------

function serializeRowDiff(doc: Document, rowDiff: unknown): Map<string, unknown> | undefined {
  const record = asRecord(rowDiff)
  if (Object.keys(record).length === 0) return undefined
  return new Map<string, unknown>([
    ['keys', doc.createNode(asStringList(record.keys), { flow: true })],
    ['sampleLimit', safeInt(record.sampleLimit) ?? 0],
    ['rowCountA', safeInt(record.rowCountA) ?? 0],
    ['rowCountB', safeInt(record.rowCountB) ?? 0],
    [
      'aspects',
      doc.createNode(
        asArray(record.aspects)
          .map(serializeAspect)
          .sort(compareDcrAspects)
          .map((aspect) => serializeAspectNode(doc, aspect)),
      ),
    ],
  ])
}

function serializeAspect(value: unknown): DcrRowDiffAspectResult {
  const record = asRecord(value)
  return {
    aspect: isDcrRowDiffAspect(record.aspect) ? record.aspect : 'added',
    count: safeInt(record.count) ?? 0,
    samples: asArray(record.samples).map(serializeSample),
  }
}

function serializeSample(value: unknown): DcrRowDiffSample {
  const record = asRecord(value)
  const changed = sortedUniqueStrings(record.changedColumns)
  return {
    side: record.side === 'B' ? 'B' : 'A',
    rowKey: asText(record.rowKey),
    ...(changed.length > 0 ? { changedColumns: changed } : {}),
  }
}

/** The canonical aspect mapping: fixed key order; scalar lists flow. */
function serializeAspectNode(doc: Document, aspect: DcrRowDiffAspectResult): Map<string, unknown> {
  return new Map<string, unknown>([
    ['aspect', aspect.aspect],
    ['count', aspect.count],
    ['samples', doc.createNode(aspect.samples.map((sample) => serializeSampleNode(doc, sample)))],
  ])
}

/** The canonical sample mapping: fixed key order; `changedColumns` flows. */
function serializeSampleNode(doc: Document, sample: DcrRowDiffSample): Map<string, unknown> {
  const entries: [string, unknown][] = [
    ['side', sample.side],
    ['rowKey', sample.rowKey],
  ]
  if (sample.changedColumns !== undefined) {
    entries.push(['changedColumns', doc.createNode(sample.changedColumns, { flow: true })])
  }
  return new Map<string, unknown>(entries)
}

// --- validation / lineage / privacy ------------------------------------------

function serializeValidation(validation: unknown): readonly DcrValidationVerdict[] | undefined {
  const verdicts = asArray(validation)
    .map((verdict) => serializeVerdict(verdict))
    .sort((a, b) => compareDcrStrings(a.nodeId, b.nodeId))
  return verdicts.length > 0 ? verdicts : undefined
}

function serializeVerdict(value: unknown): DcrValidationVerdict {
  const record = asRecord(value)
  const rowCount = safeIntOrUndefined(record.rowCount)
  const rules = serializeRules(record.rules)
  return {
    nodeId: asText(record.nodeId),
    input: asText(record.input),
    valid: record.valid === true,
    violatedRules: safeInt(record.violatedRules) ?? 0,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(rules !== undefined ? { rules } : {}),
  }
}

function serializeRules(value: unknown): readonly DcrValidationRuleRow[] | undefined {
  const rows = asArray(value)
    .map(serializeRule)
    .sort((a, b) => compareDcrStrings(a.ruleId, b.ruleId))
  return rows.length > 0 ? rows : undefined
}

function serializeRule(value: unknown): DcrValidationRuleRow {
  const record = asRecord(value)
  const kind = asOptionalText(record.kind)
  const column = asOptionalText(record.column)
  return {
    ruleId: asText(record.ruleId),
    ...(kind !== undefined ? { kind } : {}),
    ...(column !== undefined ? { column } : {}),
    failCount: safeInt(record.failCount) ?? 0,
    failPercent: safeInt(record.failPercent) ?? 0,
  }
}

function serializeLineage(doc: Document, lineage: unknown): Map<string, unknown> | undefined {
  const record = asRecord(lineage)
  const entries: [string, unknown][] = []
  const inputs = sortedUniqueStrings(record.inputVersionIds)
  if (inputs.length > 0) entries.push(['inputVersionIds', doc.createNode(inputs, { flow: true })])
  const nodes = asStringList(record.nodes)
  if (nodes.length > 0) entries.push(['nodes', doc.createNode(nodes, { flow: true })])
  return entries.length > 0 ? new Map<string, unknown>(entries) : undefined
}

function serializePrivacy(value: unknown): Map<string, unknown> {
  const record = asRecord(value)
  return new Map<string, unknown>([
    ['status', asText(record.status) === 'not-computed' ? 'not-computed' : asText(record.status)],
    [
      'disclosure',
      asText(record.disclosure) === ''
        ? DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE
        : asText(record.disclosure),
    ],
  ])
}

// --- defensive coercions -----------------------------------------------------

/** Sort + dedupe a string list defensively; non-strings degrade away. */
function sortedUniqueStrings(value: unknown): string[] {
  return [...new Set(asStringList(value))].sort(compareDcrStrings)
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalEnum<T extends string>(
  value: unknown,
  is: (candidate: unknown) => candidate is T,
): T | undefined {
  return is(value) ? value : undefined
}

/** A finite share (or explicit `null` = not observed); out-of-domain input degrades to absent. */
function optionalShare(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value
  return undefined
}

/** A finite number or `null` (the delta-metric shape), with `-0` normalized. */
function finiteOrNull(value: unknown): number | null {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value
  return null
}

/** A safe integer, with `-0` normalized to `0`; `null` for anything else. */
function safeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  return value === 0 ? 0 : value
}

function safeIntOrUndefined(value: unknown): number | undefined {
  return safeInt(value) ?? undefined
}

/**
 * Total text renderer for scalar fields. Mirrors `serialize.ts`: primitives
 * use their short form, but objects are never stringified (their coercion
 * can throw). The serializer's totality depends on it.
 */
function asText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value)
    case 'undefined':
      return 'undefined'
    case 'object':
      return value === null ? 'null' : 'an object (no safe string form)'
    default:
      return `a ${typeof value} value` // function or symbol
  }
}

/** Like {@link asText} but `undefined` for absent (an optional scalar). */
function asOptionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = asText(value)
  return text.length > 0 ? text : undefined
}
