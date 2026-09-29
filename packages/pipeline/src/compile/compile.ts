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
 * ## Statements, not materialization
 *
 * Compilation is scoped to the query text. It does **not** emit
 * `CREATE VIEW`/`CREATE TABLE`: materialization is p-3's runner decision
 * (architecture §8/§9), and the P1 IR carries no materialization mode. Each
 * compiled entry therefore exposes the `sql` query that computes the node's
 * output; sources have no query (they are base relations the runner
 * registers). The statements are overlay-agnostic: they read the base
 * relations named by node id and compose no grid/session overlays.
 *
 * A `sql` node's text is carried **verbatim** (after the classifier accepts
 * it): its declared `inputs` are resolved by DAG validation, but the
 * compiler does not rewrite or re-verify the relation names written inside
 * the text — the author addresses relations by node id, exactly as the
 * architecture §5 example does.
 *
 * ## P1 transform vocabulary
 *
 * Exactly four operations are compiled; every other operation, and every
 * refusal of any kind, is expressible through the **escape hatch**:
 *
 * > **Escape hatch contract.** A `sql` node carrying verbatim SQL with its
 * > declared `inputs` is the universal fallback. Anything the structured
 * > vocabulary does not cover — joins, aggregates, window functions,
 * > dialect-specific syntax, or a malformed structured operation — belongs
 * > in a `sql` node. Every compiler refusal message points at that path.
 *
 * The compiled shapes (all over `inputs: [source]`, a single unary input):
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
 * ```
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
import { compareNodeIds } from '../ast.js'
import type { PipelineNode, PipelineV1 } from '../ast.js'
import { validatePipeline } from '../dag.js'
import type { PipelineError, PipelineErrorCode } from '../errors.js'
import { classifyVerbatimSql } from './sql-safety.js'
import type { VerbatimSqlRefusal } from './sql-safety.js'

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

/** The P1 compiled transform vocabulary. Anything else is the escape hatch. */
export const COMPILED_TRANSFORM_OPERATIONS = ['select-columns', 'rename', 'cast', 'filter'] as const

export type CompiledTransformOperation = (typeof COMPILED_TRANSFORM_OPERATIONS)[number]

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

/** Compile one node. Returns `null` after pushing a refusal. */
function compileNode(node: PipelineNode, errors: PipelineError[]): CompiledNode | null {
  const relation = node.id
  const quotedRelation = quoteIdentifier(relation)
  switch (node.type) {
    case 'source':
      return { nodeId: relation, kind: 'source', relation, quotedRelation, sql: null }
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
      `${path}.${key}: unexpected argument for this operation — the P1 vocabulary accepts: ${allowed.join(', ')}${ESCAPE_HATCH_HINT}`,
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
  if (inputs === null || inputs.length !== 1) {
    pushError(
      errors,
      'invalid-operation-args',
      relation,
      `${path}.inputs`,
      `${path}.inputs: the ${name} operation is unary and expects exactly one input${ESCAPE_HATCH_HINT}`,
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
    default:
      pushError(
        errors,
        'unknown-operation',
        relation,
        `${path}.operation`,
        `${path}.operation: unknown transform operation ${JSON.stringify(name)} — the P1 compiled vocabulary is ${COMPILED_TRANSFORM_OPERATIONS.join(', ')}; express anything else as a sql node carrying verbatim SQL with declared inputs`,
      )
      return null
  }
  if (sql === null) return null
  return { nodeId: relation, kind: 'transform', relation, quotedRelation, sql }
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
  return { nodeId: relation, kind: 'sql', relation, quotedRelation, sql }
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
