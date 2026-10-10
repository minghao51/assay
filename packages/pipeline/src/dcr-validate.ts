// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DCR document validation (p3-1; ADR 0046): the walk from a parsed YAML
 * document to a {@link DcrArtifactV1}, rejecting everything the v1 format
 * does not explicitly allow.
 *
 * The honesty bar mirrors the Pipeline IR walk (`validate.ts`): unknown and
 * misplaced YAML keys are rejected with typed errors — never silently
 * dropped — as are duplicate keys, wrong value types, out-of-range values,
 * and duplicate entries in name-keyed collections. The walk collects *all*
 * independent errors per document, with two deliberate stops:
 *
 * 1. YAML syntax problems (including library warnings, which mean something
 *    was silently coerced) — the structure is unreliable, so only those are
 *    reported.
 * 2. `format` naming another format, or `version` naming a version other
 *    than 1 — reported alone rather than guessing what its keys would mean.
 *
 * Format tightenings carried over from the p-2 IR walk:
 * - **exact-or-rejected numbers** — every number passes the reused
 *   `@assay/contracts` gate, so a written literal can never be silently
 *   altered by the YAML→number parse;
 * - **reserved namespace** — id-position fields (a validate verdict's
 *   `nodeId`, a materialization `node`, lineage `nodes` entries) reject the
 *   reserved `assay_dcr_` prefix (case-insensitive), the DCR-scoped
 *   reservation of ruling D17-Q9 — the format may generate identifiers
 *   there in a future additive version, and user content must not have
 *   taken them.
 *
 * Privacy shape-pins enforced structurally here (ADR 0025): there is no key
 * anywhere in the grammar that could carry SQL text or cell values; row-diff
 * sample keys must match the anchor-free export grammar (`base:<ordinal>` /
 * `insert:<seq>` / `b:<ordinal>`) so a host-derived anchor can never enter
 * the artifact; the privacyFindings block must be *exactly* the canonical
 * "not computed" spelling (D17-Q6a).
 *
 * Not part of the public surface: positions come from YAML nodes, so
 * validation is exercised through `parseDcr`.
 *
 * Purity: no React, no browser APIs, no engine, no `@assay/*` imports beyond
 * the allowed set (lint-enforced).
 */
