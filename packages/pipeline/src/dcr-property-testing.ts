// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic generators for the p3-1 DCR property tests (test support
 * only — NOT part of the public surface; `index.ts` never re-exports this
 * module). Mirrors `property-testing.ts`: mulberry32 PRNG, fixed seeds in
 * the test files, no `Math.random`, and generated artifacts are always
 * *canonical* ASTs — every name-keyed collection sorted, empty collections
 * absent, aspects in the documented order, unique entries, row keys in the
 * anchor-free export grammar, and only exactly-representable decimals
 * (halves/quarters/eighths — an imprecise literal would fail the
 * exact-or-rejected gate at parse).
 *
 * The reserved `assay_dcr_*` namespace is deliberately absent from every
 * id pool (it is refused at parse/build; it belongs to the negative corpus).
 */
import {
  DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
  compareDcrStrings,
  isAnchorFreeRowKey,
} from './dcr-ast.js'
import type {
  DcrArtifactV1,
  DcrColumnDistributionDelta,
  DcrRowDiff,
  DcrRowDiffAspectResult,
  DcrSchemaDriftFinding,
  DcrValidationVerdict,
  DcrVersionRef,
} from './dcr-ast.js'
import { makeTestRng } from './property-testing.js'
import type { TestRng } from './property-testing.js'

export { makeTestRng }

/**
 * Hostile-ish id/name pool: quotes, whitespace, unicode, numeric-looking
 * keys (`1`, `01` exercise Map-based canonical ordering), and the
 * prototype-pollution probe `__proto__`. No `assay_dcr_*` (reserved).
 */
const DATASET_IDS = ['dataset-alpha', 'dataset_beta', '1', 'ünï data']
const VERSION_IDS = ['version-1', 'v2_base', '01', '2']
const FINGERPRINT_ALGOS = ['assay-schema-fingerprint-v1', 'sha256-schema']
const RECIPE_TEXTS = ['filter + rename', 'join then aggregate', '']
const EXPORT_PATHS = [
  'exports/run-1/out.parquet',
  './exports/run-2/out.jsonl',
  'exports/run 3/out.parquet',
]
const COLUMN_NAMES = [
  'order_id',
  'customer_ref',
  'amount',
  'status',
  'region_code',
  'priority',
  'a b',
  'ünïcol',
]
const KEY_COLUMNS = ['order_id', 'customer_ref', 'txn_key']
const TYPE_SPELLINGS = ['INTEGER', 'VARCHAR', 'DECIMAL(18,2)', 'BOOLEAN', 'DATE', 'UUID', 'JSON']
const FAMILIES = [
  'numeric',
  'textual',
  'boolean',
  'temporal',
  'uuid',
  'json',
  'blob',
  'other',
] as const
const PROFILE_KINDS = ['numeric', 'categorical', 'other'] as const
const CATEGORY_LABELS = ['alpha', 'beta', 'gamma', 'ünï', 'a"b']
const RULE_KINDS = ['declared-type', 'required', 'unique', 'min-rows', 'max-null-share', 'regex']
const RULE_IDS = [
  'min-rows:2000',
  'required:region_code',
  'unique:order_id',
  'declared-type:amount',
]
const NODE_IDS = ['src_orders', 'filter_recent', 'aggregate_daily', 'check_rows', '1', 'a"b']
/**
 * Only exactly-representable decimals: every share/metric the generator
 * writes must survive the YAML→number parse bit-for-bit (the
 * exact-or-rejected gate refuses the rest).
 */
const EXACT_NUMBERS = [0, 0.25, 0.5, 0.75, 1, -0.25, 0.125, -0.125, 12.5, -2.5, 30.5]

/** A canonical string list: unique entries, ascending code-unit order. */
function genSortedUnique(rng: TestRng, pool: readonly string[]): string[] {
  return [...new Set(rng.shuffle([...pool]).slice(0, rng.int(0, Math.min(2, pool.length))))].sort(
    compareDcrStrings,
  )
}

