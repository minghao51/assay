// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline transform → SQL compiler (p-2; ADR 0029/0030/0032).
 *
 * `compilePipeline` turns a validated {@link PipelineV1} into a deterministic,
 * byte-stable list of DuckDB SQL queries — one per executable node, in
 * topological order. Structured transform operations compile to SQL
 * (ADR 0029); `sql` nodes carry verbatim SQL that is validated by a
 * conservative single-statement classifier ({@link classifyVerbatimSql}).
 *
 * ## Relation naming (ruling 4)
 *
 * A node's **id is its output relation name**, rendered through the shared
 * `quoteIdentifier` helper — there are no generated internal names. Every
 * `FROM` reference to an input is that input's node id, quoted; the compiled
 * plan carries each node's (unquoted) relation and its quoted spelling.
 * Ruling 1 (`reserved-identifier` at parse) exists so this identity can never
 * collide with the repo-wide reserved `assay_*` namespace: verbatim SQL
 * references relations by id, so a compile-time rename would break it.
 *
 * ## Materialization → local statements (p2-3; ADR 0033)
 *
 * Compilation now carries the **mode → local statement** mapping (architecture
 * §8) additively: each compiled entry exposes its effective `materialization`
 * mode plus the `statement` the local runner executes and its `statementKind`.
 * `sql`/`relation` semantics are unchanged — the P1 runner and CLI keep reading
 * the plain query until p2-4 rewires them.
 *
 * | mode | local statement | `statementKind` |
 * | --- | --- | --- |
 * | `view` (and absent-default) | `CREATE OR REPLACE VIEW "<rel>" AS <query>` | `view` |
 * | `ephemeral` | the view mechanism (DuckDB views are lazy/session-bound) | `view` |
 * | `table` | `CREATE OR REPLACE TABLE "<rel>" AS <query>` | `table` |
 * | `export` | `COPY (<query>) TO '<path>' (<options>)` | `export` |
 *
 * `ephemeral` maps to the **view** mechanism rather than CTE folding: DuckDB
 * views are lazy and session-bound, so the view mapping preserves ephemeral's
 * no-persistent-storage intent locally at zero structural cost, where CTE
 * folding would restructure the DAG SQL per consumer. The architecture §8 row
 * ("CTE / nested SQL") stays satisfied in spirit: locally, ephemeral is an
 * unnamed-per-consumer relation never written to durable storage.
 *
 * `export` writes a deterministic destination derived from the node id under
 * the repo's `assay-exports/` scratch convention (ADR 0017), with one canonical
 * default format (`FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880` —
 * the engine's `EXPORT_FORMAT_OPTIONS.parquet` and the fixture-generator
 * conventions, ADR 0038). The node-id stem is encoded so a hostile id cannot
 * introduce a path segment (`/`, `\`, `.`, `..`) or collide with another id.
 *
 * `cache`, `incremental`, and `publish` are **typed refusals**: OPFS-backed
 * caching and incremental strategies are future slices, and publish-mode
 * materialization is the P3 / Dataset Change Request boundary. Unsupported
 * modes fail explicitly; silent semantic changes are not allowed (ADR 0033).
 *
 * A source's `statement` is `null` with `statementKind` `source` — sources are
 * base relations the runner registers through the engine's file path, not SQL.
 *
 * The statements are overlay-agnostic: they read the base relations named by
 * node id and compose no grid/session overlays.
 *
 * A `sql` node's text is carried **verbatim** (after the classifier accepts
 * it): its declared `inputs` are resolved by DAG validation, but the
 * compiler does not rewrite or re-verify the relation names written inside
 * the text — the author addresses relations by node id, exactly as the
 * architecture §5 example does.
 *
 * ## P1/P2 transform vocabulary
 *
 * Exactly seven operations are compiled; every other operation, and every
 * refusal of any kind, is expressible through the **escape hatch**:
 *
 * > **Escape hatch contract.** A `sql` node carrying verbatim SQL with its
 * > declared `inputs` is the universal fallback. Anything the structured
 * > vocabulary does not cover — non-inner joins, richer aggregates, other
 * > window functions, dialect-specific syntax, or a malformed structured
 * > operation — belongs in a `sql` node. Every compiler refusal message
 * > points at that path.
 *
 * The unary compiled shapes (over `inputs: [source]`):
 *
 * ```sql
 * -- select-columns: { columns: [a, b] }
 * SELECT
 *   "a",
 *   "b"
 * FROM "source"
 *
 * -- rename: { columns: { a: x, b: y } }
 * SELECT
 *   * EXCLUDE ("a", "b"),
 *   "a" AS "x",
 *   "b" AS "y"
 * FROM "source"
 *
 * -- cast: { columns: { amount: DECIMAL, age: INTEGER } }
 * SELECT
 *   * REPLACE (
 *     CAST("amount" AS DECIMAL) AS "amount",
 *     CAST("age" AS INTEGER) AS "age"
 *   )
 * FROM "source"
 *
 * -- filter: { predicates: [ { column: country, operator: equals, value: SG },
 * --                          { column: income, operator: greater-than, value: 50000 } ] }
 * SELECT
 *   *
 * FROM "source"
 * WHERE ("country" = 'SG') AND ("income" > 50000)
 *
 * -- aggregate: { group_by: [country], aggregations: [{ op: sum, column: income, as: total }] }
 * SELECT
 *   "country",
 *   SUM("income") AS "total"
 * FROM "source"
 * GROUP BY "country"
 *
 * -- window: { function: row_number, partition_by: [country],
 * --           order_by: [{ column: income, direction: desc }], as: rank }
 * SELECT
 *   *,
 *   ROW_NUMBER() OVER (PARTITION BY "country" ORDER BY "income" DESC) AS "rank"
 * FROM "source"
 * ```
 *
 * `join` is the one binary operation: `{ left, right, on: [<column>, …] }` over
 * `inputs: [left, right]`. Both refs must be among the node's `inputs`, `on`
 * names at least one column present in both sides, and the compiled clause is
 * `INNER JOIN "right" USING (…)` (the grammar restricts `on` to same-named
 * columns, which is exactly DuckDB's `USING` semantics and yields one merged
 * key column). Only inner joins are in the minimal vocabulary; other join
 * kinds stay escape-hatch SQL:
 *
 * ```sql
 * -- join: { left: customers, right: policies, on: [customer_id] }
 * SELECT
 *   *
 * FROM "customers"
 * INNER JOIN "policies" USING ("customer_id")
 * ```
 *
 * ### aggregate / window grammars
 *
 * `aggregate: { group_by: [<column>, …], aggregations: [ { op, column, as }, … ] }`.
 * `group_by` is required (an empty list is a global aggregate) and
 * `aggregations` is a non-empty list. `op` is one of `sum`, `count`, `min`,
 * `max`, `avg`; `column` is required for every op except `count`, which omits
 * it to mean `COUNT(*)`; `as` is the required, explicit output alias (one shape
 * per meaning, no auto-derived names). Group-by columns and aliases may not
 * repeat.
 *
 * `window: { function, order_by: [ { column, direction }, … ], partition_by?: [<column>, …], as }`.
 * `function` is one of `row_number`, `rank`, `dense_rank`; `order_by` is a
 * non-empty list with `direction` exactly `asc` or `desc`; `partition_by` is
 * optional (non-empty when present); `as` is the required explicit alias. The
 * single window function is added as one extra column: `*,
 * ROW_NUMBER() OVER (…) AS "alias"`.
 *
 * `rename` uses DuckDB's `* EXCLUDE (…), … AS …` and `cast` uses
 * `* REPLACE (…)` precisely so neither needs the source schema: P1
 * compilation is schema-free (the engine binds at execution).
 *
 * ## Filter grammar
 *
 * The filter is a **structured predicate list** — never a free-form
 * expression string — mirroring the m2-2 column-qualified fragment
 * semantics (`packages/grid` FilterSpec is the semantic precedent; its code
 * is deliberately not imported — this package stays pure). Each predicate is
 * a mapping:
 *
 * - `column` — a non-empty column name (rendered via `quoteIdentifier`).
 * - `operator` — one of `equals`, `not-equals`, `less-than`,
 *   `less-than-or-equal`, `greater-than`, `greater-than-or-equal`, `is-null`,
 *   `is-not-null`, `in`, `not-in`.
 * - `value` — required by the binary comparisons; a string, boolean, or
 *   finite number (rendered via the `@assay/validation` `sql*Literal`
 *   helpers). `null` is refused: use `is-null`.
 * - `values` — required by `in`/`not-in`; a non-empty list of the same
 *   scalar kinds.
 *
 * Unknown keys, an absent/extra value shape, or `null` as a value are
 * `invalid-filter` refusals. Predicates are AND-composed in list order.
 *
 * ## Purity, totality, determinism
 *
 * `compilePipeline` is pure and total: no engine/grid/UI imports, no Node
 * builtins, no execution, no clocks, no randomness. Same AST ⇒ same bytes
 * (mapping-key order is canonicalized by sorting; list order is meaning).
 * A caller bug behind a cast degrades to a typed error rather than a throw.
 *
 * Purity: `@assay/contracts` (type vocabulary + numeric policy) and
 * `@assay/validation` (identifier/literal helpers) only — lint-enforced.
 */

import { CONTRACT_TYPE_VOCABULARY, contractTypeHint } from '@assay/contracts'
import {
  quoteIdentifier,
  sqlBooleanLiteral,
  sqlNumberLiteral,
  sqlStringLiteral,
} from '@assay/validation'
import {
  DEFAULT_MATERIALIZATION,
  MATERIALIZATION_MODES,
  compareNodeIds,
  isMaterializationMode,
} from '../ast.js'
import type { MaterializationMode, PipelineNode, PipelineV1 } from '../ast.js'
import { validatePipeline } from '../dag.js'
import type { PipelineError, PipelineErrorCode } from '../errors.js'
import { classifyVerbatimSql } from './sql-safety.js'
import type { VerbatimSqlRefusal } from './sql-safety.js'

/** How a compiled node's `statement` realizes its materialization mode. */
export const COMPILED_STATEMENT_KINDS = ['source', 'view', 'table', 'export'] as const

export type CompiledStatementKind = (typeof COMPILED_STATEMENT_KINDS)[number]

/** One compiled executable node. `sql` is `null` for a source base relation. */
export interface CompiledNode {
  readonly nodeId: string
  readonly kind: 'source' | 'transform' | 'sql'
  /** The output relation name (the node id, verbatim). */
  readonly relation: string
  /** `relation` rendered as a quoted SQL identifier (via `quoteIdentifier`). */
  readonly quotedRelation: string
  /** The query computing this node's output, or `null` for a source. */
  readonly sql: string | null
  /** The effective ADR 0033 mode (declared, or the absent-default `view`). */
  readonly materialization?: MaterializationMode
  /**
   * The local statement realizing `materialization`: the view/table DDL, the
   * export `COPY`, or `null` for a source (registered, not SQL). Composed by
   * {@link compilePipeline} (p2-3); `sql` stays the plain query. Optional so a
   * caller-supplied plan literal stays type-compatible (the extension is
   * additive); every compiler-produced entry sets it.
   */
  readonly statement?: string | null
  /** What `statement` is; `source` means `statement` is `null`. */
  readonly statementKind?: CompiledStatementKind
}

/** A compiled pipeline: the deterministic plan and its per-node statements. */
export interface PipelineCompilePlan {
  /** The deterministic topological node order (dependencies first, ties by id). */
  readonly order: readonly string[]
  /** One entry per executable node, in `order` (sources included with `sql: null`). */
  readonly nodes: readonly CompiledNode[]
}

/** A compile outcome: a plan or collected typed refusals — never a throw. */
export type PipelineCompileResult =
  | { readonly ok: true; readonly plan: PipelineCompilePlan }
  | { readonly ok: false; readonly errors: readonly PipelineError[] }

/** The compiled transform vocabulary. Anything else is the escape hatch. */
export const COMPILED_TRANSFORM_OPERATIONS = [
  'select-columns',
  'rename',
  'cast',
  'filter',
  'join',
  'aggregate',
  'window',
] as const

export type CompiledTransformOperation = (typeof COMPILED_TRANSFORM_OPERATIONS)[number]

/**
 * The materialization modes the local backend maps to statements. The other
 * three ADR 0033 modes (`cache`, `incremental`, `publish`) are typed refusals
 * rather than silent fallbacks.
 */
export const LOCAL_MATERIALIZATION_MODES = ['ephemeral', 'view', 'table', 'export'] as const

export type LocalMaterializationMode = (typeof LOCAL_MATERIALIZATION_MODES)[number]

/** The export conventions (engine `EXPORT_FORMAT_OPTIONS.parquet`, ADR 0038). */
const EXPORT_DIRECTORY = 'assay-exports'
const EXPORT_STEM_PREFIX = 'assay-export-'
const EXPORT_FILE_EXTENSION = 'parquet'
const EXPORT_FORMAT_OPTIONS = 'FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880'

/** The closed aggregate-op vocabulary and its SQL spellings. */
const AGGREGATE_OPERATORS: Readonly<Record<string, string>> = {
  sum: 'SUM',
  count: 'COUNT',
  min: 'MIN',
  max: 'MAX',
  avg: 'AVG',
}

/** The closed window-function vocabulary and its SQL spellings. */
const WINDOW_FUNCTIONS: Readonly<Record<string, string>> = {
  row_number: 'ROW_NUMBER',
  rank: 'RANK',
  dense_rank: 'DENSE_RANK',
}

/** `join` is the only binary transform operation in the compiled vocabulary. */
const BINARY_TRANSFORM_OPERATIONS: ReadonlySet<string> = new Set(['join'])

/** The closed cast-target vocabulary (reuses the contract declared-type set). */
const CAST_TYPES: ReadonlySet<string> = new Set(CONTRACT_TYPE_VOCABULARY)

type FilterArity = 'binary' | 'null' | 'list'

interface FilterOperatorSpec {
  readonly arity: FilterArity
  /** The comparison operator for `binary`; unused for `null`/`list`. */
  readonly sql: string
}

const FILTER_OPERATORS: Readonly<Record<string, FilterOperatorSpec>> = {
  equals: { arity: 'binary', sql: '=' },
  'not-equals': { arity: 'binary', sql: '<>' },
  'less-than': { arity: 'binary', sql: '<' },
  'less-than-or-equal': { arity: 'binary', sql: '<=' },
  'greater-than': { arity: 'binary', sql: '>' },
  'greater-than-or-equal': { arity: 'binary', sql: '>=' },
  'is-null': { arity: 'null', sql: '' },
  'is-not-null': { arity: 'null', sql: '' },
  in: { arity: 'list', sql: '' },
  'not-in': { arity: 'list', sql: '' },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pushError(
  errors: PipelineError[],
  code: PipelineErrorCode,
  nodeId: string,
  path: string,
  message: string,
): void {
  errors.push({ code, message, path, nodeId })
}

/**
 * The documented escape hatch (module header): anything the structured P1
 * vocabulary does not compile belongs in a `sql` node carrying verbatim SQL
 * with declared inputs. It is appended to the operation/filter/cast refusals
 * (and the unknown-operation refusal) so each points at the fallback. The
 * verbatim-SQL classifier's own `invalid-sql` messages are exempt (a `sql`
 * node is already that path), as are the defensive `invalid-node` shapes.
 */
const ESCAPE_HATCH_HINT =
  '; express anything else as a sql node carrying verbatim SQL with declared inputs'

/**
 * Compile a validated pipeline to deterministic SQL. Total: any input —
 * including a broken value behind a cast — yields a plan or typed errors.
 * Internally re-runs DAG validation so unresolved references or cycles are
 * reported through the same typed surface rather than producing unbound SQL.
 */
export function compilePipeline(pipeline: PipelineV1): PipelineCompileResult {
  try {
    return compileInternal(pipeline)
  } catch {
    // Totality backstop: a hostile value shape (a throwing getter, a revoked
    // proxy) degrades to a single value-free typed refusal.
    return {
      ok: false,
      errors: [
        {
          code: 'invalid-node',
          message:
            'the pipeline could not be compiled — an unexpected value shape was encountered; check node ids, inputs, and operation arguments',
          path: 'pipeline',
        },
      ],
    }
  }
}

function compileInternal(pipeline: PipelineV1): PipelineCompileResult {
  const validated = validatePipeline(pipeline)
  if (!validated.ok) return { ok: false, errors: validated.errors }

  const byId = new Map<string, PipelineNode>()
  for (const node of validated.pipeline.nodes) byId.set(node.id, node)

  const errors: PipelineError[] = []
  const compiled: CompiledNode[] = []
  for (const id of validated.order) {
    const node = byId.get(id)
    if (node === undefined) continue
    const entry = compileNode(node, errors)
    if (entry !== null) compiled.push(entry)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, plan: { order: validated.order, nodes: compiled } }
}

/** Read a data node's effective mode defensively (the AST guarantees a mode). */
function readEffectiveMaterialization(
  node: unknown,
  relation: string,
  errors: PipelineError[],
): MaterializationMode | null {
  const raw = (node as { materialization?: unknown }).materialization
  if (raw === undefined) return DEFAULT_MATERIALIZATION
  if (!isMaterializationMode(raw)) {
    pushError(
      errors,
      'unsupported-materialization',
      relation,
      `nodes.${relation}.materialization`,
      `nodes.${relation}.materialization: unrecognized materialization mode — the ADR 0033 vocabulary is ${MATERIALIZATION_MODES.join(', ')}`,
    )
    return null
  }
  return raw
}

function isLocalMaterializationMode(mode: MaterializationMode): mode is LocalMaterializationMode {
  return (LOCAL_MATERIALIZATION_MODES as readonly string[]).includes(mode)
}

/**
 * Gate a data node's mode: local modes pass; `cache`/`incremental`/`publish`
 * are typed refusals (ADR 0033 — unsupported modes fail explicitly rather than
 * silently changing semantics).
 */
function supportMaterialization(
  mode: MaterializationMode,
  relation: string,
  errors: PipelineError[],
): mode is LocalMaterializationMode {
  if (isLocalMaterializationMode(mode)) return true
  const reason =
    mode === 'publish'
      ? 'publish-mode materialization is the P3 / Dataset Change Request boundary, not a local mechanism'
      : `the local ${mode} strategy is a future slice`
  pushError(
    errors,
    'unsupported-materialization',
    relation,
    `nodes.${relation}.materialization`,
    `nodes.${relation}.materialization: ${mode} is not supported by the local compiler — ${reason}; unsupported modes fail explicitly rather than silently changing semantics (ADR 0033)`,
  )
  return false
}

/**
 * The deterministic, path-safe export destination for a node id (module doc).
 * `encodeExportStem` keeps ASCII letters/digits/`-`/`_` and renders every
 * other UTF-16 code unit as `~XXXX`, yielding one path-safe, collision-free
 * segment (`~` is never emitted raw, so the escape marker is unambiguous).
 */
function exportDestination(relation: string): string {
  return `${EXPORT_DIRECTORY}/${EXPORT_STEM_PREFIX}${encodeExportStem(relation)}.${EXPORT_FILE_EXTENSION}`
}

function encodeExportStem(id: string): string {
  let out = ''
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index)
    const ch = id[index] as string
    const safe =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      ch === '-' ||
      ch === '_'
    out += safe ? ch : `~${code.toString(16).padStart(4, '0')}`
  }
  return out
}

/** Map a supported mode to its local statement (the architecture §8 contract). */
function composeMaterializationStatement(
  mode: LocalMaterializationMode,
  relation: string,
  quotedRelation: string,
  query: string,
): { readonly statement: string; readonly statementKind: CompiledStatementKind } {
  switch (mode) {
    case 'view':
    case 'ephemeral':
      return {
        statement: `CREATE OR REPLACE VIEW ${quotedRelation} AS ${query}`,
        statementKind: 'view',
      }
    case 'table':
      return {
        statement: `CREATE OR REPLACE TABLE ${quotedRelation} AS ${query}`,
        statementKind: 'table',
      }
    case 'export':
      return {
        statement: `COPY (${query}) TO ${sqlStringLiteral(exportDestination(relation))} (${EXPORT_FORMAT_OPTIONS})`,
        statementKind: 'export',
      }
  }
}

/**
 * Build a compiled data-node entry: gate + map the materialization mode around
 * the already-compiled `query`. Returns `null` after pushing a refusal.
 */
function compileDataEntry(
  kind: 'transform' | 'sql',
  node: unknown,
  relation: string,
  quotedRelation: string,
  query: string,
  errors: PipelineError[],
): CompiledNode | null {
  const mode = readEffectiveMaterialization(node, relation, errors)
  if (mode === null) return null
  if (!supportMaterialization(mode, relation, errors)) return null
  const { statement, statementKind } = composeMaterializationStatement(
    mode,
    relation,
    quotedRelation,
    query,
  )
  return {
    nodeId: relation,
    kind,
    relation,
    quotedRelation,
    sql: query,
    materialization: mode,
    statement,
    statementKind,
  }
}

/** Compile one node. Returns `null` after pushing a refusal. */
function compileNode(node: PipelineNode, errors: PipelineError[]): CompiledNode | null {
  const relation = node.id
  const quotedRelation = quoteIdentifier(relation)
  switch (node.type) {
    case 'source': {
      const mode = readEffectiveMaterialization(node, relation, errors)
      if (mode === null) return null
      if (!supportMaterialization(mode, relation, errors)) return null
      return {
        nodeId: relation,
        kind: 'source',
        relation,
        quotedRelation,
        sql: null,
        materialization: mode,
        statement: null,
        statementKind: 'source',
      }
    }
    case 'transform':
      return compileTransformNode(node, relation, quotedRelation, errors)
    case 'sql':
      return compileSqlNode(node, relation, quotedRelation, errors)
    case 'validate':
    case 'diff':
    case 'publish':
      pushError(
        errors,
        'reserved-node-class',
        relation,
        `nodes.${relation}`,
        `nodes.${relation}: the ${node.type} node is reserved until P2 — P1 compiles source/transform/sql only; use a sql node for behaviour the P1 vocabulary does not compile`,
      )
      return null
    default:
      pushError(
        errors,
        'invalid-node',
        relation,
        `nodes.${relation}`,
        `nodes.${relation}: unrecognized node type — expected source, transform, or sql`,
      )
      return null
  }
}

function readInputs(node: unknown): string[] | null {
  const inputs = (node as { inputs?: unknown }).inputs
  if (!Array.isArray(inputs)) return null
  const out: string[] = []
  for (const item of inputs) {
    if (typeof item !== 'string' || item.length === 0) return null
    out.push(item)
  }
  return out
}

/** Reject any argument key outside an operation's documented set. */
function rejectUnknownArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  relation: string,
  errors: PipelineError[],
): void {
  for (const key of Object.keys(args).sort(compareNodeIds)) {
    if (allowed.includes(key)) continue
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.${key}`,
      `${path}.${key}: unexpected argument for this operation — the operation accepts: ${allowed.join(', ')}${ESCAPE_HATCH_HINT}`,
    )
  }
}