import { isAlias, isMap, isNode, isScalar, isSeq } from 'yaml'
import type { Alias, Document, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import { canonicalDecimal, isExactDecimalLiteral } from '@assay/contracts'
import { offsetToLineCol } from './validate.js'
import {
  DCR_COLUMN_FAMILIES,
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
  DcrLineage,
  DcrMaterializationRef,
  DcrPrivacyFindings,
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
import type { DcrError, DcrErrorCode } from './dcr-errors.js'

/** Any parsed YAML node (or absence). */
type YamlNode = Alias | Scalar | YAMLMap | YAMLSeq | null

/** Path of the document root in `DcrError.path`. */
const ROOT_PATH = 'document'

const ROOT_KEYS = [
  'format',
  'version',
  'base',
  'candidate',
  'deltas',
  'validation',
  'lineage',
  'privacyFindings',
] as const
const VERSION_REF_KEYS = [
  'datasetId',
  'versionId',
  'schemaFingerprint',
  'provenance',
  'materialization',
] as const
const PROVENANCE_KEYS = ['transformationRecipe', 'parentVersionIds'] as const
const MATERIALIZATION_KEYS = ['node', 'export'] as const
const FINDING_KEYS = [
  'kind',
  'column',
  'typeA',
  'typeB',
  'familyA',
  'familyB',
  'nullShareA',
  'nullShareB',
] as const
const DELTA_KEYS = ['column', 'typeA', 'typeB', 'kindA', 'kindB', 'numeric', 'categorical'] as const
const NUMERIC_KEYS = [
  'meanShiftStandardized',
  'varianceShiftStandardized',
  'p50Shift',
  'p90Shift',
] as const
/** The required keys of a categorical delta block (both top-k lists are always spelled). */
const CATEGORICAL_KEYS = ['totalVariation', 'newCategories', 'vanishedCategories'] as const
/**
 * The optional bounding-disclosure keys (D19-OQ-4, p3-1b): each is legal
 * but never required — absence is the meaning "not bounded".
 */
const CATEGORICAL_DISCLOSURE_KEYS = ['newCategoriesBounded', 'vanishedCategoriesBounded'] as const
/** Every legal key of a categorical delta block (the exact allowlist). */
const CATEGORICAL_ALL_KEYS = [...CATEGORICAL_KEYS, ...CATEGORICAL_DISCLOSURE_KEYS] as const
const TOP_K_KEYS = ['value', 'count'] as const
const ROW_DIFF_KEYS = ['keys', 'sampleLimit', 'rowCountA', 'rowCountB', 'aspects'] as const
const ASPECT_KEYS = ['aspect', 'count', 'samples'] as const
const SAMPLE_KEYS = ['side', 'rowKey', 'changedColumns'] as const
const VERDICT_KEYS = ['nodeId', 'input', 'valid', 'violatedRules', 'rowCount', 'rules'] as const
const RULE_KEYS = ['ruleId', 'kind', 'column', 'failCount', 'failPercent'] as const
const LINEAGE_KEYS = ['inputVersionIds', 'nodes'] as const
const PRIVACY_KEYS = ['status', 'disclosure'] as const

/**
 * Where each YAML key is legal — powers the "misplaced key" hint on
 * unknown-key errors.
 */
const KEY_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  format: ['the document root'],
  version: ['the document root'],
  base: ['the document root'],
  candidate: ['the document root'],
  deltas: ['the document root'],
  validation: ['the document root'],
  lineage: ['the document root'],
  privacyFindings: ['the document root'],
  datasetId: ['a base/candidate version reference'],
  versionId: ['a base/candidate version reference'],
  schemaFingerprint: ['a base/candidate version reference'],
  provenance: ['a base/candidate version reference'],
  materialization: ['a base/candidate version reference'],
  algorithm: ['a schemaFingerprint block'],
  value: ['a schemaFingerprint block', 'a categorical top-k entry'],
  transformationRecipe: ['a provenance block'],
  parentVersionIds: ['a provenance block'],
  node: ['a materialization block'],
  export: ['a materialization block'],
  kind: ['a schema-drift finding', 'a validation rule row'],
  column: ['a schema-drift finding', 'a column delta', 'a validation rule row'],
  typeA: ['a schema-drift finding', 'a column delta'],
  typeB: ['a schema-drift finding', 'a column delta'],
  familyA: ['a schema-drift finding'],
  familyB: ['a schema-drift finding'],
  nullShareA: ['a schema-drift finding'],
  nullShareB: ['a schema-drift finding'],
  kindA: ['a column delta'],
  kindB: ['a column delta'],
  numeric: ['a column delta'],
  categorical: ['a column delta'],
  meanShiftStandardized: ['a numeric delta block'],
  varianceShiftStandardized: ['a numeric delta block'],
  p50Shift: ['a numeric delta block'],
  p90Shift: ['a numeric delta block'],
  totalVariation: ['a categorical delta block'],
  newCategories: ['a categorical delta block'],
  vanishedCategories: ['a categorical delta block'],
  newCategoriesBounded: ['a categorical delta block'],
  vanishedCategoriesBounded: ['a categorical delta block'],
  count: ['a categorical top-k entry', 'a row-diff aspect'],
  rowDiff: ['the deltas block'],
  schemaDrift: ['the deltas block'],
  columnDeltas: ['the deltas block'],
  keys: ['a row-diff block'],
  sampleLimit: ['a row-diff block'],
  rowCountA: ['a row-diff block'],
  rowCountB: ['a row-diff block'],
  aspects: ['a row-diff block'],
  aspect: ['a row-diff aspect'],
  samples: ['a row-diff aspect'],
  side: ['a row-diff sample'],
  rowKey: ['a row-diff sample'],
  changedColumns: ['a row-diff sample'],
  nodeId: ['a validation verdict'],
  input: ['a validation verdict'],
  valid: ['a validation verdict'],
  violatedRules: ['a validation verdict'],
  rowCount: ['a validation verdict'],
  rules: ['a validation verdict'],
  ruleId: ['a validation rule row'],
  failCount: ['a validation rule row'],
  failPercent: ['a validation rule row'],
  inputVersionIds: ['a lineage block'],
  nodes: ['a lineage block'],
  status: ['the privacyFindings block'],
  disclosure: ['the privacyFindings block'],
}

interface WalkContext {
  readonly doc: Document
  /** The original source text (positions use ranges). */
  readonly source: string
  readonly lineIndex: readonly number[]
  readonly errors: DcrError[]
}

/** One mapping entry: the plain-text key and its (unresolved) value node. */
interface Entry {
  readonly key: string
  readonly keyNode: Scalar
  readonly valueNode: YamlNode
}

function pushError(
  ctx: WalkContext,
  code: DcrErrorCode,
  message: string,
  path: string,
  node: YamlNode,
): void {
  const offset = nodeOffset(node)
  const { line, column } = offsetToLineCol(ctx.lineIndex, offset)
  ctx.errors.push({ code, message, path, line, column })
}

/** First offset of a node (0 when the node carries no range — degenerate input). */
function nodeOffset(node: YamlNode): number {
  const range = node?.range
  return typeof range?.[0] === 'number' ? range[0] : 0
}

/**
 * The source text a scalar was written as. `null` when the node carries no
 * range — the same degenerate default {@link nodeOffset} falls back to. The
 * exactness gate judges the *content* literal, mirroring the IR walk.
 */
function rawScalarText(ctx: WalkContext, node: YamlNode): string | null {
  const range = node?.range
  return typeof range?.[0] === 'number' && typeof range?.[1] === 'number'
    ? ctx.source.slice(range[0], range[1])
    : null
}

/**
 * The exact-or-rejected numeric gate for **every** number in the artifact
 * (reuses `@assay/contracts`' canonical policy). A written literal is
 * accepted only when the double it parses to denotes the same decimal the
 * author wrote. The message quotes the **raw source literal only** — never
 * the rounded double the parse produced.
 */
function rejectImpreciseNumber(
  ctx: WalkContext,
  node: YamlNode,
  value: number,
  path: string,
): boolean {
  const raw = rawScalarText(ctx, node)
  if (raw === null) return true // no literal to verify; nodeOffset's degenerate default
  if (isExactDecimalLiteral(raw, value)) return true
  const unverifiable = canonicalDecimal(raw) === null
  pushError(
    ctx,
    'imprecise-number',
    unverifiable
      ? `${path}: cannot verify the exact value of ${JSON.stringify(raw)} — write DCR numbers as plain decimal literals (e.g. 1.5)`
      : `${path}: the written number ${raw} would be silently altered by the YAML→number parse — DCR numbers must be exactly representable; write a plain decimal that survives the round-trip, e.g. integers within ±2^53`,
    path,
    node,
  )
  return false
}

/** Resolve aliases to their target node (positions then come from the anchor). */
function resolveNode(ctx: WalkContext, node: YamlNode): YamlNode {
  if (node !== null && isAlias(node)) {
    try {
      return (node.resolve(ctx.doc) as YamlNode) ?? null
    } catch (error) {
      // Deep alias nesting overflows the YAML resolver's recursion with a
      // RangeError — a resource-limit failure, not a malformed document, so
      // it propagates (the IR parser's documented exception).
      if (error instanceof RangeError) throw error
      return null
    }
  }
  return node
}

/**
 * Collect a mapping's entries, rejecting non-string keys and duplicate keys.
 * Returns key → first occurrence in source order; `null` if not a mapping.
 */
function collectEntries(ctx: WalkContext, node: YamlNode, path: string): Map<string, Entry> | null {
  if (node === null || !isMap(node)) return null
  const entries = new Map<string, Entry>()
  for (const pair of node.items) {
    const keyNode = pair.key
    if (!isNode(keyNode)) {
      pushError(ctx, 'unknown-key', 'mapping keys must be plain text identifiers', path, null)
      continue
    }
    if (!isScalar(keyNode) || typeof keyNode.value !== 'string') {
      pushError(
        ctx,
        'unknown-key',
        `mapping keys must be plain text identifiers; got ${describeYamlValue(keyNode as YamlNode)}`,
        path,
        keyNode as YamlNode,
      )
      continue
    }
    const existing = entries.get(keyNode.value)
    if (existing !== undefined) {
      pushError(
        ctx,
        'duplicate-key',
        `duplicate key "${keyNode.value}" — each key may appear at most once in "${path}"`,
        path,
        keyNode,
      )
      continue
    }
    const valueNode: YamlNode = isNode(pair.value) ? (pair.value as YamlNode) : null
    entries.set(keyNode.value, { key: keyNode.value, keyNode, valueNode })
  }
  return entries
}

type ScalarKind = 'string' | 'number' | 'boolean' | 'null' | 'other'

function scalarKind(node: YamlNode): { kind: ScalarKind; value?: string | number | boolean } {
  if (node === null || !isScalar(node)) return { kind: node === null ? 'null' : 'other' }
  const value = node.value
  if (value === null || value === undefined) return { kind: 'null' }
  if (typeof value === 'string') return { kind: 'string', value }
  if (typeof value === 'number') return { kind: 'number', value }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  return { kind: 'other' }
}

/** Human description of a YAML value for error messages. */
function describeYamlValue(node: YamlNode): string {
  if (node === null) return 'an empty value (null)'
  if (isMap(node)) return 'a mapping'
  if (isSeq(node)) return 'a sequence'
  const { kind, value } = scalarKind(node)
  switch (kind) {
    case 'null':
      return 'null (an empty value)'
    case 'string':
      return `the string ${JSON.stringify(value)}`
    case 'number': {
      const n = value as number
      if (Number.isNaN(n)) return 'NaN (.nan)'
      if (!Number.isFinite(n))
        return n > 0 ? 'positive infinity (.inf)' : 'negative infinity (-.inf)'
      return `the number ${String(n)}`
    }
    case 'boolean':
      return `the boolean ${String(value)}`
    case 'other':
      return 'a non-plain scalar (tagged/binary data)'
  }
}

/** Position node for value errors: the value, falling back to the key. */
function valuePosition(entry: Entry, resolved: YamlNode): YamlNode {
  return resolved ?? entry.keyNode
}

function wantString(ctx: WalkContext, entry: Entry, path: string): string | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'string') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a string, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  const text = value as string
  if (text.includes('\u0000')) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: must not contain a NUL character`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  return text
}

/** A required non-empty string. */
function wantNonEmptyString(ctx: WalkContext, entry: Entry, path: string): string | null {
  const text = wantString(ctx, entry, path)
  if (text === null) return null
  if (text.length === 0) {
    pushError(ctx, 'out-of-range', `${path}: must be a non-empty string`, path, entry.valueNode)
    return null
  }
  return text
}

/**
 * A required non-empty string in an *identifier position* — the reserved
 * `assay_dcr_*` namespace (D17-Q9) is refused it (case-insensitive), so the
 * format can generate identifiers there in a future additive version.
 */
function wantIdString(ctx: WalkContext, entry: Entry, path: string): string | null {
  const text = wantNonEmptyString(ctx, entry, path)
  if (text === null) return null
  if (text.toLowerCase().startsWith(DCR_RESERVED_PREFIX)) {
    pushError(
      ctx,
      'reserved-identifier',
      `${path}: identifiers beginning with "${DCR_RESERVED_PREFIX}" are reserved for the DCR format itself (D17-Q9) — choose another id`,
      path,
      entry.valueNode,
    )
    return null
  }
  return text
}

/** An optional non-empty string: absent stays absent; explicit `null` is a wrong type. */
function wantOptionalString(ctx: WalkContext, entry: Entry, path: string): string | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind } = scalarKind(resolved)
  if (kind === 'null') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: omit the key entirely instead of writing null (one shape per meaning)`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  return wantNonEmptyString(ctx, entry, path) ?? undefined
}