function genRef(rng: TestRng): DcrVersionRef {
  const recipe = RECIPE_TEXTS[rng.int(0, RECIPE_TEXTS.length - 1)] ?? ''
  const parents = genSortedUnique(rng, VERSION_IDS)
  const withRecipe = rng.bool(0.7) && recipe.length > 0
  const materialization = rng.bool(0.5)
    ? { node: rng.pick(NODE_IDS) }
    : { export: rng.pick(EXPORT_PATHS) }
  return {
    datasetId: rng.pick(DATASET_IDS),
    versionId: rng.pick(VERSION_IDS),
    schemaFingerprint: {
      algorithm: rng.pick(FINGERPRINT_ALGOS),
      value: `fp-${String(rng.int(0, 9999)).padStart(4, '0')}`,
    },
    ...(withRecipe || parents.length > 0
      ? {
          provenance: {
            ...(withRecipe ? { transformationRecipe: recipe } : {}),
            ...(parents.length > 0 ? { parentVersionIds: parents } : {}),
          },
        }
      : {}),
    materialization,
  }
}

function genFinding(rng: TestRng): DcrSchemaDriftFinding {
  const column = rng.pick(COLUMN_NAMES)
  const roll = rng.int(0, 3)
  if (roll === 0) return { kind: 'column-added', column }
  if (roll === 1) return { kind: 'column-removed', column }
  if (roll === 2) {
    const typeA = rng.pick(TYPE_SPELLINGS)
    const typeB = rng.pick(TYPE_SPELLINGS)
    return {
      kind: typeA === typeB ? 'type-changed-same-family' : 'type-changed-cross-family',
      column,
      typeA,
      typeB,
      familyA: rng.pick(FAMILIES),
      familyB: rng.pick(FAMILIES),
    }
  }
  const shareA = rng.bool(0.3) ? null : (rng.pick([0, 0.25, 0.5]) as number)
  const shareB = rng.bool(0.3) ? null : (rng.pick([0.5, 0.75, 1]) as number)
  return {
    kind: 'nullability-changed',
    column,
    ...(shareA !== undefined ? { nullShareA: shareA } : {}),
    ...(shareB !== undefined ? { nullShareB: shareB } : {}),
  }
}

function genColumnDelta(rng: TestRng): DcrColumnDistributionDelta {
  const column = rng.pick(COLUMN_NAMES)
  const kindA = rng.pick(PROFILE_KINDS)
  const kindB = rng.pick(PROFILE_KINDS)
  const numeric =
    kindA === 'numeric' && kindB === 'numeric' && rng.bool(0.8)
      ? {
          meanShiftStandardized: rng.bool(0.2) ? null : (rng.pick(EXACT_NUMBERS) as number),
          varianceShiftStandardized: rng.bool(0.2) ? null : (rng.pick(EXACT_NUMBERS) as number),
          p50Shift: rng.bool(0.2) ? null : (rng.pick(EXACT_NUMBERS) as number),
          p90Shift: rng.bool(0.2) ? null : (rng.pick(EXACT_NUMBERS) as number),
        }
      : undefined
  const categorical =
    kindA === 'categorical' && kindB === 'categorical' && rng.bool(0.8)
      ? {
          totalVariation: rng.bool(0.2)
            ? null
            : (rng.pick([0, 0.125, 0.25, 0.5, 0.75, 1]) as number),
          newCategories: genTopK(rng),
          vanishedCategories: genTopK(rng),
          // The D19-OQ-4 bounding disclosure (p3-1b), exercised in every
          // state: each flag independent, so present/absent combinations
          // (and the all-absent pre-disclosure shape) all reach the pins.
          ...(rng.bool(0.25) ? { newCategoriesBounded: true as const } : {}),
          ...(rng.bool(0.25) ? { vanishedCategoriesBounded: true as const } : {}),
        }
      : undefined
  return {
    column,
    typeA: rng.pick(TYPE_SPELLINGS),
    typeB: rng.pick(TYPE_SPELLINGS),
    kindA,
    kindB,
    ...(numeric !== undefined ? { numeric } : {}),
    ...(categorical !== undefined ? { categorical } : {}),
  }
}

