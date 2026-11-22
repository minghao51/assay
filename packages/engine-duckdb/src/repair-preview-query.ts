// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B1 / ENG-2 — the repair preview's affected-set predicate, engine-side.
 *
 * ## Why this lives here
 *
 * The repair preview answers a **value-defined** question — "which rows does
 * this plan actually change?" — over the whole effective relation. The typed
 * `engine/overlay-row-count` op deliberately counts the effective *union*
 * without the repair wrap ("values don't affect counts", D16/D17 probe §4.2),
 * so it cannot answer a predicate over values. Before ENG-2 the affected count
 * was therefore *composed in the host* (`apps/web/src/edit/repair/preview-sql.ts`)
 * out of this package's exported composers and executed through the generic
 * `engine/query` op — which left the definition of "affected" as a web-layer
 * string, pinned only by web tests.
 *
 * ENG-2 moves the definition, not the semantics: {@link repairAffectedPredicate}
 * is the same string the web composed, produced here (the engine's own
 * provider), so the new op {@link composeRepairPreviewCountSql} and the
 * `engine/overlay-range` examples filter consume one implementation and cannot
 * diverge. The composed SQL is **byte-identical** to the previous web
 * composition, which is what the transitional parity test in `apps/web` and the
 * real-engine conformance matrix here pin.
 *
 * ## The predicate: affected ⟺ the repaired value differs from the value now
 *
 * With `t = trim_t(v)` (the plan's explicit trim set applied to `v`; `t = v`
 * when the plan declares no trim), `M` the plan's pair map and `v` the
 * effective value:
 *
 * ```text
 * repaired(v) = M[t] ?? t                          (NULL never matches, never produced)
 * affected(v) ⟺ v IS NOT NULL
 *             ∧ ¬( t ∈ keys(M) ∧ M[t] = v )        (A: the plan maps the trimmed value back to v)
 *             ∧ ¬( t ∉ keys(M) ∧ t = v )           (B: nothing happens — no mapping, no trim)
 * ```
 *
 * Both negated terms are **set membership**, not a copy of the composer's CASE
 * chain (ADR 0051 rule 3 / probe §9: never duplicate or re-nest the wrap):
 *
 * - **A** — "the pair `(t, v)` is not in the plan's pair set", composed as
 *   `(t, v) NOT IN (VALUES (k, M[k]), …)`. Required because a trim and a
 *   mapping can **cancel**: with `trim = ' '` and `M = {a → ' a '}`, the value
 *   `' a '` trims to `a` and maps straight back to `' a '` — the repair changes
 *   nothing, so the row is NOT affected. Without A the preview over-counts
 *   exactly those rows, which is how a no-op plan could pass the zero-affected
 *   refusal (U1) and append an empty history entry (EW-04I fix round 1).
 * - **B** — "a value that misses the mapping is not already its own trimmed
 *   form", composed as `(t IN (keys) OR t <> v)`. Required because trimming
 *   alone changes the value only when `t <> v`, and a mapped value changes it
 *   even when the trim was a no-op.
 *
 * Points worth stating because they were previously argued in the web module:
 *
 * 1. **The mapping targets enter the SQL.** Term A needs the pair set, not only
 *    the keys. Not a privacy change: keys and targets are user-authored plan
 *    configuration (the composer already emits both at publication), never
 *    dataset content, and nothing here logs or transmits them. No key, target
 *    or trim value appears in any refusal message (ADR 0025).
 * 2. **Term B lists ALL keys.** A "keys whose target differs from the key"
 *    subset would be equivalent here (they disagree only on identity pairs,
 *    where `t = v` forces `M[v] = v` so term A is already false), but one flat
 *    key set is the simpler and more obviously complete form.
 * 3. **Values are data, never SQL.** Every key, target and trim character is
 *    escaped by this package's own literal escaper (`cellLiteralRawSql`) and
 *    the column by `quotedIdentifier`; the request carries no predicate text,
 *    and the composed statement carries the plan as escaped literals only.
 *
 * ## What the count does not do
 *
 * One `count(*)` over the engine-composed effective relation (the **export**
 * SELECT composer, which is the composed path that carries the repair wrap) —
 * no second scan, no examples, no `scanned`, no `unaffected`, no sampling and
 * no change to any cap, envelope or persisted artifact.
 */
import { MAX_REPAIR_MAPPING_PAIRS, MAX_REPAIR_TRIM_CODE_POINTS } from '@assay/domain'
import { composeOverlayExportSelectSql } from './export-query.js'
import { quotedIdentifier } from './format-view.js'
import { cellLiteralRawSql } from './overlay-query.js'
import type { OverlayComposition } from './overlay-query.js'
import type { EngineFilterSpec } from './protocol.js'
import { whereClauseSql } from './window-query.js'