/**
 * A required number that must be an exact, finite, safe integer within
 * `[min, max]`. The exactness gate fires first (mirroring the IR walk), so
 * an imprecise literal is reported even when the range would also fail.
 */
function wantSafeInt(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  min: number = -Number.MAX_SAFE_INTEGER,
  max: number = Number.MAX_SAFE_INTEGER,
): number | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'number') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a number, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  const num = value as number
  if (!rejectImpreciseNumber(ctx, entry.valueNode, num, path)) return null
  if (!Number.isSafeInteger(num)) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: must be an integer within ±2^53 (got ${describeYamlValue(resolved)})`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  if (num < min || num > max) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: must be between ${String(min)} and ${String(max)} (got ${describeYamlValue(resolved)})`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  return num === 0 ? 0 : num
}

/**
 * A required finite number within `[min, max]`, or the explicit `null`
 * ("not observed" — e.g. a nullability share on a zero-row side). Non-finite
 * YAML numbers (.nan/.inf) are refused outright.
 */
function wantFiniteOrNull(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  min: number,
  max: number,
): number | null | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind === 'null') return null
  if (kind !== 'number') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a finite number or null, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  const num = value as number
  if (!Number.isFinite(num)) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: must be a finite number (got ${describeYamlValue(resolved)})`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  if (!rejectImpreciseNumber(ctx, entry.valueNode, num, path)) return undefined
  if (num < min || num > max) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: must be between ${String(min)} and ${String(max)} (got ${describeYamlValue(resolved)})`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  return num === 0 ? 0 : num
}

function wantBoolean(ctx: WalkContext, entry: Entry, path: string): boolean | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'boolean') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a boolean (true or false), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  return value as boolean
}

/**
 * A presence-is-meaning disclosure flag (D19-OQ-4, p3-1b): the only legal
 * present spelling is exactly the boolean `true` — a present `false` would
 * be a second spelling of "not bounded" (one shape per meaning), so it is
 * refused with the omit-it-instead guidance; any non-boolean scalar is a
 * wrong type.
 */
function wantTrueLiteral(ctx: WalkContext, entry: Entry, path: string): true | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind === 'boolean' && value === true) return true
  if (kind === 'boolean') {
    pushError(
      ctx,
      'out-of-range',
      `${path}: the bounding disclosure is presence-is-meaning — the only legal spelling is exactly true; omit the key when the aspect was not bounded`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  pushError(
    ctx,
    'wrong-type',
    `${path}: expected exactly the boolean true, got ${describeYamlValue(resolved)}`,
    path,
    valuePosition(entry, resolved),
  )
  return null
}

/** A required string from a fixed vocabulary. */
function wantEnum<T extends string>(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  allowed: readonly T[],
  label: string,
  is: (value: unknown) => value is T,
): T | null {
  const text = wantString(ctx, entry, path)
  if (text === null) return null
  if (!is(text)) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: unknown ${label} ${JSON.stringify(text)} — expected one of: ${allowed.join(', ')}`,
      path,
      entry.valueNode,
    )
    return null
  }
  return text
}

/**
 * A sequence of mappings, walked item by item; `null` when the value is not
 * a sequence (a typed error is already reported). An empty sequence is
 * normalized to absent by the caller when the collection's emptiness has an
 * absent spelling (one shape per meaning).
 */
function walkSeq(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): { readonly item: YamlNode; readonly index: number }[] | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null || !isSeq(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a sequence, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  const out: { readonly item: YamlNode; readonly index: number }[] = []
  for (let index = 0; index < resolved.items.length; index++) {
    const item = resolved.items[index]
    out.push({ item: isNode(item) ? (item as YamlNode) : null, index })
  }
  return out
}

/**
 * A string sequence: bounded non-empty NUL-free strings. `null` when the
 * value is not a sequence or an entry is not a string (errors reported).
 */
function wantStringSeq(ctx: WalkContext, entry: Entry, path: string): string[] | null {
  const items = walkSeq(ctx, entry, path)
  if (items === null) return null
  const out: string[] = []
  for (const { item, index } of items) {
    const text = wantString(
      ctx,
      { key: entry.key, keyNode: entry.keyNode, valueNode: item },
      `${path}[${String(index)}]`,
    )
    if (text === null) continue
    if (text.length === 0) {
      pushError(
        ctx,
        'out-of-range',
        `${path}[${String(index)}]: must be a non-empty string`,
        path,
        item,
      )
      continue
    }
    out.push(text)
  }
  return out
}

/** Canonical string-sequence reader: sorted ascending, duplicates refused. */
function wantSortedUniqueSeq(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  noun: string,
): string[] | null {
  const strings = wantStringSeq(ctx, entry, path)
  if (strings === null) return null
  const seen = new Set<string>()
  for (const text of strings) {
    if (seen.has(text)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}: duplicate ${noun} ${JSON.stringify(text)} — each may appear at most once`,
        path,
        entry.valueNode,
      )
      return null
    }
    seen.add(text)
  }
  return [...strings].sort(compareDcrStrings)
}

/**
 * Producer-ordered string sequence (order is meaning — e.g. the topological
 * node list): duplicates refused, order preserved.
 */