function genTopK(rng: TestRng): readonly { value: string; count: number }[] {
  const labels = [...new Set(rng.shuffle([...CATEGORY_LABELS]).slice(0, rng.int(0, 2)))]
  return labels.map((value) => ({ value, count: rng.int(0, 500) }))
}

function genRowKey(rng: TestRng, side: 'A' | 'B'): string {
  const ordinal = rng.int(0, 9999)
  const form = side === 'A' ? (rng.bool(0.7) ? 'base' : 'insert') : rng.bool(0.5) ? 'b' : 'base'
  const key = `${form}:${String(ordinal)}`
  if (!isAnchorFreeRowKey(key)) throw new Error(`generator produced a hostile row key: ${key}`)
  return key
}

function genRowDiff(rng: TestRng): DcrRowDiff {
  const keys = [...new Set(rng.shuffle([...KEY_COLUMNS]).slice(0, rng.int(1, 2)))]
  const sampleA = (): { side: 'A' | 'B'; rowKey: string; changedColumns?: readonly string[] } => {
    const side: 'A' | 'B' = rng.bool(0.5) ? 'A' : 'B'
    return { side, rowKey: genRowKey(rng, side) }
  }
  const changedSample = (): {
    side: 'A' | 'B'
    rowKey: string
    changedColumns?: readonly string[]
  } => {
    const base = sampleA()
    const changed = [...new Set(rng.shuffle([...COLUMN_NAMES]).slice(0, rng.int(0, 3)))].sort(
      compareDcrStrings,
    )
    return { ...base, ...(changed.length > 0 ? { changedColumns: changed } : {}) }
  }
  const aspect = (name: 'added' | 'removed' | 'changed', count: number): DcrRowDiffAspectResult => {
    const samples = Array.from({ length: Math.min(count, rng.int(0, 2)) }, () =>
      name === 'changed' ? changedSample() : sampleA(),
    )
    return { aspect: name, count, samples }
  }
  return {
    keys,
    sampleLimit: rng.pick([1, 20, 100]),
    rowCountA: rng.int(0, 5000),
    rowCountB: rng.int(0, 5000),
    aspects: [
      aspect('added', rng.int(0, 50)),
      aspect('removed', rng.int(0, 50)),
      aspect('changed', rng.int(0, 50)),
    ],
  }
}

function genVerdict(rng: TestRng): DcrValidationVerdict {
  const rules = rng
    .shuffle([...RULE_IDS])
    .slice(0, rng.int(0, 2))
    .map((ruleId) => ({
      ruleId,
      ...(rng.bool(0.8) ? { kind: rng.pick(RULE_KINDS) } : {}),
      ...(rng.bool(0.6) ? { column: rng.pick(COLUMN_NAMES) } : {}),
      failCount: rng.int(0, 1000),
      failPercent: rng.pick([0, 25, 50, 75, 100]),
    }))
    .sort((a, b) => compareDcrStrings(a.ruleId, b.ruleId))
  const rowCount = rng.int(0, 5000)
  return {
    nodeId: rng.pick(NODE_IDS),
    input: rng.pick(NODE_IDS),
    valid: rng.bool(0.5),
    violatedRules: rng.int(0, 5),
    rowCount,
    ...(rules.length > 0 ? { rules } : {}),
  }
}

