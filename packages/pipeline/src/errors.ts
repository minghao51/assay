// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed errors for the Pipeline IR (p-1).
 *
 * Two total surfaces share one vocabulary:
 *
 * - `parsePipeline` (YAML → AST) never throws; malformed and hostile input
 *   degrades to `PipelineError[]` with a machine-readable `code`, an
 *   actionable `message`, a document `path` (`nodes.sg_customers.inputs[0]`),
 *   and 1-based `line`/`column` pointing at the offending YAML.
 * - `validatePipeline` (DAG invariants on an AST) never throws; it reports
 *   `duplicate-node-id`-class (`single-writer`), `unresolved-reference`,
 *   `cycle`, `port-arity`, and `port-type-shape` failures. Those errors carry
 *   the `path` and `nodeId` but no line/column (the AST is position-free),
 *   which is why `line`/`column` are optional on the shared type.
 *
 * This mirrors the repo's never-throws degradation convention (cf.
 * `@assay/contracts`). Messages are value-free where the value could be
 * sensitive: they name the *location* and the *kind* of problem, never a
 * dataset value (ADR 0025 discipline extends to pipeline diagnostics).
 *
 * p-2 adds two more surfaces to the same vocabulary: the parser gains two
 * format tightenings (`reserved-identifier`, `imprecise-number`) and
 * `compilePipeline` reports its refusals (`unknown-operation`,
 * `invalid-operation-args`, `invalid-filter`, `invalid-cast-type`,
 * `invalid-sql`, `reserved-node-class`, `unsupported-materialization`,
 * `invalid-node`) as the same
 * {@link PipelineError} shape, so every surface renders through
 * {@link describePipelineError} unchanged.
 */
import type { PipelineV1 } from './ast.js'

/** Machine-readable failure classes (one switch-able vocabulary). */
export type PipelineErrorCode =
  /** Not parseable YAML, or a YAML corner the format refuses (unresolved tags, alias cycles). */
  | 'yaml-syntax'
  /** A `version` other than 1 — reported alone instead of guessing other versions' semantics. */
  | 'unsupported-version'
  /** A required key is absent (`version`, `pipeline`, `nodes`, a node's `type`, …). */
  | 'missing-key'
  /** A mapping key that is not valid at its location (unknown or misplaced). */
  | 'unknown-key'
  /** A value has the wrong YAML type for its key (string where a mapping/list was required, …). */
  | 'wrong-type'
  /** A value violates its domain: a non-finite number, an empty name, a NUL-bearing string. */
  | 'out-of-range'
  /** The same mapping key twice in one mapping. */
  | 'duplicate-key'
  /** A `type` value outside the ADR 0030 class list. */
  | 'unknown-node-class'
  /** A reference is not a usable table reference (empty, non-string, NUL-bearing). */
  | 'invalid-reference'
  /** A reference names no declared node. */
  | 'unresolved-reference'
  /** A node's input port count is wrong for its class (e.g. a transform with no inputs). */
  | 'port-arity'
  /** A data input references a node that does not produce a data relation. */
  | 'port-type-shape'
  /** Two nodes claim the same named output (node id). */
  | 'single-writer'
  /** The dependency graph contains a cycle. */
  | 'cycle'
  /** A reference appears twice within one node's port list. */
  | 'duplicate-reference'
  /** p-2: a node id uses the repo-wide reserved `assay_*` namespace (relation naming). */
  | 'reserved-identifier'
  /** p-2: a written number would be silently altered by the YAML→number parse (exact-or-rejected). */
  | 'imprecise-number'
  /** p-2 compile: a transform operation outside the P1 compiled vocabulary (use a sql node). */
  | 'unknown-operation'
  /** p-2 compile: an operation's arguments are missing, mistyped, or have unexpected keys. */
  | 'invalid-operation-args'
  /** p-2 compile: a filter predicate is not a well-formed member of the filter grammar. */
  | 'invalid-filter'
  /** p-2 compile: a cast target spelling is outside the declared-type vocabulary. */
  | 'invalid-cast-type'
  /** p-2 compile: a verbatim sql node is not a single read-only statement (fail-closed classifier). */
  | 'invalid-sql'
  /** p-2 compile: a validate/diff/publish node is reserved until P2 and cannot be compiled. */
  | 'reserved-node-class'
  /** p2-3 compile: a data node declares a materialization mode the local backend cannot map (ADR 0033 fail-explicitly). */
  | 'unsupported-materialization'
  /** p-2 compile: a node's shape is not a compilable executable node (defensive; caller bug). */
  | 'invalid-node'

/**
 * One actionable failure. Plain data — render it however the surface wants
 * (see {@link describePipelineError} for the canonical one-liner).
 */
export interface PipelineError {
  readonly code: PipelineErrorCode
  readonly message: string
  /** Path into the document/AST; `document` is the root, `nodes.x.inputs[0]` a port, … */
  readonly path: string
  /** 1-based line of the offending YAML (parse errors only). */
  readonly line?: number
  /** 1-based column within the line (parse errors only). */
  readonly column?: number
  /** The node this error concerns, when it is a DAG error (DAG errors only). */
  readonly nodeId?: string
}

/** A parse outcome. `ok` discriminates: never a raw throw. */
export type PipelineParseResult =
  | { readonly ok: true; readonly pipeline: PipelineV1 }
  | { readonly ok: false; readonly errors: readonly PipelineError[] }

/** A DAG-validation outcome. `ok` discriminates: never a raw throw. */
export type PipelineValidationResult =
  | {
      readonly ok: true
      readonly pipeline: PipelineV1
      /** A deterministic topological order of node ids (dependencies first). */
      readonly order: readonly string[]
    }
  | { readonly ok: false; readonly errors: readonly PipelineError[] }

/**
 * Canonical one-line rendering, compiler-style and greppable:
 * `nodes.sg_customers.inputs[0]:3:9: reference "…" …`. The structured fields
 * remain the primary surface; this is for humans and logs.
 */
export function describePipelineError(error: PipelineError): string {
  const location =
    error.line !== undefined && error.column !== undefined
      ? `${error.path}:${error.line}:${error.column}`
      : error.path
  return `${location}: ${error.message}`
}