function wantOrderedUniqueSeq(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  noun: string,
): string[] | null {
  const strings = wantStringSeq(ctx, entry, path)
  if (strings === null) return null
  const seen = new Set<string>()
  for (const text of strings) {
    if (seen.has(text)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}: duplicate ${noun} ${JSON.stringify(text)} — each may appear at most once`,
        path,
        entry.valueNode,
      )
      return null
    }
    seen.add(text)
  }
  return strings
}

// --- the walk ----------------------------------------------------------------

/**
 * Walk a parsed YAML document to a canonical {@link DcrArtifactV1}. Internal:
 * called from `parseDcr` after the syntax pass. Positions come from YAML
 * nodes.
 */
export function validateDcrDocument(
  doc: Document,
  source: string,
  lineIndex: readonly number[],
): { readonly artifact?: DcrArtifactV1; readonly errors: readonly DcrError[] } {
  const ctx: WalkContext = { doc, source, lineIndex, errors: [] }
  const root = doc.contents as YamlNode
  const entries = collectEntries(ctx, root, ROOT_PATH)
  if (entries === null) {
    if (ctx.errors.length === 0) {
      pushError(
        ctx,
        'wrong-type',
        'the document root must be a mapping starting with "format: assay-dcr"',
        ROOT_PATH,
        root,
      )
    }
    return { errors: ctx.errors }
  }

  // The stamp stops: a foreign format, or a foreign version, is reported
  // alone rather than guessing what its keys would mean (the IR precedent).
  const formatEntry = entries.get('format')
  if (formatEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing "format" — a DCR artifact starts with "format: assay-dcr"',
      ROOT_PATH,
      root,
    )
    return { errors: ctx.errors }
  }
  const format = wantString(ctx, formatEntry, 'format')
  if (format !== DCR_FORMAT) {
    if (format !== null && ctx.errors.length === 0) {
      pushError(
        ctx,
        'unsupported-format',
        `unsupported format ${JSON.stringify(format)} — this parser reads "format: ${DCR_FORMAT}" (DCR artifact v1, ADR 0046)`,
        'format',
        formatEntry.valueNode,
      )
    }
    return { errors: ctx.errors }
  }
  const versionEntry = entries.get('version')
  if (versionEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing "version" — a DCR artifact v1 declares "version: 1"',
      ROOT_PATH,
      root,
    )
    return { errors: ctx.errors }
  }
  const version = wantSafeInt(ctx, versionEntry, 'version')
  if (version !== DCR_VERSION) {
    if (ctx.errors.length === 0) {
      pushError(
        ctx,
        'unsupported-version',
        `unsupported version ${String(version)} — this parser reads version ${String(DCR_VERSION)} only (additive-only within v1; a version bump is a maintainer-visible decision, D17-Q12)`,
        'version',
        versionEntry.valueNode,
      )
    }
    return { errors: ctx.errors }
  }

  // Unknown / misplaced root keys are refused (the honesty bar).
  rejectUnknownKeys(ctx, entries, ROOT_KEYS, ROOT_PATH)

  // Required sections.
  const baseEntry = entries.get('base')
  const base = baseEntry !== undefined ? walkVersionRef(ctx, baseEntry, 'base') : null
  if (baseEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing "base" — a DCR compares a base version with a candidate',
      ROOT_PATH,
      root,
    )
  }
  const candidateEntry = entries.get('candidate')
  const candidate =
    candidateEntry !== undefined ? walkVersionRef(ctx, candidateEntry, 'candidate') : null
  if (candidateEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing "candidate" — a DCR compares a base version with a candidate',
      ROOT_PATH,
      root,
    )
  }
  const deltasEntry = entries.get('deltas')
  const deltas = deltasEntry !== undefined ? walkDeltas(ctx, deltasEntry) : null
  if (deltasEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing "deltas" — the compared aspects block is required',
      ROOT_PATH,
      root,
    )
  }
  const privacyEntry = entries.get('privacyFindings')
  const privacy = privacyEntry !== undefined ? walkPrivacy(ctx, privacyEntry) : null
  if (privacyEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing "privacyFindings" — every artifact carries the explicit "not computed" disclosure (D17-Q6)',
      ROOT_PATH,
      root,
    )
  }

  // Optional sections.
  const validationEntry = entries.get('validation')
  const validation =
    validationEntry !== undefined ? walkValidation(ctx, validationEntry) : undefined
  const lineageEntry = entries.get('lineage')
  const lineage = lineageEntry !== undefined ? walkLineage(ctx, lineageEntry) : undefined

  if (
    ctx.errors.length > 0 ||
    base === null ||
    candidate === null ||
    deltas === null ||
    privacy === null
  ) {
    return { errors: ctx.errors }
  }
  const artifact: DcrArtifactV1 = {
    format: DCR_FORMAT,
    version: DCR_VERSION,
    base,
    candidate,
    deltas,
    ...(validation !== undefined ? { validation } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
    privacyFindings: privacy,
  }
  return { artifact, errors: ctx.errors }
}

/** Reject keys that are not legal at this level, with a "misplaced key" hint. */
function rejectUnknownKeys(
  ctx: WalkContext,
  entries: ReadonlyMap<string, Entry>,
  allowed: readonly string[],
  path: string,
): void {
  for (const [key, entry] of entries) {
    if ((allowed as readonly string[]).includes(key)) continue
    const locations = KEY_LOCATIONS[key]
    const hint =
      locations !== undefined
        ? ` — "${key}" is legal only on ${locations.join(' or ')}`
        : ' — it is not part of DCR artifact v1 (additive-only within v1: unknown keys are refused, D17-Q12)'
    pushError(ctx, 'unknown-key', `unknown key "${key}" at "${path}"${hint}`, path, entry.keyNode)
  }
}

function requireKeys(
  ctx: WalkContext,
  entries: ReadonlyMap<string, Entry>,
  required: readonly string[],
  path: string,
  node: YamlNode,
): boolean {
  let ok = true
  for (const key of required) {
    if (!entries.has(key)) {
      pushError(ctx, 'missing-key', `missing "${key}" in "${path}"`, path, node)
      ok = false
    }
  }
  return ok
}

function exactlyOneEntry(
  ctx: WalkContext,
  entries: ReadonlyMap<string, Entry>,
  alternatives: readonly string[],
  path: string,
): Entry | null {
  const present = alternatives.filter((key) => entries.has(key))
  if (present.length === 1) return entries.get(present[0] as string) ?? null
  const node = present.length > 0 ? (entries.get(present[0] as string)?.keyNode ?? null) : null
  pushError(
    ctx,
    present.length === 0 ? 'missing-key' : 'out-of-range',
    present.length === 0
      ? `${path}: exactly one of ${alternatives.map((key) => `"${key}"`).join(' / ')} is required`
      : `${path}: exactly one of ${alternatives.map((key) => `"${key}"`).join(' / ')} may be present (one shape per meaning)`,
    path,
    node,
  )
  return null
}

// --- version references -------------------------------------------------------

function walkVersionRef(ctx: WalkContext, entry: Entry, path: string): DcrVersionRef | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    if (ctx.errors.length === 0) {
      pushError(
        ctx,
        'wrong-type',
        `${path}: expected a mapping (datasetId/versionId/schemaFingerprint/provenance/materialization), got ${describeYamlValue(resolved)}`,
        path,
        valuePosition(entry, resolved),
      )
    }
    return null
  }
  rejectUnknownKeys(ctx, entries, VERSION_REF_KEYS, path)
  if (
    !requireKeys(
      ctx,
      entries,
      ['datasetId', 'versionId', 'schemaFingerprint', 'materialization'],
      path,
      entry.valueNode,
    )
  ) {
    return null
  }
  const datasetId = wantNonEmptyString(ctx, entries.get('datasetId') as Entry, `${path}.datasetId`)
  const versionId = wantNonEmptyString(ctx, entries.get('versionId') as Entry, `${path}.versionId`)
  const fingerprintEntry = entries.get('schemaFingerprint')
  const schemaFingerprint =
    fingerprintEntry !== undefined
      ? walkFingerprint(ctx, fingerprintEntry, `${path}.schemaFingerprint`)
      : null
  const materializationEntry = entries.get('materialization')
  const materialization =
    materializationEntry !== undefined
      ? walkMaterialization(ctx, materializationEntry, `${path}.materialization`)
      : null
  const provenanceEntry = entries.get('provenance')
  const provenance =
    provenanceEntry !== undefined
      ? walkProvenance(ctx, provenanceEntry, `${path}.provenance`)
      : undefined
  if (
    datasetId === null ||
    versionId === null ||
    schemaFingerprint === null ||
    materialization === null
  ) {
    return null
  }
  return {
    datasetId,
    versionId,
    schemaFingerprint,
    ...(provenance !== undefined ? { provenance } : {}),
    materialization,
  }
}

function walkFingerprint(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): DcrSchemaFingerprint | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (algorithm/value), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, ['algorithm', 'value'], path)
  if (!requireKeys(ctx, entries, ['algorithm', 'value'], path, entry.valueNode)) return null
  const algorithm = wantNonEmptyString(ctx, entries.get('algorithm') as Entry, `${path}.algorithm`)
  const value = wantNonEmptyString(ctx, entries.get('value') as Entry, `${path}.value`)
  if (algorithm === null || value === null) return null
  return { algorithm, value }
}

function walkProvenance(ctx: WalkContext, entry: Entry, path: string): DcrProvenance | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (transformationRecipe/parentVersionIds), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  rejectUnknownKeys(ctx, entries, PROVENANCE_KEYS, path)
  // D17-Q11: no wall-clock — the domain Provenance's createdAt deliberately
  // has no spelling here (an attempt lands as the unknown-key error above).
  let transformationRecipe: string | undefined
  const recipeEntry = entries.get('transformationRecipe')
  if (recipeEntry !== undefined) {
    const parsed = wantOptionalString(ctx, recipeEntry, `${path}.transformationRecipe`)
    if (parsed === undefined) return undefined // the error is already reported
    transformationRecipe = parsed
  }
  let parentVersionIds: readonly string[] | undefined
  const parentsEntry = entries.get('parentVersionIds')
  if (parentsEntry !== undefined) {
    const parsed = wantSortedUniqueSeq(
      ctx,
      parentsEntry,
      `${path}.parentVersionIds`,
      'parent version id',
    )
    if (parsed === null) return undefined // the error is already reported
    parentVersionIds = parsed
  }
  if (
    transformationRecipe === undefined &&
    (parentVersionIds === undefined || parentVersionIds.length === 0)
  ) {
    return undefined
  }
  return {
    ...(transformationRecipe !== undefined ? { transformationRecipe } : {}),
    ...(parentVersionIds !== undefined && parentVersionIds.length > 0 ? { parentVersionIds } : {}),
  }
}

function walkMaterialization(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): DcrMaterializationRef | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping with exactly one of "node" / "export", got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, MATERIALIZATION_KEYS, path)
  const chosen = exactlyOneEntry(ctx, entries, MATERIALIZATION_KEYS, path)
  if (chosen === null) return null
  if (chosen.key === 'node') {
    const node = wantIdString(ctx, chosen, `${path}.node`)
    return node === null ? null : { node }
  }
  // The runner's value-free export path (p3-2's discipline): non-empty,
  // NUL-free — never a dataset value, never a synthesized absolute path.
  const exportPath = wantNonEmptyString(ctx, chosen, `${path}.export`)
  return exportPath === null ? null : { export: exportPath }
}

// --- deltas -------------------------------------------------------------------

function walkDeltas(ctx: WalkContext, entry: Entry): DcrArtifactV1['deltas'] | null {
  const path = 'deltas'
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (schemaDrift/columnDeltas/rowDiff), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, ['schemaDrift', 'columnDeltas', 'rowDiff'], path)

  const driftEntry = entries.get('schemaDrift')
  let schemaDrift: readonly DcrSchemaDriftFinding[] | undefined
  if (driftEntry !== undefined) {
    const items = walkSeq(ctx, driftEntry, `${path}.schemaDrift`)
    if (items !== null) {
      const findings: DcrSchemaDriftFinding[] = []
      for (const { item, index } of items) {
        const finding = walkFinding(ctx, item, `${path}.schemaDrift[${String(index)}]`)
        if (finding !== null) findings.push(finding)
      }
      // Canonical order + one finding per (column, kind).
      if (!rejectDuplicateFindings(ctx, findings, `${path}.schemaDrift`)) return null
      schemaDrift = findings.sort(compareDcrSchemaDriftFindings)
    }
  }

  const deltasEntry = entries.get('columnDeltas')
  let columnDeltas: readonly DcrColumnDistributionDelta[] | undefined
  if (deltasEntry !== undefined) {
    const items = walkSeq(ctx, deltasEntry, `${path}.columnDeltas`)
    if (items !== null) {
      const deltas: DcrColumnDistributionDelta[] = []
      for (const { item, index } of items) {
        const delta = walkColumnDelta(ctx, item, `${path}.columnDeltas[${String(index)}]`)
        if (delta !== null) deltas.push(delta)
      }
      if (!rejectDuplicateColumns(ctx, deltas, `${path}.columnDeltas`)) return null
      columnDeltas = deltas.sort((a, b) => compareDcrStrings(a.column, b.column))
    }
  }

  const rowDiffEntry = entries.get('rowDiff')
  const rowDiff = rowDiffEntry !== undefined ? walkRowDiff(ctx, rowDiffEntry) : undefined

  return {
    ...(schemaDrift !== undefined && schemaDrift.length > 0 ? { schemaDrift } : {}),
    ...(columnDeltas !== undefined && columnDeltas.length > 0 ? { columnDeltas } : {}),
    ...(rowDiff !== undefined ? { rowDiff } : {}),
  }
}

function rejectDuplicateFindings(
  ctx: WalkContext,
  findings: readonly DcrSchemaDriftFinding[],
  path: string,
): boolean {
  const seen = new Set<string>()
  for (const finding of findings) {
    const id = `${JSON.stringify(finding.column)}\u0000${finding.kind}`
    if (seen.has(id)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}: duplicate finding for column ${JSON.stringify(finding.column)} and kind "${finding.kind}" — at most one finding per column and kind`,
        path,
        null,
      )
      return false
    }
    seen.add(id)
  }
  return true
}

