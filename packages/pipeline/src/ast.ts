// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical Assay Pipeline IR AST (p-1; ADR 0030/0029/0032).
 *
 * `PipelineV1` is the portable, engine-independent meaning of a pipeline
 * document: what the YAML format *says*, stripped of formatting. Everything
 * downstream consumes this shape — never YAML text. The architecture example
 * is `docs/architecture/02-pipeline-dag-etl.md` §5.
 *
 * ## P1 boundary
 *
 * The IR is declarative and engine-neutral. Only three node classes are
 * *executable* in P1 — `source`, `transform`, `sql`. The remaining classes
 * from ADR 0030's list stay **typed-but-reserved**:
 *
 * - `validate` and `publish` have the structural shapes settled by the §5
 *   example (`input`/`contract`, `input`/`requires`); they parse and
 *   round-trip, but no execution semantics (gates, run order, contract
 *   resolution) are defined here — that is P2 (ADR 0035).
 * - `diff`'s shape is settled by p2-2: a typed `{ input, against }` pair of
 *   table references (both consumed as data ports). The opaque-body era is
 *   over — a diff node has exactly one shape.
 *
 * ## Materialization (p2-2; ADR 0033)
 *
 * Every **data-port** node class (`source`, `transform`, `sql`) may declare
 * an optional `materialization` mode — a logical relation-persistence intent
 * the execution backend maps to its own mechanism. The seven modes are ADR
 * 0033's list; **absent means `view`** (the P1 session-view behavior). The
 * AST keeps the field optional so absent stays absent (one shape per
 * meaning); {@link materializationOf} reads the effective mode. Gated nodes
 * (`validate`, `diff`, `publish`) produce verdicts, not relations, so they
 * do not accept the key.
 *
 * ## Node identity and ports
 *
 * A node's **id is its output port**: it is the relation name other nodes
 * reference (`inputs:`/`input:`) and the name p-2/p-3 will materialize. Node
 * ids are arbitrary non-empty user text (hostile names included); rendering
 * them into SQL goes through the shared identifier helper, never hand-rolled
 * quoting (see `identifiers.ts`). Because the port name is the id, "one
 * writer per named output" is the uniqueness rule DAG validation enforces.
 *
 * ## Canonical normalization
 *
 * - `nodes` is an array sorted ascending by id (code-unit order). The YAML
 *   mapping is a set of nodes; order is not meaning, so the parser sorts, the
 *   serializer sorts defensively, and round-trip is exact on canonical ASTs.
 * - `publish.requires` is absent when empty (one shape per meaning).
 * - Generic values (`source` config, operation args) are plain
 *   JSON-like values; the serializer recursively sorts mapping keys.
 *
 * Purity: types + helpers only — no React, no browser APIs, no engine, no
 * dbt/SQLMesh/Dagster concepts (lint-enforced).
 */

/** The only supported Pipeline IR version (ADR 0030: a versioned schema). */
export const PIPELINE_IR_VERSION = 1

/** The literal schema-version discriminator carried by every {@link PipelineV1}. */
export type PipelineIrVersion = typeof PIPELINE_IR_VERSION

/** ADR 0030's initial node-class list. Do not add, remove, or rename. */
export const PIPELINE_NODE_CLASSES = [
  'source',
  'transform',
  'sql',
  'validate',
  'diff',
  'publish',
] as const

export type PipelineNodeClass = (typeof PIPELINE_NODE_CLASSES)[number]

/** Classes executable in P1 (ADR 0029: SQL is the canonical transform target). */
export const EXECUTABLE_NODE_CLASSES = ['source', 'transform', 'sql'] as const

export type ExecutableNodeClass = (typeof EXECUTABLE_NODE_CLASSES)[number]

/** Classes recognized (parseable, round-trippable) but not executable until P2. */
export const RESERVED_NODE_CLASSES = ['validate', 'diff', 'publish'] as const

export type ReservedNodeClass = (typeof RESERVED_NODE_CLASSES)[number]

/** A scalar a generic pipeline value may carry (matches YAML's plain scalars). */
export type PipelineScalar = string | number | boolean | null

/** A generic YAML mapping carried by the IR (source config, operation args). */
export interface PipelineMap {
  readonly [key: string]: PipelineValue
}

/**
 * A generic YAML value. Used where the IR deliberately carries an untyped
 * body: source configuration (per-kind fields) and structured transform
 * operation arguments (the vocabulary is p-2's). Plain JSON-like values only
 * — no anchors, tags, or aliases survive parsing.
 */
export type PipelineValue = PipelineScalar | readonly PipelineValue[] | PipelineMap

/** A source's configuration block (YAML: the `source` mapping, `kind` required). */
export interface SourceConfig extends PipelineMap {
  /** The source kind (e.g. `file`); architecture §6 enumerates the intended set. */
  readonly kind: string
}

/** A structured transform operation (YAML: single-key `operation` mapping). */
export interface OperationConfig {
  /** The operation name — the single key under `operation` (vocabulary owned by p-2). */
  readonly operation: string
  /** The operation's arguments, carried verbatim. */
  readonly args: PipelineMap
}

/** ADR 0033's seven logical materialization modes (lowercase, exact). */
export const MATERIALIZATION_MODES = [
  'ephemeral',
  'view',
  'table',
  'cache',
  'incremental',
  'export',
  'publish',
] as const

