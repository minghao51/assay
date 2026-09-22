/**
 * Canonical contract serializer (m5-0): one `ContractV1` → one exact YAML
 * text, byte-stable everywhere the format appears.
 *
 * ## Canonical form
 *
 * - Root keys in fixed order: `format`, `name`, `version`, `description`,
 *   `columns`, `dataset`; column keys in fixed order (`name`, `type`,
 *   `required`, `unique`, `min`, `max`, `allowed-values`, `regex`,
 *   `max-null-share`, `min-distinct-share`); dataset keys `min-rows`,
 *   `max-rows`. Only present rules are emitted.
 * - Absent-but-empty rules stay absent (mirroring the parser's canonical
 *   normalization: `description: ''` → omitted, false booleans → omitted,
 *   rule-less column entries → omitted, rule-less `dataset` → omitted; an
 *   empty `columns` array → omitted). An **empty `allowed-values: []` is
 *   emitted** — it is a real constraint ("every non-NULL value fails"), not
 *   an absence.
 * - `allowed-values` renders as a flow sequence (`[ US, GB ]`); everything
 *   else is block style, 2-space indent, no line folding (`lineWidth: 0`),
 *   single trailing newline.
 * - Scalars render with the `yaml` library's canonical quoting (strings that
 *   would parse as bool/number/null are quoted). The same AST always yields
 *   the same bytes — key order and whitespace in any *source* document are
 *   gone by the time the AST exists (property-tested).
 *
 * ## Trust boundary (mirrors `baseRowId` in `@assay/domain`)
 *
 * The parameter is *typed*: callers pass a `ContractV1` from `parseContract`
 * or a correctly built AST. The function is still total — it reads only the
 * known fields with defensive reads, so a caller bug (a non-conforming value
 * behind a cast) degrades to deterministic, plain output rather than a raw
 * throw; such output is not guaranteed to re-parse as a *valid* contract.
 */
import { Document, stringify } from 'yaml'
import { CONTRACT_FORMAT } from './ast'
import type { ColumnRuleSet, ContractScalar, ContractV1, DatasetRuleSet } from './ast'

/** Serialize a contract to its canonical YAML form. Total; see the module doc. */
export function serializeContract(contract: ContractV1): string {
  const doc = new Document()
  const root: Record<string, unknown> = {
    format: CONTRACT_FORMAT,
    name: asText(contract?.metadata?.name),
    version: asPositiveInt(contract?.metadata?.version, 1),
  }
  const description = contract?.metadata?.description
  if (typeof description === 'string' && description !== '') root.description = description

  const columns = contract?.columns
  if (Array.isArray(columns) && columns.length > 0) {
    // Rule-less entries (name only) are normalized away by the parser and
    // dropped here too, so a caller bug behind a cast cannot smuggle a shape
    // the format does not express back through serialization.
    const ruled = columns.filter(hasDeclaredRule)
    if (ruled.length > 0) root.columns = ruled.map((column) => serializeColumn(doc, column))
  }

  const dataset = serializeDataset(contract?.dataset)
  if (dataset !== undefined) root.dataset = dataset

  doc.contents = doc.createNode(root)
  return stringify(doc, {
    lineWidth: 0, // never fold long scalars — folding would be another canonical-degree-of-freedom
    indent: 2,
  })
}

function serializeColumn(doc: Document, column: ColumnRuleSet): Record<string, unknown> {
  const out: Record<string, unknown> = { name: asText(column?.name) }
  if (typeof column?.type === 'string') out.type = column.type
  if (column?.required === true) out.required = true
  if (column?.unique === true) out.unique = true
  if (isFiniteNumber(column?.min)) out.min = normZero(column.min)
  if (isFiniteNumber(column?.max)) out.max = normZero(column.max)
  const allowedValues = column?.allowedValues
  if (Array.isArray(allowedValues)) {
    // Flow style is the canonical rendering for value lists; invalid entries
    // (a caller bug behind a cast) are dropped defensively. Numeric entries
    // normalize `-0` → `0` (the m5-0 ±0 rule, AR-V5).
    const scalars = allowedValues
      .filter(isContractScalar)
      .map((value) => (typeof value === 'number' ? normZero(value) : value))
    out['allowed-values'] = doc.createNode(scalars, { flow: true })
  }
  if (typeof column?.regex === 'string') out.regex = column.regex
  if (isUnitInterval(column?.maxNullShare)) out['max-null-share'] = normZero(column.maxNullShare)
  if (isUnitInterval(column?.minDistinctShare))
    out['min-distinct-share'] = normZero(column.minDistinctShare)
  return out
}

function serializeDataset(
  dataset: DatasetRuleSet | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (isNonNegativeInt(dataset?.minRows)) out['min-rows'] = normZero(dataset.minRows)
  if (isNonNegativeInt(dataset?.maxRows)) out['max-rows'] = normZero(dataset.maxRows)
  return Object.keys(out).length > 0 ? out : undefined
}

/** m5-0's canonical ±0 rule: `-0` and `0` are one value (AR-V5). */
function normZero(value: number): number {
  return value === 0 ? 0 : value
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Does this rule set carry at least one rule (anything beyond `name`)? Same predicate as the parser's. */
function hasDeclaredRule(column: ColumnRuleSet): boolean {
  return (
    column?.type !== undefined ||
    column?.required !== undefined ||
    column?.unique !== undefined ||
    column?.min !== undefined ||
    column?.max !== undefined ||
    column?.allowedValues !== undefined ||
    column?.regex !== undefined ||
    column?.maxNullShare !== undefined ||
    column?.minDistinctShare !== undefined
  )
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isContractScalar(value: unknown): value is ContractScalar {
  return typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback
}