function rejectDuplicateColumns(
  ctx: WalkContext,
  deltas: readonly { readonly column: string }[],
  path: string,
): boolean {
  const seen = new Set<string>()
  for (const delta of deltas) {
    if (seen.has(delta.column)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}: duplicate delta for column ${JSON.stringify(delta.column)} — at most one delta per column`,
        path,
        null,
      )
      return false
    }
    seen.add(delta.column)
  }
  return true
}

function walkFinding(ctx: WalkContext, node: YamlNode, path: string): DcrSchemaDriftFinding | null {
  const entries = collectEntries(ctx, node, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (kind/column/…), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, FINDING_KEYS, path)
  if (!requireKeys(ctx, entries, ['kind', 'column'], path, node)) return null
  const kind = wantEnum(
    ctx,
    entries.get('kind') as Entry,
    `${path}.kind`,
    DCR_SCHEMA_DRIFT_KINDS,
    'schema-drift kind',
    isDcrSchemaDriftKind,
  )
  const column = wantNonEmptyString(ctx, entries.get('column') as Entry, `${path}.column`)
  let typeA: string | undefined
  if (entries.has('typeA')) {
    const parsed = wantOptionalString(ctx, entries.get('typeA') as Entry, `${path}.typeA`)
    if (parsed === undefined) return null // the error is already reported
    typeA = parsed
  }
  let typeB: string | undefined
  if (entries.has('typeB')) {
    const parsed = wantOptionalString(ctx, entries.get('typeB') as Entry, `${path}.typeB`)
    if (parsed === undefined) return null
    typeB = parsed
  }
  let familyA: DcrSchemaDriftFinding['familyA']
  if (entries.has('familyA')) {
    const parsed = wantEnum(
      ctx,
      entries.get('familyA') as Entry,
      `${path}.familyA`,
      DCR_COLUMN_FAMILIES,
      'type family',
      isDcrColumnTypeFamily,
    )
    if (parsed === null) return null
    familyA = parsed
  }
  let familyB: DcrSchemaDriftFinding['familyB']
  if (entries.has('familyB')) {
    const parsed = wantEnum(
      ctx,
      entries.get('familyB') as Entry,
      `${path}.familyB`,
      DCR_COLUMN_FAMILIES,
      'type family',
      isDcrColumnTypeFamily,
    )
    if (parsed === null) return null
    familyB = parsed
  }
  let nullShareA: number | null | undefined
  if (entries.has('nullShareA')) {
    const parsed = wantFiniteOrNull(
      ctx,
      entries.get('nullShareA') as Entry,
      `${path}.nullShareA`,
      0,
      1,
    )
    if (parsed === undefined) return null
    nullShareA = parsed
  }
  let nullShareB: number | null | undefined
  if (entries.has('nullShareB')) {
    const parsed = wantFiniteOrNull(
      ctx,
      entries.get('nullShareB') as Entry,
      `${path}.nullShareB`,
      0,
      1,
    )
    if (parsed === undefined) return null
    nullShareB = parsed
  }
  if (kind === null || column === null) return null
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
  ctx: WalkContext,
  node: YamlNode,
  path: string,
): DcrColumnDistributionDelta | null {
  const entries = collectEntries(ctx, node, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (column/typeA/typeB/kindA/kindB/numeric/categorical), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, DELTA_KEYS, path)
  if (!requireKeys(ctx, entries, ['column', 'typeA', 'typeB', 'kindA', 'kindB'], path, node)) {
    return null
  }
  const column = wantNonEmptyString(ctx, entries.get('column') as Entry, `${path}.column`)
  const typeA = wantNonEmptyString(ctx, entries.get('typeA') as Entry, `${path}.typeA`)
  const typeB = wantNonEmptyString(ctx, entries.get('typeB') as Entry, `${path}.typeB`)
  const kindA = wantEnum(
    ctx,
    entries.get('kindA') as Entry,
    `${path}.kindA`,
    DCR_PROFILE_COLUMN_KINDS,
    'profile column kind',
    isDcrProfileColumnKind,
  )
  const kindB = wantEnum(
    ctx,
    entries.get('kindB') as Entry,
    `${path}.kindB`,
    DCR_PROFILE_COLUMN_KINDS,
    'profile column kind',
    isDcrProfileColumnKind,
  )
  let numeric: DcrColumnDistributionDelta['numeric']
  const numericEntry = entries.get('numeric')
  if (numericEntry !== undefined) {
    const parsed = walkNumericDelta(ctx, numericEntry, `${path}.numeric`)
    if (parsed === undefined) return null
    numeric = parsed
  }
  let categorical: DcrColumnDistributionDelta['categorical']
  const categoricalEntry = entries.get('categorical')
  if (categoricalEntry !== undefined) {
    const parsed = walkCategoricalDelta(ctx, categoricalEntry, `${path}.categorical`)
    if (parsed === undefined) return null
    categorical = parsed
  }
  if (column === null || typeA === null || typeB === null || kindA === null || kindB === null)
    return null
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

function walkNumericDelta(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): DcrColumnDistributionDelta['numeric'] | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping of four shift metrics, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  rejectUnknownKeys(ctx, entries, NUMERIC_KEYS, path)
  if (!requireKeys(ctx, entries, NUMERIC_KEYS, path, entry.valueNode)) return undefined
  const wide = -Number.MAX_VALUE
  const meanShiftStandardized = wantFiniteOrNull(
    ctx,
    entries.get('meanShiftStandardized') as Entry,
    `${path}.meanShiftStandardized`,
    wide,
    Number.MAX_VALUE,
  )
  const varianceShiftStandardized = wantFiniteOrNull(
    ctx,
    entries.get('varianceShiftStandardized') as Entry,
    `${path}.varianceShiftStandardized`,
    wide,
    Number.MAX_VALUE,
  )
  const p50Shift = wantFiniteOrNull(
    ctx,
    entries.get('p50Shift') as Entry,
    `${path}.p50Shift`,
    wide,
    Number.MAX_VALUE,
  )
  const p90Shift = wantFiniteOrNull(
    ctx,
    entries.get('p90Shift') as Entry,
    `${path}.p90Shift`,
    wide,
    Number.MAX_VALUE,
  )
  if (
    meanShiftStandardized === undefined ||
    varianceShiftStandardized === undefined ||
    p50Shift === undefined ||
    p90Shift === undefined
  ) {
    return undefined
  }
  return { meanShiftStandardized, varianceShiftStandardized, p50Shift, p90Shift }
}

function walkCategoricalDelta(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): DcrColumnDistributionDelta['categorical'] | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (totalVariation/newCategories/vanishedCategories), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  rejectUnknownKeys(ctx, entries, CATEGORICAL_ALL_KEYS, path)
  if (!requireKeys(ctx, entries, CATEGORICAL_KEYS, path, entry.valueNode)) return undefined
  const totalVariation = wantFiniteOrNull(
    ctx,
    entries.get('totalVariation') as Entry,
    `${path}.totalVariation`,
    0,
    1,
  )
  const newCategories = walkTopKSeq(
    ctx,
    entries.get('newCategories') as Entry,
    `${path}.newCategories`,
  )
  const vanishedCategories = walkTopKSeq(
    ctx,
    entries.get('vanishedCategories') as Entry,
    `${path}.vanishedCategories`,
  )
  // The D19-OQ-4 bounding disclosure: optional, exactly-`true`-when-present
  // (absence is meaning); a malformed spelling aborts this block.
  let newCategoriesBounded: true | undefined
  const newBoundedEntry = entries.get('newCategoriesBounded')
  if (newBoundedEntry !== undefined) {
    const flag = wantTrueLiteral(ctx, newBoundedEntry, `${path}.newCategoriesBounded`)
    if (flag === null) return undefined
    newCategoriesBounded = flag
  }
  let vanishedCategoriesBounded: true | undefined
  const vanishedBoundedEntry = entries.get('vanishedCategoriesBounded')
  if (vanishedBoundedEntry !== undefined) {
    const flag = wantTrueLiteral(ctx, vanishedBoundedEntry, `${path}.vanishedCategoriesBounded`)
    if (flag === null) return undefined
    vanishedCategoriesBounded = flag
  }
  if (totalVariation === undefined || newCategories === null || vanishedCategories === null) {
    return undefined
  }
  return {
    totalVariation,
    newCategories,
    vanishedCategories,
    ...(newCategoriesBounded !== undefined ? { newCategoriesBounded } : {}),
    ...(vanishedCategoriesBounded !== undefined ? { vanishedCategoriesBounded } : {}),
  }
}

/**
 * A top-k entry sequence: producer order (frequency rank) is meaning, so it
 * is preserved; duplicate values are refused.
 */
function walkTopKSeq(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): readonly DcrCategoricalTopKEntry[] | null {
  const items = walkSeq(ctx, entry, path)
  if (items === null) return null
  const out: DcrCategoricalTopKEntry[] = []
  const seen = new Set<string>()
  for (const { item, index } of items) {
    const itemPath = `${path}[${String(index)}]`
    const itemEntries = collectEntries(ctx, item, itemPath)
    if (itemEntries === null) {
      pushError(
        ctx,
        'wrong-type',
        `${itemPath}: expected a mapping (value/count), got ${describeYamlValue(item)}`,
        itemPath,
        item,
      )
      return null
    }
    rejectUnknownKeys(ctx, itemEntries, TOP_K_KEYS, itemPath)
    if (!requireKeys(ctx, itemEntries, ['value', 'count'], itemPath, item)) return null
    const value = wantNonEmptyString(ctx, itemEntries.get('value') as Entry, `${itemPath}.value`)
    const count = wantSafeInt(ctx, itemEntries.get('count') as Entry, `${itemPath}.count`, 0)
    if (value === null || count === null) return null
    if (seen.has(value)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}: duplicate category ${JSON.stringify(value)} — each category may appear at most once per list`,
        path,
        item,
      )
      return null
    }
    seen.add(value)
    out.push({ value, count })
  }
  return out
}