export type MaterializationMode = (typeof MATERIALIZATION_MODES)[number]

/** The mode a data node has when it declares none: the P1 session-view behavior. */
export const DEFAULT_MATERIALIZATION: MaterializationMode = 'view'

/** Is `value` one of ADR 0033's logical materialization modes? */
export function isMaterializationMode(value: unknown): value is MaterializationMode {
  return typeof value === 'string' && (MATERIALIZATION_MODES as readonly string[]).includes(value)
}

/**
 * The optional materialization field shared by the data-port node classes.
 * `materialization` absent means {@link DEFAULT_MATERIALIZATION} (`view`); the
 * AST never spells the default out (one shape per meaning).
 */
export interface MaterializedNode {
  readonly materialization?: MaterializationMode
}

/** A source node — a dataset/table input. No input ports; its id is its output port. */
export interface SourceNode extends MaterializedNode {
  readonly id: string
  readonly type: 'source'
  readonly source: SourceConfig
}

/** A structured transform node (filter/cast/join/… — compiled to SQL in p-2). */
export interface TransformNode extends MaterializedNode {
  readonly id: string
  readonly type: 'transform'
  /** Table references this node consumes; at least one. */
  readonly inputs: readonly string[]
  readonly operation: OperationConfig
}

/** An explicit SQL node (the canonical transform target, ADR 0029). */
export interface SqlNode extends MaterializedNode {
  readonly id: string
  readonly type: 'sql'
  /** Table references the SQL reads; may be empty for a constant query. */
  readonly inputs: readonly string[]
  readonly sql: string
}

/** The data-port node classes whose output is a relation (materialization applies). */
export type DataNode = SourceNode | TransformNode | SqlNode

/** Is `node` a data-port node (its output is a relation)? */
export function isDataNode(node: PipelineNode): node is DataNode {
  return node.type === 'source' || node.type === 'transform' || node.type === 'sql'
}

/** A validate node (reserved — ADR 0035 owns its execution semantics). */
export interface ValidateNode {
  readonly id: string
  readonly type: 'validate'
  /** The table reference to validate. */
  readonly input: string
  /** The contract document path/reference (not resolved in P1). */
  readonly contract: string
}

/** A publish node (reserved — ADR 0035 owns gate/execution semantics). */
export interface PublishNode {
  readonly id: string
  readonly type: 'publish'
  /** The table reference to publish. */
  readonly input: string
  /** Gate references that must succeed first; absent when empty. */
  readonly requires?: readonly string[]
}

/** A diff node (p2-2 settled shape): compares two table references. */
export interface DiffNode {
  readonly id: string
  readonly type: 'diff'
  /** The table reference compared as the primary side. */
  readonly input: string
  /** The table reference compared against. */
  readonly against: string
}

/** Any IR node. Discriminated by `type`. */
export type PipelineNode =
  SourceNode | TransformNode | SqlNode | ValidateNode | PublishNode | DiffNode

/**
 * A parsed, structurally validated v1 pipeline (from `parsePipeline` or a
 * correctly built AST). `nodes` is canonical: ascending by id, unique ids.
 */
export interface PipelineV1 {
  readonly version: PipelineIrVersion
  readonly pipeline: string
  /** Canonical order: ascending by id. */
  readonly nodes: readonly PipelineNode[]
}

/** The node classes whose output is a data relation (usable as a table reference). */
export const DATA_NODE_CLASSES = EXECUTABLE_NODE_CLASSES

/**
 * The effective materialization mode of a data node: its declared mode, or
 * {@link DEFAULT_MATERIALIZATION} (`view`) when absent (ADR 0033).
 */
export function materializationOf(node: DataNode): MaterializationMode {
  return node.materialization ?? DEFAULT_MATERIALIZATION
}

/** Is `value` one of the recognized node classes? */
export function isPipelineNodeClass(value: unknown): value is PipelineNodeClass {
  return typeof value === 'string' && (PIPELINE_NODE_CLASSES as readonly string[]).includes(value)
}

/** Is `value` an executable (P1) node class? */
export function isExecutableNodeClass(value: unknown): value is ExecutableNodeClass {
  return typeof value === 'string' && (EXECUTABLE_NODE_CLASSES as readonly string[]).includes(value)
}

/**
 * A node's class-level output port shape (the coarsest "type" the ADRs
 * settle): `data` nodes produce a relation, `gated` nodes produce a verdict
 * or artifact. There is deliberately no column-level type algebra in P1.
 */
export type PortType = 'data' | 'gated'

/** The class-level output port type of a node (see {@link PortType}). */
export function portTypeOf(node: PipelineNode): PortType {
  switch (node.type) {
    case 'source':
    case 'transform':
    case 'sql':
      return 'data'
    case 'validate':
    case 'diff':
    case 'publish':
      return 'gated'
  }
}

/**
 * Canonical id ordering: ascending code-unit comparison. Deterministic and
 * locale-independent (never `localeCompare`).
 */
export function compareNodeIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Return a copy of `nodes` sorted into canonical id order (stable for equal ids). */
export function canonicalNodeOrder(nodes: readonly PipelineNode[]): PipelineNode[] {
  return [...nodes].sort((a, b) => compareNodeIds(a.id, b.id))
}