/** Generate a canonical DCR artifact. */
export function genDcr(rng: TestRng): DcrArtifactV1 {
  const findings = rng
    .shuffle([...COLUMN_NAMES])
    .slice(0, rng.int(0, 3))
    .map(() => genFinding(rng))
  // One finding per (column, kind), canonical order.
  const seen = new Set<string>()
  const uniqueFindings = findings.filter((finding) => {
    const id = `${finding.column}\u0000${finding.kind}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  const deltaColumns = [...new Set(rng.shuffle([...COLUMN_NAMES]).slice(0, rng.int(0, 2)))]
  const deltas = {
    ...(uniqueFindings.length > 0
      ? {
          schemaDrift: uniqueFindings.sort((a, b) =>
            a.column === b.column
              ? DCR_KIND_INDEX(a.kind) - DCR_KIND_INDEX(b.kind)
              : compareDcrStrings(a.column, b.column),
          ),
        }
      : {}),
    ...(deltaColumns.length > 0
      ? {
          columnDeltas: deltaColumns
            .map((column) => ({ ...genColumnDelta(rng), column }))
            .sort((a, b) => compareDcrStrings(a.column, b.column)),
        }
      : {}),
    ...(rng.bool(0.5) ? { rowDiff: genRowDiff(rng) } : {}),
  }
  const verdicts = rng
    .shuffle([...NODE_IDS])
    .slice(0, rng.int(0, 2))
    .map(() => genVerdict(rng))
  const seenNodes = new Set<string>()
  const uniqueVerdicts = verdicts.filter((verdict) => {
    if (seenNodes.has(verdict.nodeId)) return false
    seenNodes.add(verdict.nodeId)
    return true
  })
  const lineageNodes = (() => {
    const nodes = [...new Set(rng.shuffle([...NODE_IDS]).slice(0, rng.int(0, 3)))]
    return nodes
  })()
  const inputVersions = genSortedUnique(rng, VERSION_IDS)
  return {
    format: 'assay-dcr',
    version: 1,
    base: genRef(rng),
    candidate: genRef(rng),
    deltas,
    ...(uniqueVerdicts.length > 0
      ? { validation: uniqueVerdicts.sort((a, b) => compareDcrStrings(a.nodeId, b.nodeId)) }
      : {}),
    ...(lineageNodes.length > 0 || inputVersions.length > 0
      ? {
          lineage: {
            ...(inputVersions.length > 0 ? { inputVersionIds: inputVersions } : {}),
            ...(lineageNodes.length > 0 ? { nodes: lineageNodes } : {}),
          },
        }
      : {}),
    privacyFindings: { status: 'not-computed', disclosure: DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE },
  }
}

/** The documented kind order (mirrors the AST's canonical comparator). */
function DCR_KIND_INDEX(kind: DcrSchemaDriftFinding['kind']): number {
  const order: Readonly<Record<DcrSchemaDriftFinding['kind'], number>> = {
    'column-added': 0,
    'column-removed': 1,
    'type-changed-cross-family': 2,
    'type-changed-same-family': 3,
    'type-changed-unclassifiable': 4,
    'nullability-changed': 5,
  }
  return order[kind]
}

/**
 * Render a *valid but deliberately non-canonical* document: JSON (a YAML 1.2
 * subset) with shuffled key order and varying indentation, so key order,
 * whitespace, and scalar style all differ from the canonical block form.
 * `parseDcr` of it must equal the AST and `serializeDcr` must be
 * byte-identical to the canonical bytes.
 */
export function renderAlternateDcr(rng: TestRng, artifact: DcrArtifactV1): string {
  const indent = rng.pick([0, 1, 2])
  return JSON.stringify(toPlainShuffle(rng, artifact), null, indent === 0 ? undefined : indent)
}

/** A JSON-shaped value with shuffled mapping keys (the alternate-rendering form). */
type ShuffledJson =
  | string
  | number
  | boolean
  | null
  | readonly ShuffledJson[]
  | { readonly [key: string]: ShuffledJson }

function toPlainShuffle(rng: TestRng, value: unknown): ShuffledJson {
  if (Array.isArray(value)) return value.map((item) => toPlainShuffle(rng, item))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, ShuffledJson> = {}
    for (const key of rng.shuffle(Object.keys(value as Record<string, ShuffledJson>))) {
      out[key] = toPlainShuffle(rng, (value as Record<string, ShuffledJson>)[key])
    }
    return out
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return null // `undefined` has no JSON form; canonical ASTs never carry it
}