// --- row diff (D17-Q7) ---------------------------------------------------------

/** The rowDiff block carries exactly the three aspects (added, removed, changed). */
const DCR_ROW_DIFF_ASPECT_COUNT = 3

function walkRowDiff(ctx: WalkContext, entry: Entry): DcrRowDiff | undefined {
  const path = 'deltas.rowDiff'
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (keys/sampleLimit/rowCountA/rowCountB/aspects), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  rejectUnknownKeys(ctx, entries, ROW_DIFF_KEYS, path)
  if (!requireKeys(ctx, entries, ROW_DIFF_KEYS, path, entry.valueNode)) return undefined
  const keysEntry = entries.get('keys') as Entry
  // D17-Q7: explicit keys REQUIRED — a present rowDiff with no (or an empty)
  // key list is a typed located error, never an inference opportunity.
  const parsedKeys = wantStringSeq(ctx, keysEntry, `${path}.keys`)
  if (parsedKeys === null) return undefined
  const keys: readonly string[] = parsedKeys
  if (keys.length === 0) {
    pushError(
      ctx,
      'out-of-range',
      `${path}.keys: a rowDiff block requires an explicit non-empty key list (D17-Q7: no silent inference; omit the whole rowDiff block when no keys were supplied)`,
      path,
      keysEntry.valueNode,
    )
    return undefined
  }
  const seen = new Set<string>()
  for (const key of keys) {
    const lower = key.toLowerCase()
    if (seen.has(lower)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}.keys: duplicate key column ${JSON.stringify(key)} — key columns must be distinct (identifiers are case-insensitive)`,
        path,
        keysEntry.valueNode,
      )
      return undefined
    }
    seen.add(lower)
  }
  const sampleLimit = wantSafeInt(
    ctx,
    entries.get('sampleLimit') as Entry,
    `${path}.sampleLimit`,
    1,
  )
  const rowCountA = wantSafeInt(ctx, entries.get('rowCountA') as Entry, `${path}.rowCountA`, 0)
  const rowCountB = wantSafeInt(ctx, entries.get('rowCountB') as Entry, `${path}.rowCountB`, 0)
  const aspectsEntry = entries.get('aspects') as Entry
  const aspectItems = walkSeq(ctx, aspectsEntry, `${path}.aspects`)
  if (sampleLimit === null || rowCountA === null || rowCountB === null || aspectItems === null) {
    return undefined
  }
  const aspects: DcrRowDiffAspectResult[] = []
  for (const { item, index } of aspectItems) {
    const aspect = walkAspect(ctx, item, `${path}.aspects[${String(index)}]`)
    if (aspect === null) return undefined
    aspects.push(aspect)
  }
  // Exactly the three aspects, each once, normalized into canonical order.
  const aspectSeen = new Set<string>()
  for (const aspect of aspects) {
    if (aspectSeen.has(aspect.aspect)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}.aspects: duplicate aspect "${aspect.aspect}" — exactly one entry per aspect (added, removed, changed)`,
        path,
        aspectsEntry.valueNode,
      )
      return undefined
    }
    aspectSeen.add(aspect.aspect)
  }
  if (aspectSeen.size !== DCR_ROW_DIFF_ASPECT_COUNT) {
    pushError(
      ctx,
      'missing-key',
      `${path}.aspects: expected exactly three aspects (added, removed, changed), got ${String(aspectSeen.size)}`,
      path,
      aspectsEntry.valueNode,
    )
    return undefined
  }
  return {
    keys,
    sampleLimit,
    rowCountA,
    rowCountB,
    aspects: aspects.sort(compareDcrAspects),
  }
}