/** One repair plan on the wire: plan data, never SQL text. */
export interface EngineRepairPlan {
  /** The effective column the repair targets (`VARCHAR`/`TEXT`/`STRING` only). */
  readonly column: string
  /** The explicit trim code-point set; absent means "no trim". */
  readonly trim?: string
  /**
   * The mapping pairs (`[value, replacement]`), key-unique and in canonical
   * (key-sorted) order — `parseEngineRepairPlan` normalises the order, so the
   * composed SQL is a deterministic function of the plan's *meaning*.
   */
  readonly pairs: readonly (readonly [string, string])[]
}

/**
 * The refusal message for a plan whose text cannot be represented in a SQL
 * string literal at all. Value-free: it names the defect class, never a value.
 *
 * Why refuse rather than escape: this package's literal escaper
 * (`cellLiteralRawSql` → `sqlStringLiteral`) doubles single quotes and nothing
 * else. A NUL is emitted raw and DuckDB's lexer stops at it (`Parser Error:
 * unterminated quoted string` — pinned by the AU-3 boundary probe), and an
 * unpaired surrogate has no lossless representation on the engine wire (
 * au3-13). Neither can be carried by *any* composed statement, so a plan
 * containing one is refused before composition instead of being handed to the
 * engine to fail opaquely.
 */
const UNMATERIALIZABLE_TEXT = 'repair plan contains text the engine cannot materialise'

/** The plan as the canonical (key-sorted, pair-preserving) form. */
function canonicalPairs(
  pairs: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  // Same total order and comparator as the previous host implementation, so
  // the composed SQL for one plan is byte-identical across both.
  return [...pairs].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Structural parse of the op's `plan` field (the untrusted boundary). Types
 * and shapes only — `null` for anything malformed, never a throw, matching the
 * rest of `protocol.ts`. Semantics (cap, duplicates, trim validity, empty
 * plan) are the typed refusals of
 * {@link assertEngineRepairPlanWithinEnvelope}.
 *
 * The returned pairs are canonicalised (key order), so no caller can compose
 * two byte-different statements for one plan.
 */
export function parseEngineRepairPlan(value: unknown): EngineRepairPlan | null {
  if (!isRecord(value)) return null
  const column = value['column']
  if (typeof column !== 'string') return null
  const trim: unknown = value['trim']
  if (trim !== undefined && typeof trim !== 'string') return null
  const entries: unknown = value['pairs']
  if (!Array.isArray(entries)) return null
  const pairs: [string, string][] = []
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const member = entry as readonly unknown[]
    const key: unknown = member[0]
    const target: unknown = member[1]
    if (typeof key !== 'string' || typeof target !== 'string') return null
    pairs.push([key, target])
  }
  const canonical = canonicalPairs(pairs)
  if (trim === undefined) return { column, pairs: canonical }
  return { column, trim, pairs: canonical }
}

/** Throw the value-free refusal for text no SQL literal can carry. */
function assertMaterializableText(text: string): void {
  // U+0000 is refused for the escaper reason above; an unpaired surrogate is
  // refused by `cellLiteralRawSql` itself (au3-13), so both are checked here
  // to keep the refusal typed and pre-execution.
  if (text.includes('\u0000') || !isWellFormed(text)) {
    throw new Error(UNMATERIALIZABLE_TEXT)
  }
}