function compileTransformNode(
  node: unknown,
  relation: string,
  quotedRelation: string,
  errors: PipelineError[],
): CompiledNode | null {
  const path = `nodes.${relation}`
  const operation = (node as { operation?: unknown }).operation
  if (!isRecord(operation)) {
    pushError(
      errors,
      'invalid-node',
      relation,
      `${path}.operation`,
      `${path}.operation: expected an operation mapping with a name and arguments`,
    )
    return null
  }
  const name = operation.operation
  const args = operation.args
  if (typeof name !== 'string' || name.length === 0 || !isRecord(args)) {
    pushError(
      errors,
      'invalid-node',
      relation,
      `${path}.operation`,
      `${path}.operation: expected an operation name and an argument mapping`,
    )
    return null
  }
  const inputs = readInputs(node)
  const binary = BINARY_TRANSFORM_OPERATIONS.has(name)
  const expected = binary ? 2 : 1
  if (inputs === null || inputs.length !== expected) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.inputs`,
      binary
        ? `${path}.inputs: the ${name} operation is binary and expects exactly two inputs${ESCAPE_HATCH_HINT}`
        : `${path}.inputs: the ${name} operation is unary and expects exactly one input${ESCAPE_HATCH_HINT}`,
    )
    return null
  }

  const input = quoteIdentifier(inputs[0] as string)
  const opPath = `${path}.operation.${name}`
  let sql: string | null
  switch (name) {
    case 'select-columns':
      sql = compileSelectColumns(args, input, opPath, relation, errors)
      break
    case 'rename':
      sql = compileRename(args, input, opPath, relation, errors)
      break
    case 'cast':
      sql = compileCast(args, input, opPath, relation, errors)
      break
    case 'filter':
      sql = compileFilter(args, input, opPath, relation, errors)
      break
    case 'join':
      sql = compileJoin(args, inputs, opPath, relation, errors)
      break
    case 'aggregate':
      sql = compileAggregate(args, input, opPath, relation, errors)
      break
    case 'window':
      sql = compileWindow(args, input, opPath, relation, errors)
      break
    default:
      pushError(
        errors,
        'unknown-operation',
        relation,
        `${path}.operation`,
        `${path}.operation: unknown transform operation ${JSON.stringify(name)} — the compiled vocabulary is ${COMPILED_TRANSFORM_OPERATIONS.join(', ')}; express anything else as a sql node carrying verbatim SQL with declared inputs`,
      )
      return null
  }
  if (sql === null) return null
  return compileDataEntry('transform', node, relation, quotedRelation, sql, errors)
}

function compileSqlNode(
  node: unknown,
  relation: string,
  quotedRelation: string,
  errors: PipelineError[],
): CompiledNode | null {
  const path = `nodes.${relation}`
  const sql = (node as { sql?: unknown }).sql
  if (typeof sql !== 'string' || sql.length === 0) {
    pushError(
      errors,
      'invalid-sql',
      relation,
      `${path}.sql`,
      `${path}.sql: expected non-empty verbatim SQL text`,
    )
    return null
  }
  const classification = classifyVerbatimSql(sql)
  if (!classification.ok) {
    pushError(
      errors,
      'invalid-sql',
      relation,
      `${path}.sql`,
      sqlRefusalMessage(classification.refusal),
    )
    return null
  }
  return compileDataEntry('sql', node, relation, quotedRelation, sql, errors)
}

/** Value-free message for a classifier refusal (never echoes the SQL text). */
function sqlRefusalMessage(refusal: VerbatimSqlRefusal): string {
  switch (refusal) {
    case 'empty':
      return 'the verbatim SQL is empty'
    case 'multi-statement':
      return 'the verbatim SQL must be exactly one statement — a second statement (or trailing text after a statement terminator) was found'
    case 'not-a-read-statement':
      return 'the verbatim SQL must be a single read-only statement beginning with SELECT, WITH, VALUES, FROM, TABLE, or PIVOT'
    case 'forbidden-keyword':
      return 'the verbatim SQL contains a data-modifying or utility statement keyword; P1 accepts read-only SELECT/WITH/VALUES statements only'
    case 'unterminated-quote':
      return 'the verbatim SQL contains an unterminated string or quoted identifier'
    case 'unterminated-comment':
      return 'the verbatim SQL contains an unterminated block comment'
    case 'unterminated-dollar-quote':
      return 'the verbatim SQL contains an unterminated dollar-quoted string'
    case 'unbalanced-parens':
      return 'the verbatim SQL has unbalanced parentheses (possible trailing garbage)'
    default:
      return 'the verbatim SQL could not be accepted as a single read-only statement'
  }
}

function compileSelectColumns(
  args: Record<string, unknown>,
  input: string,
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['columns'], opPath, relation, errors)
  const columns = args.columns
  if (!Array.isArray(columns) || columns.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.columns`,
      `${opPath}.columns: select-columns expects a non-empty list of column names${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index]
    const at = `${opPath}.columns[${index}]`
    if (typeof column !== 'string' || column.length === 0) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: expected a non-empty column name${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (seen.has(column)) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: duplicate column ${JSON.stringify(column)} — a projection may name each column at most once${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    seen.add(column)
    names.push(column)
  }
  if (errors.length > before) return null
  const projection = names.map((name) => `  ${quoteIdentifier(name)}`).join(',\n')
  return `SELECT\n${projection}\nFROM ${input}`
}

interface RenamePair {
  readonly from: string
  readonly to: string
}

function compileRename(
  args: Record<string, unknown>,
  input: string,
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['columns'], opPath, relation, errors)
  const columns = args.columns
  if (!isRecord(columns) || Object.keys(columns).length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.columns`,
      `${opPath}.columns: rename expects a non-empty mapping of existing column name to new column name${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const pairs: RenamePair[] = []
  const targets = new Set<string>()
  for (const from of Object.keys(columns).sort(compareNodeIds)) {
    const at = `${opPath}.columns.${from}`
    const to = columns[from]
    if (from.length === 0) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: the existing column name must be non-empty${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (typeof to !== 'string' || to.length === 0) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: expected a non-empty new column name${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (targets.has(to)) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: two columns cannot both be renamed to ${JSON.stringify(to)} — a relation has one column per name${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    targets.add(to)
    pairs.push({ from, to })
  }
  if (errors.length > before) return null
  const excluded = pairs.map((pair) => quoteIdentifier(pair.from)).join(', ')
  const renamed = pairs
    .map((pair) => `  ${quoteIdentifier(pair.from)} AS ${quoteIdentifier(pair.to)}`)
    .join(',\n')
  return `SELECT\n  * EXCLUDE (${excluded}),\n${renamed}\nFROM ${input}`
}

interface CastPair {
  readonly column: string
  readonly type: string
}

function compileCast(
  args: Record<string, unknown>,
  input: string,
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['columns'], opPath, relation, errors)
  const columns = args.columns
  if (!isRecord(columns) || Object.keys(columns).length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.columns`,
      `${opPath}.columns: cast expects a non-empty mapping of column name to a declared type${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const pairs: CastPair[] = []
  for (const column of Object.keys(columns).sort(compareNodeIds)) {
    const at = `${opPath}.columns.${column}`
    const spelling = columns[column]
    if (column.length === 0) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: the column name must be non-empty${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (typeof spelling !== 'string') {
      pushError(
        errors,
        'invalid-cast-type',
        relation,
        at,
        `${at}: expected a declared type spelling (one of: ${CONTRACT_TYPE_VOCABULARY.join(', ')})${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (!CAST_TYPES.has(spelling)) {
      const hint = contractTypeHint(spelling)
      pushError(
        errors,
        'invalid-cast-type',
        relation,
        at,
        `${at}: unknown type ${JSON.stringify(spelling)} — the P1 cast vocabulary is the declared-type set: ${CONTRACT_TYPE_VOCABULARY.join(', ')}${hint === null ? '' : ` (did you mean ${hint}?)`}${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    pairs.push({ column, type: spelling })
  }
  if (errors.length > before) return null
  const replacements = pairs
    .map(
      (pair) =>
        `    CAST(${quoteIdentifier(pair.column)} AS ${pair.type}) AS ${quoteIdentifier(pair.column)}`,
    )
    .join(',\n')
  return `SELECT\n  * REPLACE (\n${replacements}\n  )\nFROM ${input}`
}

function compileFilter(
  args: Record<string, unknown>,
  input: string,
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['predicates'], opPath, relation, errors)
  const predicates = args.predicates
  if (!Array.isArray(predicates) || predicates.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.predicates`,
      `${opPath}.predicates: filter expects a non-empty list of predicates${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const rendered: string[] = []
  for (let index = 0; index < predicates.length; index++) {
    const sql = renderPredicate(
      predicates[index],
      `${opPath}.predicates[${index}]`,
      relation,
      errors,
    )
    if (sql !== null) rendered.push(sql)
  }
  if (errors.length > before) return null
  const where = rendered.map((predicate) => `(${predicate})`).join(' AND ')
  return `SELECT\n  *\nFROM ${input}\nWHERE ${where}`
}

/** Read a non-empty string argument; pushes a refusal on failure. */
function readNonEmptyStringArg(
  args: Record<string, unknown>,
  key: string,
  path: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.${key}`,
      `${path}.${key}: expected a non-empty string${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  return value
}

/**
 * Read a list of unique non-empty column names. `allowEmpty` admits the empty
 * list (a global aggregate's `group_by`). Returns a partial list when entries
 * are malformed — callers must check `errors.length` before using it.
 */
function readColumnList(
  value: unknown,
  path: string,
  relation: string,
  errors: PipelineError[],
  options: { readonly allowEmpty: boolean },
): string[] | null {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      path,
      options.allowEmpty
        ? `${path}: expected a list of column names${ESCAPE_HATCH_HINT}`
        : `${path}: expected a non-empty list of column names${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const column = value[index]
    const at = `${path}[${index}]`
    if (typeof column !== 'string' || column.length === 0) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: expected a non-empty column name${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (seen.has(column)) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: duplicate column ${JSON.stringify(column)} — each column may be named at most once${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    seen.add(column)
    names.push(column)
  }
  return names
}

/**
 * `join: { left, right, on: [<column>, …] }` — the one binary operation. The
 * node's two inputs must be exactly `left`/`right`, and `on` names the
 * same-named join columns, rendered as DuckDB's `USING` clause (one merged key
 * column; see the module doc). Only inner joins are in the vocabulary.
 */
function compileJoin(
  args: Record<string, unknown>,
  inputs: readonly string[],
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['left', 'right', 'on'], opPath, relation, errors)
  const left = readNonEmptyStringArg(args, 'left', opPath, relation, errors)
  const right = readNonEmptyStringArg(args, 'right', opPath, relation, errors)
  const on = readColumnList(args.on, `${opPath}.on`, relation, errors, { allowEmpty: false })
  if (errors.length > before || left === null || right === null || on === null) return null

  if (left === right) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      opPath,
      `${opPath}: join left and right must name two different inputs${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  if (!inputs.includes(left) || !inputs.includes(right)) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      opPath,
      `${opPath}: join left/right must name the node's two inputs${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const columns = on.map((column) => quoteIdentifier(column)).join(', ')
  return `SELECT\n  *\nFROM ${quoteIdentifier(left)}\nINNER JOIN ${quoteIdentifier(right)} USING (${columns})`
}

/** `aggregate: { group_by, aggregations: [ { op, column, as }, … ] }` (module doc). */
function compileAggregate(
  args: Record<string, unknown>,
  input: string,
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['group_by', 'aggregations'], opPath, relation, errors)
  const groupBy = readColumnList(args.group_by, `${opPath}.group_by`, relation, errors, {
    allowEmpty: true,
  })
  const aggregations = args.aggregations
  if (!Array.isArray(aggregations) || aggregations.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.aggregations`,
      `${opPath}.aggregations: expected a non-empty list of aggregations${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const rendered: string[] = []
  const aliases = new Set<string>()
  for (let index = 0; index < aggregations.length; index++) {
    const renderedAgg = renderAggregation(
      aggregations[index],
      `${opPath}.aggregations[${index}]`,
      relation,
      aliases,
      errors,
    )
    if (renderedAgg !== null) rendered.push(renderedAgg)
  }
  if (errors.length > before || groupBy === null) return null

  const grouped = groupBy.map((column) => quoteIdentifier(column))
  const head = `SELECT\n  ${[...grouped, ...rendered].join(',\n  ')}\nFROM ${input}`
  return grouped.length === 0 ? head : `${head}\nGROUP BY ${grouped.join(', ')}`
}

/** Render one aggregate projection; `null` after pushing a refusal. */
function renderAggregation(
  aggregation: unknown,
  path: string,
  relation: string,
  aliases: Set<string>,
  errors: PipelineError[],
): string | null {
  if (!isRecord(aggregation)) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      path,
      `${path}: expected an aggregation mapping with op, column, and as${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  rejectUnknownArgs(aggregation, ['op', 'column', 'as'], path, relation, errors)
  const op = aggregation.op
  if (typeof op !== 'string' || !Object.hasOwn(AGGREGATE_OPERATORS, op)) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.op`,
      `${path}.op: unknown aggregate op ${typeof op === 'string' ? JSON.stringify(op) : ''} — expected one of: ${Object.keys(AGGREGATE_OPERATORS).join(', ')}${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const as = aggregation.as
  if (typeof as !== 'string' || as.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.as`,
      `${path}.as: expected a non-empty output alias${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  if (aliases.has(as)) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.as`,
      `${path}.as: duplicate output alias ${JSON.stringify(as)} — each aggregation needs a distinct alias${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const fn = AGGREGATE_OPERATORS[op] as string
  const column = aggregation.column
  if (column === undefined) {
    if (op !== 'count') {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        `${path}.column`,
        `${path}.column: the ${op} aggregation requires a column${ESCAPE_HATCH_HINT}`,
      )
      return null
    }
    aliases.add(as)
    return `${fn}(*) AS ${quoteIdentifier(as)}`
  }
  if (typeof column !== 'string' || column.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.column`,
      `${path}.column: expected a non-empty column name${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  aliases.add(as)
  return `${fn}(${quoteIdentifier(column)}) AS ${quoteIdentifier(as)}`
}

/**
 * `window: { function, order_by, partition_by?, as }` (module doc): adds one
 * window-function column to `*`.
 */
function compileWindow(
  args: Record<string, unknown>,
  input: string,
  opPath: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  rejectUnknownArgs(args, ['function', 'partition_by', 'order_by', 'as'], opPath, relation, errors)
  const fn = args.function
  if (typeof fn !== 'string' || !Object.hasOwn(WINDOW_FUNCTIONS, fn)) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.function`,
      `${opPath}.function: unknown window function ${typeof fn === 'string' ? JSON.stringify(fn) : ''} — expected one of: ${Object.keys(WINDOW_FUNCTIONS).join(', ')}${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const as = args.as
  if (typeof as !== 'string' || as.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.as`,
      `${opPath}.as: expected a non-empty output alias${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const orderBy = args.order_by
  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${opPath}.order_by`,
      `${opPath}.order_by: expected a non-empty list of order terms${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const orderTerms: string[] = []
  const orderedColumns = new Set<string>()
  for (let index = 0; index < orderBy.length; index++) {
    const at = `${opPath}.order_by[${index}]`
    const term = orderBy[index]
    if (!isRecord(term)) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        at,
        `${at}: expected an order term mapping with column and direction${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    rejectUnknownArgs(term, ['column', 'direction'], at, relation, errors)
    const column = term.column
    if (typeof column !== 'string' || column.length === 0) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        `${at}.column`,
        `${at}.column: expected a non-empty column name${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    if (orderedColumns.has(column)) {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        `${at}.column`,
        `${at}.column: duplicate order column ${JSON.stringify(column)}${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    const direction = term.direction
    if (direction !== 'asc' && direction !== 'desc') {
      pushError(
        errors,
        'invalid-operation-args',
        relation,
        `${at}.direction`,
        `${at}.direction: expected "asc" or "desc"${ESCAPE_HATCH_HINT}`,
      )
      continue
    }
    orderedColumns.add(column)
    orderTerms.push(`${quoteIdentifier(column)} ${direction.toUpperCase()}`)
  }
  let partition: string | null = null
  if (args.partition_by !== undefined) {
    const columns = readColumnList(args.partition_by, `${opPath}.partition_by`, relation, errors, {
      allowEmpty: false,
    })
    partition =
      columns === null ? null : columns.map((column) => quoteIdentifier(column)).join(', ')
  }
  if (errors.length > before) return null

  const over = `${partition === null ? '' : `PARTITION BY ${partition} `}ORDER BY ${orderTerms.join(', ')}`
  return `SELECT\n  *,\n  ${WINDOW_FUNCTIONS[fn] as string}() OVER (${over}) AS ${quoteIdentifier(as)}\nFROM ${input}`
}

function renderPredicate(
  predicate: unknown,
  path: string,
  relation: string,
  errors: PipelineError[],
): string | null {
  const before = errors.length
  if (!isRecord(predicate)) {
    pushError(
      errors,
      'invalid-filter',
      relation,
      path,
      `${path}: expected a predicate mapping with column, operator, and value/values${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  rejectUnknownArgs(predicate, ['column', 'operator', 'value', 'values'], path, relation, errors)

  const column = predicate.column
  if (typeof column !== 'string' || column.length === 0) {
    pushError(
      errors,
      'invalid-filter',
      relation,
      `${path}.column`,
      `${path}.column: expected a non-empty column name${ESCAPE_HATCH_HINT}`,
    )
  }
  const operator = predicate.operator
  if (typeof operator !== 'string' || !Object.hasOwn(FILTER_OPERATORS, operator)) {
    pushError(
      errors,
      'invalid-filter',
      relation,
      `${path}.operator`,
      `${path}.operator: unknown filter operator ${typeof operator === 'string' ? JSON.stringify(operator) : ''} — expected one of: ${Object.keys(FILTER_OPERATORS).join(', ')}${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  if (errors.length > before) return null

  const spec = FILTER_OPERATORS[operator] as FilterOperatorSpec
  const qualified = quoteIdentifier(column as string)
  const hasValue = Object.hasOwn(predicate, 'value')
  const hasValues = Object.hasOwn(predicate, 'values')

  if (spec.arity === 'null') {
    if (hasValue || hasValues) {
      pushError(
        errors,
        'invalid-filter',
        relation,
        path,
        `${path}: the ${operator} operator takes no value${ESCAPE_HATCH_HINT}`,
      )
      return null
    }
    return `${qualified} ${operator === 'is-null' ? 'IS NULL' : 'IS NOT NULL'}`
  }

  if (spec.arity === 'binary') {
    if (!hasValue || hasValues) {
      pushError(
        errors,
        'invalid-filter',
        relation,
        path,
        `${path}: the ${operator} operator expects exactly one "value"${ESCAPE_HATCH_HINT}`,
      )
      return null
    }
    const literal = renderScalarLiteral(predicate.value)
    if (literal === null) {
      pushError(
        errors,
        'invalid-filter',
        relation,
        `${path}.value`,
        `${path}.value: expected a string, boolean, or finite number (use is-null for null)${ESCAPE_HATCH_HINT}`,
      )
      return null
    }
    return `${qualified} ${spec.sql} ${literal}`
  }

  // list arity (in / not-in)
  if (hasValue || !hasValues) {
    pushError(
      errors,
      'invalid-filter',
      relation,
      path,
      `${path}: the ${operator} operator expects exactly one non-empty "values" list${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const values = predicate.values
  if (!Array.isArray(values) || values.length === 0) {
    pushError(
      errors,
      'invalid-filter',
      relation,
      `${path}.values`,
      `${path}.values: expected a non-empty list of literals${ESCAPE_HATCH_HINT}`,
    )
    return null
  }
  const literals: string[] = []
  for (let index = 0; index < values.length; index++) {
    const literal = renderScalarLiteral(values[index])
    if (literal === null) {
      pushError(
        errors,
        'invalid-filter',
        relation,
        `${path}.values[${index}]`,
        `${path}.values[${index}]: expected a string, boolean, or finite number${ESCAPE_HATCH_HINT}`,
      )
      return null
    }
    literals.push(literal)
  }
  return `${qualified} ${operator === 'in' ? 'IN' : 'NOT IN'} (${literals.join(', ')})`
}

/** Render a filter scalar via the sanctioned SQL literal helpers. */
function renderScalarLiteral(value: unknown): string | null {
  if (typeof value === 'string') return sqlStringLiteral(value)
  if (typeof value === 'boolean') return sqlBooleanLiteral(value)
  if (typeof value === 'number' && Number.isFinite(value)) return sqlNumberLiteral(value)
  return null
}