function walkAspect(ctx: WalkContext, node: YamlNode, path: string): DcrRowDiffAspectResult | null {
  const entries = collectEntries(ctx, node, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (aspect/count/samples), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, ASPECT_KEYS, path)
  if (!requireKeys(ctx, entries, ASPECT_KEYS, path, node)) return null
  const aspect = wantEnum(
    ctx,
    entries.get('aspect') as Entry,
    `${path}.aspect`,
    ['added', 'removed', 'changed'] as const,
    'row-diff aspect',
    isDcrRowDiffAspect,
  )
  const count = wantSafeInt(ctx, entries.get('count') as Entry, `${path}.count`, 0)
  const samplesEntry = entries.get('samples') as Entry
  const sampleItems = walkSeq(ctx, samplesEntry, `${path}.samples`)
  if (aspect === null || count === null || sampleItems === null) return null
  const samples: DcrRowDiffSample[] = []
  for (const { item, index } of sampleItems) {
    const sample = walkSample(ctx, item, `${path}.samples[${String(index)}]`)
    if (sample === null) return null
    samples.push(sample)
  }
  if (samples.length > count) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: ${String(samples.length)} samples exceed the aspect's exact count ${String(count)} — samples are a bounded subset of the counted rows`,
      path,
      entries.get('count')?.valueNode ?? node,
    )
    return null
  }
  return { aspect, count, samples }
}

function walkSample(ctx: WalkContext, node: YamlNode, path: string): DcrRowDiffSample | null {
  const entries = collectEntries(ctx, node, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (side/rowKey/changedColumns), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, SAMPLE_KEYS, path)
  if (!requireKeys(ctx, entries, ['side', 'rowKey'], path, node)) return null
  const side = wantEnum(
    ctx,
    entries.get('side') as Entry,
    `${path}.side`,
    ['A', 'B'] as const,
    'row-diff side',
    (value): value is 'A' | 'B' => value === 'A' || value === 'B',
  )
  const rowKeyEntry = entries.get('rowKey') as Entry
  const rowKey = wantNonEmptyString(ctx, rowKeyEntry, `${path}.rowKey`)
  if (side === null || rowKey === null) return null
  // ADR 0025 shape-pin: anchor-free export grammar only — a host-derived
  // anchor (the m4-3 grid form `base:<anchor>#<ordinal>`) can never enter
  // the artifact, and neither can any other carrier of a value.
  if (!isAnchorFreeRowKey(rowKey)) {
    // The key text is never echoed: a hostile key can carry a grid anchor
    // (a host/session fingerprint), so the diagnostic names the grammar,
    // not the value (ADR 0025 extends to diagnostics).
    pushError(
      ctx,
      'invalid-reference',
      `${path}.rowKey: is outside the anchor-free export grammar "base:<ordinal>" / "insert:<seq>" / "b:<ordinal>" (spec §5; row keys are ordinals, never dataset values or grid anchors)`,
      `${path}.rowKey`,
      rowKeyEntry.valueNode,
    )
    return null
  }
  let changedColumns: readonly string[] | undefined
  const changedEntry = entries.get('changedColumns')
  if (changedEntry !== undefined) {
    const parsed = wantSortedUniqueSeq(ctx, changedEntry, `${path}.changedColumns`, 'column name')
    if (parsed === null) return null
    changedColumns = parsed
  }
  return {
    side,
    rowKey,
    ...(changedColumns !== undefined && changedColumns.length > 0 ? { changedColumns } : {}),
  }
}

// --- validation / lineage / privacy ---------------------------------------------