/** Whether `text` is well-formed UTF-16 (no unpaired surrogate). */
function isWellFormed(text: string): boolean {
  // Written out rather than `String.prototype.isWellFormed` (ES2024; this
  // package targets ES2022) so the refusal never depends on the runtime.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * The plan's **semantic** envelope: the same plan rules the domain fold
 * enforces for a `column-repair` (empty plan, duplicate key, trim shape, pair
 * cap), plus the materialisability rule every composed statement needs. Each
 * refusal is a fixed value-free sentence (ADR 0025) thrown *before* any SQL is
 * composed or executed.
 *
 * Enforcement is deliberately layered: `parseEngineRepairPlan` guards the wire
 * *shape*, this guards the plan's *meaning*, and the executor refuses a column
 * that is unknown or non-textual against the folded effective schema. No layer
 * accepts a plan another rejects.
 */
export function assertEngineRepairPlanWithinEnvelope(plan: EngineRepairPlan): void {
  if (plan.pairs.length > MAX_REPAIR_MAPPING_PAIRS) {
    throw new Error(`repair plan exceeds the ${String(MAX_REPAIR_MAPPING_PAIRS)}-pair cap`)
  }
  const keys = new Set<string>()
  for (const [key, target] of plan.pairs) {
    if (keys.has(key)) {
      // Never the key itself: a duplicate is reported as a defect class.
      throw new Error('repair plan repeats a mapping key')
    }
    keys.add(key)
    assertMaterializableText(key)
    assertMaterializableText(target)
  }
  if (plan.trim !== undefined) {
    // The domain's trim rule: a non-empty set of at most
    // MAX_REPAIR_TRIM_CODE_POINTS code points (astral members count once).
    const codePoints = [...plan.trim].length
    if (codePoints === 0 || codePoints > MAX_REPAIR_TRIM_CODE_POINTS) {
      throw new Error('repair plan has an invalid trim set')
    }
    assertMaterializableText(plan.trim)
  }
  // A plan with no pairs and no trim is the identity: it cannot change a row,
  // so counting it is meaningless and the fold refuses it too.
  if (plan.pairs.length === 0 && plan.trim === undefined) {
    throw new Error('repair plan is empty')
  }
}

/** One string as a SQL string literal, via this package's own escaper. */
function stringLiteral(value: string): string {
  // The escaper throws for an unpaired surrogate (au3-13); the NUL check is the
  // composer's own last gate, so this builder stays total and cannot emit a
  // literal the engine's lexer would truncate.
  assertMaterializableText(value)
  return cellLiteralRawSql({ kind: 'string', value: value })
}

/**
 * The plan's affected-row predicate, in the engine's filter grammar: a
 * fragment that follows `"<column>"` inside `whereClauseSql`'s parentheses
 * (`("col" <predicate>)`). It therefore begins with `IS NOT NULL AND`, which
 * states the repair's NULL rule outright (NULL never matches and is never
 * produced) and cannot change precedence for the terms after it.
 */
export function repairAffectedPredicate(plan: EngineRepairPlan): string {
  const value = quotedIdentifier(plan.column)
  // `t`: the trimmed value the mapping is matched against (the raw value when
  // the plan declares no trim). One `trim(col, set)` occurrence, the same
  // construct the composer emits (never `String.prototype.trim()`).
  const trimmed = plan.trim === undefined ? value : `trim(${value}, ${stringLiteral(plan.trim)})`
  const pairs = canonicalPairs(plan.pairs)
  const terms: string[] = []
  if (pairs.length === 0) {
    // Trim-only plan: the trim is the only thing that can change a value.
    terms.push(`${trimmed} <> ${value}`)
  } else {
    const pairSet = pairs
      .map(([key, target]) => `(${stringLiteral(key)}, ${stringLiteral(target)})`)
      .join(', ')
    // (A) The pair (t, v) is NOT in the plan's pair set: trim and mapping do
    // not cancel. Row-value membership, so the pair set is compared as a set.
    terms.push(`(${trimmed}, ${value}) NOT IN (VALUES ${pairSet})`)
    // (B) The trimmed value is a mapping key, or the trim changed the value.
    const keys = pairs.map(([key]) => stringLiteral(key)).join(', ')
    terms.push(`(${trimmed} IN (${keys}) OR ${trimmed} <> ${value})`)
  }
  return `IS NOT NULL AND ${terms.join(' AND ')}`
}

/** The predicate as the engine's filter spec (one AND-ed clause). */
export function repairAffectedFilter(plan: EngineRepairPlan): EngineFilterSpec {
  return { column: plan.column, predicate: repairAffectedPredicate(plan) }
}

/**
 * The complete affected count over the effective relation, as SQL. Format
 * `parquet` is not cosmetic: the CSV formula guard rewrites projected values,
 * so counting under it would compare sanitized text against the plan. Every
 * non-CSV format composes the identical relation.
 *
 * The relation comes from `composeOverlayExportSelectSql` — the composed path
 * that carries the repair wrap — so a column that already has a repair in the
 * prefix is counted on its *effective* values, not its pre-repair ones.
 */
export function composeRepairPreviewCountSql(
  composition: OverlayComposition,
  plan: EngineRepairPlan,
): string {
  const relation = composeOverlayExportSelectSql(composition, 'parquet')
  const where = whereClauseSql([repairAffectedFilter(plan)])
  if (where === null) {
    throw new Error('a repair predicate is always present')
  }
  return `SELECT count(*)::BIGINT AS affected FROM (${relation}) WHERE ${where}`
}