function walkValidation(
  ctx: WalkContext,
  entry: Entry,
): readonly DcrValidationVerdict[] | undefined {
  const path = 'validation'
  const items = walkSeq(ctx, entry, path)
  if (items === null) return undefined
  const verdicts: DcrValidationVerdict[] = []
  const seen = new Set<string>()
  for (const { item, index } of items) {
    const verdict = walkVerdict(ctx, item, `${path}[${String(index)}]`)
    if (verdict === null) continue
    if (seen.has(verdict.nodeId)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${path}: duplicate verdict for node ${JSON.stringify(verdict.nodeId)} — at most one verdict per node`,
        path,
        item,
      )
      continue
    }
    seen.add(verdict.nodeId)
    verdicts.push(verdict)
  }
  return verdicts.length > 0
    ? verdicts.sort((a, b) => compareDcrStrings(a.nodeId, b.nodeId))
    : undefined
}

function walkVerdict(ctx: WalkContext, node: YamlNode, path: string): DcrValidationVerdict | null {
  const entries = collectEntries(ctx, node, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (nodeId/input/valid/violatedRules), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, VERDICT_KEYS, path)
  if (!requireKeys(ctx, entries, ['nodeId', 'input', 'valid', 'violatedRules'], path, node))
    return null
  const nodeId = wantIdString(ctx, entries.get('nodeId') as Entry, `${path}.nodeId`)
  const input = wantNonEmptyString(ctx, entries.get('input') as Entry, `${path}.input`)
  const valid = wantBoolean(ctx, entries.get('valid') as Entry, `${path}.valid`)
  const violatedRules = wantSafeInt(
    ctx,
    entries.get('violatedRules') as Entry,
    `${path}.violatedRules`,
    0,
  )
  let rowCount: number | undefined
  const rowCountEntry = entries.get('rowCount')
  if (rowCountEntry !== undefined) {
    const parsed = wantSafeInt(ctx, rowCountEntry, `${path}.rowCount`, 0)
    if (parsed === null) return null
    rowCount = parsed
  }
  const rulesEntry = entries.get('rules')
  let rules: readonly DcrValidationRuleRow[] | undefined
  if (rulesEntry !== undefined) {
    const ruleItems = walkSeq(ctx, rulesEntry, `${path}.rules`)
    if (ruleItems === null) return null
    {
      const rows: DcrValidationRuleRow[] = []
      const ruleSeen = new Set<string>()
      for (const { item, index } of ruleItems) {
        const rule = walkRule(ctx, item, `${path}.rules[${String(index)}]`)
        if (rule === null) continue
        if (ruleSeen.has(rule.ruleId)) {
          pushError(
            ctx,
            'duplicate-reference',
            `${path}.rules: duplicate rule ${JSON.stringify(rule.ruleId)} — at most one row per rule id`,
            path,
            item,
          )
          continue
        }
        ruleSeen.add(rule.ruleId)
        rows.push(rule)
      }
      rules =
        rows.length > 0 ? rows.sort((a, b) => compareDcrStrings(a.ruleId, b.ruleId)) : undefined
    }
  }
  if (nodeId === null || input === null || valid === null || violatedRules === null) return null
  return {
    nodeId,
    input,
    valid,
    violatedRules,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(rules !== undefined ? { rules } : {}),
  }
}

function walkRule(ctx: WalkContext, node: YamlNode, path: string): DcrValidationRuleRow | null {
  const entries = collectEntries(ctx, node, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (ruleId/failCount/failPercent), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, RULE_KEYS, path)
  if (!requireKeys(ctx, entries, ['ruleId', 'failCount', 'failPercent'], path, node)) return null
  const ruleId = wantNonEmptyString(ctx, entries.get('ruleId') as Entry, `${path}.ruleId`)
  let kind: string | undefined
  if (entries.has('kind')) {
    const parsed = wantOptionalString(ctx, entries.get('kind') as Entry, `${path}.kind`)
    if (parsed === undefined) return null // the error is already reported
    kind = parsed
  }
  let column: string | undefined
  if (entries.has('column')) {
    const parsed = wantOptionalString(ctx, entries.get('column') as Entry, `${path}.column`)
    if (parsed === undefined) return null
    column = parsed
  }
  const failCount = wantSafeInt(ctx, entries.get('failCount') as Entry, `${path}.failCount`, 0)
  const failPercent = wantSafeInt(
    ctx,
    entries.get('failPercent') as Entry,
    `${path}.failPercent`,
    0,
    100,
  )
  if (ruleId === null || failCount === null || failPercent === null) return null
  return {
    ruleId,
    ...(kind !== undefined ? { kind } : {}),
    ...(column !== undefined ? { column } : {}),
    failCount,
    failPercent,
  }
}

function walkLineage(ctx: WalkContext, entry: Entry): DcrLineage | undefined {
  const path = 'lineage'
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (inputVersionIds/nodes), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  rejectUnknownKeys(ctx, entries, LINEAGE_KEYS, path)
  let inputVersionIds: readonly string[] | undefined
  const inputsEntry = entries.get('inputVersionIds')
  if (inputsEntry !== undefined) {
    const parsed = wantSortedUniqueSeq(ctx, inputsEntry, `${path}.inputVersionIds`, 'version id')
    if (parsed === null) return undefined // the error is already reported
    inputVersionIds = parsed
  }
  let nodes: readonly string[] | undefined
  const nodesEntry = entries.get('nodes')
  if (nodesEntry !== undefined) {
    const parsed = wantOrderedUniqueSeq(ctx, nodesEntry, `${path}.nodes`, 'node id')
    if (parsed === null) return undefined
    // Node ids are id-position fields: the reserved namespace is refused
    // (dataset-side version ids are user data and are not reserved).
    for (const [index, node] of parsed.entries()) {
      if (node.toLowerCase().startsWith(DCR_RESERVED_PREFIX)) {
        pushError(
          ctx,
          'reserved-identifier',
          `${path}.nodes[${String(index)}]: identifiers beginning with "${DCR_RESERVED_PREFIX}" are reserved for the DCR format itself (D17-Q9)`,
          `${path}.nodes[${String(index)}]`,
          nodesEntry.valueNode,
        )
        return undefined
      }
    }
    nodes = parsed
  }
  // A lineage block carrying nothing is not a spelling of "no lineage" —
  // omit the block entirely (one shape per meaning).
  if (
    (inputVersionIds === undefined || inputVersionIds.length === 0) &&
    (nodes === undefined || nodes.length === 0)
  ) {
    if (inputsEntry !== undefined || nodesEntry !== undefined) {
      pushError(
        ctx,
        'out-of-range',
        `${path}: carries no lineage — omit the lineage block entirely, or name at least one input version / producing node`,
        path,
        entry.valueNode,
      )
    }
    return undefined
  }
  return {
    ...(inputVersionIds !== undefined && inputVersionIds.length > 0 ? { inputVersionIds } : {}),
    ...(nodes !== undefined && nodes.length > 0 ? { nodes } : {}),
  }
}

function walkPrivacy(ctx: WalkContext, entry: Entry): DcrPrivacyFindings | null {
  const path = 'privacyFindings'
  const resolved = resolveNode(ctx, entry.valueNode)
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a mapping (status/disclosure), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  rejectUnknownKeys(ctx, entries, PRIVACY_KEYS, path)
  if (!requireKeys(ctx, entries, PRIVACY_KEYS, path, entry.valueNode)) return null
  const status = wantString(ctx, entries.get('status') as Entry, `${path}.status`)
  const disclosure = wantString(ctx, entries.get('disclosure') as Entry, `${path}.disclosure`)
  if (status === null || disclosure === null) return null
  // D17-Q6a: the one canonical "not computed" spelling — an honesty
  // statement, not a free-text placeholder a producer could vary.
  if (status !== 'not-computed') {
    pushError(
      ctx,
      'out-of-range',
      `${path}.status: the only v1 status is "not-computed" (no local privacy-analysis producer exists; D17-Q6)`,
      path,
      entries.get('status')?.valueNode ?? entry.valueNode,
    )
    return null
  }
  if (disclosure !== DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE) {
    pushError(
      ctx,
      'out-of-range',
      `${path}.disclosure: must be exactly the canonical disclosure (D17-Q6a): ${JSON.stringify(DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE)}`,
      path,
      entries.get('disclosure')?.valueNode ?? entry.valueNode,
    )
    return null
  }
  return { status: 'not-computed', disclosure }
}
