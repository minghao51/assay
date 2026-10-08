// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// p-4 — `assay pipeline validate|run` report model + renderers
// p2-5 — gate visibility, gate results, materialization, gated/refused runs
//
// The pipeline surfaces render from the SAME p-1/p-2/p-3/p2-4 objects the
// other hosts consume (`PipelineError`, the compile plan, the runner's
// `PipelineRunResult` / `PipelineRunGateResult`), never from re-derived
// semantics. Byte stability is a contract (`--format json`): fixed key order,
// no timestamps, no machine paths (the only paths rendered are the pipeline
// file's OWN authored source/contract references, echoed verbatim as authored
// input — the m5-4 contract-structure rule), `JSON.stringify(…, 2)` + a
// trailing newline.
//
// Sanitization boundary (the p-2/p-3 carry-over): pipeline-derived text —
// node ids, relation names, source/contract paths, and `describePipelineError`
// / `describeContractError` messages (which embed raw YAML excerpts from the
// `yaml` library, control characters included) — is rendered through
// `sanitizePipelineText` in EVERY human report line and stderr line, so an
// authored document cannot inject ANSI/terminal escapes. The JSON envelopes
// need no separate escaping: `JSON.stringify` already escapes control
// characters losslessly, and re-escaping would corrupt the byte pins.
//
// stderr carries authored, fixed messages only: parse errors quote the
// pipeline document's own structure (authored input, line/column), source and
// contract resolution failures echo the pipeline's own authored path
// references. Dataset values never reach stderr (ADR 0025).
//
// p2-5 envelope shape change (versioned by the `report` marker +
// `reportVersion`): the validate envelope gains per-node `materialization`, a
// `gates[]` static-visibility array and `gateErrors[]`; the run envelope gains
// per-node `materialization` + `gate`, and `status` now covers `gated`
// (a first-class result, ADR 0035) and `refused` (a materialization mode this
// surface cannot execute, ADR 0033) alongside `completed`/`failed`/`canceled`,
// plus `gatedAt`/`gate`/`refusal`/`refusalNode`; a gate that executed before a
// later node failure is reported with its real value-free verdict (p2c-1: the
// runner's failure partial now carries executed gates' verdicts).
// The gate result payloads reuse the proven value-free validate/diff shapes
// (verdict + violated-rule count; added/removed/changed counts).
// ---------------------------------------------------------------------------

import {
  describePipelineError,
  isDataNode,
  materializationOf,
  sanitizePipelineText,
} from '@assay/pipeline'
import type {
  PipelineCompileResult,
  PipelineError,
  PipelineErrorCode,
  PipelineNode,
  PipelineValidationResult,
  PipelineV1,
} from '@assay/pipeline'
import type {
  PipelineRunError,
  PipelineRunGateResult,
  PipelineRunPartialNode,
  PipelineRunRefusalReason,
  PipelineRunResult,
} from '@assay/engine-duckdb/node'
import { REPORT_VERSION } from './report-shared.js'
import { plainStyle } from './style.js'
import type { ReportStyle } from './style.js'

/**
 * Escape every C0/C1 control character (U+0000–U+001F, U+007F–U+009F) as a
 * visible lowercase `\uXXXX` escape. Applied to EVERY pipeline-derived string
 * at the human/stderr rendering boundary: `describePipelineError` embeds raw
 * YAML excerpts (the `yaml` library's own messages), and a hostile document
 * must not be able to inject terminal escapes into the CLI's output. Ordinary
 * text (and backslashes) pass through verbatim — the escapes are inert text,
 * so a literal `\u001b` sequence already in the document stays byte-stable.
 *
 * p2-1 (a): the implementation now lives in the shared pure home
 * `@assay/pipeline` (`packages/pipeline/src/sanitize.ts`); it is re-exported
 * here so the CLI's existing call sites and tests keep their import path.
 */
export { sanitizePipelineText }

/**
 * The canonical one-line rendering of a pipeline error, sanitized at this
 * boundary (the p-2 carry-over: the message may embed raw YAML excerpts).
 * This is the ONLY way a `PipelineError` reaches human output or stderr.
 * Accepts the report-row projection too (its `null` absent-fields normalize
 * to the shared type's `undefined` before the canonical renderer runs).
 */
export function describePipelineErrorLine(error: PipelineError | PipelineErrorRow): string {
  const normalized: PipelineError =
    error.line === null || error.column === null
      ? {
          code: error.code,
          message: error.message,
          path: error.path,
          nodeId: error.nodeId ?? undefined,
        }
      : {
          code: error.code,
          message: error.message,
          path: error.path,
          line: error.line,
          column: error.column,
          nodeId: error.nodeId ?? undefined,
        }
  return sanitizePipelineText(describePipelineError(normalized))
}

/** English pluralization helper for the human report (byte-pinned). */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

// ---------------------------------------------------------------------------
// Shared gate vocabulary (p2-5)
// ---------------------------------------------------------------------------

/** The reserved gate node classes (ADR 0035). */
export type PipelineGateKind = 'validate' | 'diff' | 'publish'

/**
 * A validate node's contract reference resolution (C2, static — no
 * execution): `resolved` (readable + parses), `missing` (no readable file),
 * `unparseable` (readable but not a valid contract). `null` on non-validate
 * gates.
 */
export type PipelineContractStatus = 'resolved' | 'missing' | 'unparseable'

/**
 * Static gate-visibility for one gate node — computed WITHOUT executing (the
 * `validate` subcommand's would-this-run-pass-its-gates view). `bound` is the
 * static verdict: a validate node's contract resolved, a diff node's explicit
 * key set is supplied, a publish node's `requires` edges resolve (the DAG
 * already guarantees reference resolution). Never a runtime verdict.
 */
export interface PipelineGateVisibilityRow {
  readonly nodeId: string
  readonly kind: PipelineGateKind
  readonly input: string
  /** `diff` nodes only; `null` otherwise. */
  readonly against: string | null
  /** `validate` nodes only: the authored contract reference. */
  readonly contract: string | null
  /** `validate` nodes only. */
  readonly contractStatus: PipelineContractStatus | null
  /** `publish` nodes only: the authored `requires` edges ([] when absent). */
  readonly requires: readonly string[] | null
  readonly bound: boolean
}

// ---------------------------------------------------------------------------
// validate — the DAG validation + compile plan report (no execution)
// ---------------------------------------------------------------------------

/** One listed node of the (compilable) plan, in topological order. */
export interface PipelineValidateNodeRow {
  readonly nodeId: string
  /** The IR node class (`source`, `transform`, `sql`, or a reserved class). */
  readonly kind: string
  /** The output relation name (the node id — single-writer by DAG rule). */
  readonly relation: string
  /** `source` nodes: the authored `kind`; `null` otherwise (defensively). */
  readonly sourceKind: string | null
  /**
   * `source` nodes: the authored `path` exactly as written in the document,
   * when it is a string; `null` otherwise. Authored input (the m5-4
   * contract-structure rule) — echoed, never resolved or guessed at.
   */
  readonly sourcePath: string | null
  /** `transform` nodes: the operation name; `null` otherwise (defensively). */
  readonly operation: string | null
  /**
   * Data nodes: the effective ADR 0033 materialization mode (absent = `view`)
   * — including a declared-but-unsupported mode, disclosed as authored. Gate
   * nodes: `null`.
   */
  readonly materialization: string | null
}

/** One located pipeline error, projected for report rendering. */
export interface PipelineErrorRow {
  readonly code: PipelineErrorCode
  readonly message: string
  readonly path: string
  readonly line: number | null
  readonly column: number | null
  readonly nodeId: string | null
}

/** The full validate report: the verdict plus the plan/gate listing or errors. */
export interface PipelineValidateReport {
  /** The pipeline's declared name. */
  readonly pipeline: string
  /** Would the run pass its static gates? (DAG + data compile + gate bindings.) */
  readonly valid: boolean
  /** The deterministic topological order ([] when DAG validation failed). */
  readonly order: readonly string[]
  /** The listed plan nodes, in `order` ([] when DAG validation failed). */
  readonly nodes: readonly PipelineValidateNodeRow[]
  /** Static gate visibility for every validate/diff/publish node, in order. */
  readonly gates: readonly PipelineGateVisibilityRow[]
  /** Localized, sanitized gate-binding failures (would-fail disclosures). */
  readonly gateErrors: readonly string[]
  /** The located DAG/compile errors ([] when valid). */
  readonly errors: readonly PipelineErrorRow[]
}

function nodeById(pipeline: PipelineV1, id: string): PipelineNode | undefined {
  return pipeline.nodes.find((node) => node.id === id)
}

/** Project one located error with fixed keys (absent fields are `null`). */
function errorRow(error: PipelineError): PipelineErrorRow {
  return {
    code: error.code,
    message: error.message,
    path: error.path,
    line: error.line ?? null,
    column: error.column ?? null,
    nodeId: error.nodeId ?? null,
  }
}

/** Project one gate-visibility row with fixed keys (absent fields are `null`). */
function gateRow(gate: PipelineGateVisibilityRow): PipelineGateVisibilityRow {
  return {
    nodeId: gate.nodeId,
    kind: gate.kind,
    input: gate.input,
    against: gate.against,
    contract: gate.contract,
    contractStatus: gate.contractStatus,
    requires: gate.requires === null ? null : [...gate.requires],
    bound: gate.bound,
  }
}

/**
 * Assemble the validate report from the DAG-validation, data-subgraph compile,
 * and static gate-visibility outcomes. `compile` is `null` when DAG validation
 * failed (compile was not attempted — it would only re-report the same DAG
 * errors). The plan listing is IR-derived (kinds, relations, authored
 * references, effective materialization), so it stays available even when
 * compilation or gate binding refused. `valid` is the would-this-run view:
 * the DAG validates AND the data subgraph compiles AND every gate binding
 * resolves.
 */
export function buildPipelineValidateReport(input: {
  readonly pipeline: PipelineV1
  readonly validation: PipelineValidationResult
  readonly compile: PipelineCompileResult | null
  readonly gates?: readonly PipelineGateVisibilityRow[]
  readonly gateErrors?: readonly string[]
}): PipelineValidateReport {
  const name = input.pipeline.pipeline
  const gates = (input.gates ?? []).map(gateRow)
  const gateErrors = [...(input.gateErrors ?? [])]
  if (!input.validation.ok) {
    return {
      pipeline: name,
      valid: false,
      order: [],
      nodes: [],
      gates,
      gateErrors,
      errors: input.validation.errors.map(errorRow),
    }
  }
  const order = input.validation.order
  const nodes: PipelineValidateNodeRow[] = []
  for (const id of order) {
    const node = nodeById(input.pipeline, id)
    if (node === undefined) continue
    nodes.push({
      nodeId: node.id,
      kind: node.type,
      relation: node.id,
      sourceKind:
        node.type === 'source' && typeof node.source.kind === 'string' ? node.source.kind : null,
      sourcePath:
        node.type === 'source' && typeof node.source.path === 'string' ? node.source.path : null,
      operation:
        node.type === 'transform' && typeof node.operation.operation === 'string'
          ? node.operation.operation
          : null,
      materialization: isDataNode(node) ? materializationOf(node) : null,
    })
  }
  const compileFailed = input.compile !== null && !input.compile.ok
  const compileOk = input.compile !== null && input.compile.ok
  const gatesBound = gates.every((gate) => gate.bound)
  return {
    pipeline: name,
    valid: compileOk && gatesBound,
    order,
    nodes,
    gates,
    gateErrors,
    errors: compileFailed ? input.compile.errors.map(errorRow) : [],
  }
}

/** The human one-line gate-visibility rendering (sanitized). */
function gateVisibilityLine(gate: PipelineGateVisibilityRow): string {
  const head = `  ${sanitizePipelineText(gate.nodeId)} — ${gate.kind}`
  if (gate.kind === 'validate') {
    const contract =
      gate.contract === null ? 'contract not declared' : sanitizePipelineText(gate.contract)
    const status = gate.contractStatus ?? 'unresolved'
    return `${head} — contract "${contract}" (${status})`
  }
  if (gate.kind === 'diff') {
    const against =
      gate.against === null ? 'against not declared' : sanitizePipelineText(gate.against)
    return `${head} — against "${against}" (keys ${gate.bound ? 'bound' : 'not bound'})`
  }
  const requires = gate.requires ?? []
  const list =
    requires.length === 0 ? '(none)' : requires.map((ref) => sanitizePipelineText(ref)).join(', ')
  return `${head} — requires ${list}`
}

/** The human validate report. Line formats are byte-pinned by integration tests. */
export function renderHumanPipelineValidateReport(
  report: PipelineValidateReport,
  style: ReportStyle = plainStyle,
): string {
  const lines: string[] = []
  lines.push(`pipeline: ${sanitizePipelineText(report.pipeline)}`)
  lines.push(`nodes: ${String(report.nodes.length)}`)
  if (report.nodes.length > 0) {
    lines.push('plan:')
    report.nodes.forEach((node, index) => {
      let line = `  ${String(index + 1)}. ${sanitizePipelineText(node.nodeId)} — ${node.kind} — relation "${sanitizePipelineText(node.relation)}"`
      if (node.materialization !== null) line += ` — ${sanitizePipelineText(node.materialization)}`
      if (node.kind === 'source') {
        const path =
          node.sourcePath === null ? 'path not declared' : sanitizePipelineText(node.sourcePath)
        line += ` (file: ${path})`
      } else if (node.kind === 'transform') {
        const operation =
          node.operation === null ? 'not declared' : sanitizePipelineText(node.operation)
        line += ` (op: ${operation})`
      }
      lines.push(line)
    })
  }
  if (report.gates.length > 0) {
    lines.push('gates:')
    for (const gate of report.gates) lines.push(gateVisibilityLine(gate))
  }
  if (report.gateErrors.length > 0) {
    lines.push(`gate errors: ${style.count(String(report.gateErrors.length))}`)
    for (const error of report.gateErrors) {
      lines.push(`  ${sanitizePipelineText(error)}`)
    }
  }
  if (report.errors.length > 0) {
    lines.push(`errors: ${style.count(String(report.errors.length))}`)
    for (const error of report.errors) {
      lines.push(`  ${describePipelineErrorLine(error)}`)
    }
  }
  lines.push(
    report.valid
      ? `verdict: ${style.pass('VALID')} — the DAG validates and the plan compiles (nothing was executed)`
      : `verdict: ${style.fail('INVALID')} — ${style.count(String(report.errors.length + report.gateErrors.length))} ${plural(report.errors.length + report.gateErrors.length, 'error')}`,
  )
  return lines.join('\n') + '\n'
}

/**
 * The `--format json` validate envelope — byte-stable reference shape
 * (p2-5 extension):
 *
 *     report:         'assay-pipeline-validate-report' (the format marker)
 *     reportVersion:  the CLI package version that produced the report
 *     pipeline:       the pipeline's declared name
 *     nodeCount:      the listed plan nodes' count
 *     valid:          would the run pass its static gates?
 *     order:          the topological order ([] when the DAG failed)
 *     nodes[]:        the listed plan (id, kind, relation, authored source
 *                     reference, operation, effective materialization)
 *     gates[]:        static gate visibility (id, kind, input, against,
 *                     contract, contractStatus, requires, bound)
 *     gateErrors[]:   localized gate-binding failure disclosures
 *     errors[]:       the located DAG/compile errors
 *
 * Fixed key order, 2-space indent, trailing newline, no timestamps.
 */
export function renderJsonPipelineValidateReport(report: PipelineValidateReport): string {
  const payload = {
    report: 'assay-pipeline-validate-report',
    reportVersion: REPORT_VERSION,
    pipeline: report.pipeline,
    nodeCount: report.nodes.length,
    valid: report.valid,
    order: [...report.order],
    nodes: report.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      relation: node.relation,
      sourceKind: node.sourceKind,
      sourcePath: node.sourcePath,
      operation: node.operation,
      materialization: node.materialization,
    })),
    gates: report.gates.map((gate) => ({
      nodeId: gate.nodeId,
      kind: gate.kind,
      input: gate.input,
      against: gate.against,
      contract: gate.contract,
      contractStatus: gate.contractStatus,
      requires: gate.requires === null ? null : [...gate.requires],
      bound: gate.bound,
    })),
    gateErrors: [...report.gateErrors],
    errors: report.errors.map((error) => ({
      code: error.code,
      message: error.message,
      path: error.path,
      line: error.line,
      column: error.column,
      nodeId: error.nodeId,
    })),
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// run — the per-node outcome report (execution happened on this process)
// ---------------------------------------------------------------------------

/**
 * One node's execution outcome, in execution order.
 *
 * `no-verdict` is the honest status of a gate node whose verdict the runner
 * did not carry — the optional `gate` field is absent from the node result
 * (success path) or the failure partial entry. After p2c-1 the runner sets a
 * verdict for every executed gate on both paths, so this is a defensive
 * fallback the real runner does not produce; the report still refuses to claim
 * the gate `passed` (nor `failed`) when the field is missing. It is never a
 * runtime verdict.
 *
 * `passed` is the gate-level meaning of the runner's success rule:
 * **succeeded = completed execution**. A `diff` gate that ran still `passed`
 * when it found differences (its added/removed/changed counts report the
 * finding) — `passed` is never a "datasets matched" claim; only a `validate`
 * gate's `passed` implies `valid`.
 */
export type PipelineRunNodeStatus =
  'materialized' | 'passed' | 'no-verdict' | 'gated' | 'failed' | 'not-run'

/** A gate node's value-free runtime result (never dataset values). */
export interface PipelineRunGateRow {
  readonly class: PipelineGateKind
  readonly input: string
  readonly against: string | null
  readonly valid: boolean | null
  readonly violatedRules: number | null
  readonly added: number | null
  readonly removed: number | null
  readonly changed: number | null
  readonly blockedGates: readonly string[] | null
}

/** One node's execution outcome, in execution order. */
export interface PipelineRunNodeRow {
  readonly nodeId: string
  readonly kind: string
  readonly relation: string
  readonly status: PipelineRunNodeStatus
  /**
   * The materialized relation's row count. Non-null only for nodes that
   * materialized/evaluated on a COMPLETED run (the runner reports counts once,
   * at the end; a failed run's partial relations have no reported counts).
   */
  readonly rowCount: number | null
  /**
   * How the node materialized: `source`, the effective ADR 0033 data mode, or
   * `gate` for a validate/diff/publish verdict. `null` for a node that never
   * ran.
   */
  readonly materialization: string | null
  /** A gate node's value-free verdict; `null` for data nodes / unexecuted. */
  readonly gate: PipelineRunGateRow | null
}

/** One terminal (output) relation: addressable for inspection/export hosts. */
export interface PipelineRunOutputRow {
  readonly nodeId: string
  readonly relation: string
  readonly rowCount: number
}

/** The run verdict: `gated` and `refused` are first-class results (p2-5). */
export type PipelineRunReportStatus = 'completed' | 'gated' | 'failed' | 'canceled' | 'refused'

/**
 * A plan-level refusal (p2-5): the compiled plan uses a materialization mode
 * this surface cannot execute (`unsupported-materialization` — e.g. `export`,
 * which the Node surface has no OPFS artifact path for;
 * `export-with-consumers` — an export consumed by another node). Value-free:
 * the fixed reason discriminant plus the node it concerns.
 */
export interface PipelineRunRefusal {
  readonly reason: PipelineRunRefusalReason
  readonly nodeId: string | null
}

/** The full run report: per-node outcomes, the outputs, and the verdict. */
export interface PipelineRunReport {
  readonly pipeline: string
  readonly status: PipelineRunReportStatus
  /** The topological execution order (the plan's order). */
  readonly order: readonly string[]
  readonly nodes: readonly PipelineRunNodeRow[]
  /** Terminal relations (completed runs only; [] otherwise). */
  readonly outputs: readonly PipelineRunOutputRow[]
  /** The node that failed (`failed` runs only). */
  readonly failingNode: string | null
  /**
   * The node a cancellation stopped before (`canceled` runs only). A one-shot
   * CLI run cannot be canceled (no abort surface) — the field is kept so the
   * envelope shape covers every runner outcome honestly.
   */
  readonly nextNodeId: string | null
  /** The gate a `gated` run stopped at; `null` otherwise. */
  readonly gatedAt: string | null
  /** Which gate class stopped a `gated` run; `null` otherwise. */
  readonly gate: 'validation-failed' | 'publish-blocked' | null
  /** Why a `refused` run never started; `null` otherwise. */
  readonly refusal: PipelineRunRefusalReason | null
  /** The node a `refused` run concerns; `null` otherwise. */
  readonly refusalNode: string | null
}

/**
 * The pipeline's terminal data nodes: plan data nodes whose relation no OTHER
 * DATA node consumes — the pipeline's outputs. Gate nodes (validate/diff/
 * publish) read their inputs but materialize no new relation, so a data node
 * consumed only by a gate stays an addressable output. Computed from the IR's
 * transform/sql inputs; gate nodes themselves are never outputs.
 */
export function pipelineOutputNodeIds(
  pipeline: PipelineV1,
  order: readonly string[],
): readonly string[] {
  const referenced = new Set<string>()
  for (const node of pipeline.nodes) {
    if (node.type === 'transform' || node.type === 'sql') {
      for (const input of node.inputs) referenced.add(input)
    }
  }
  const dataIds = new Set(pipeline.nodes.filter(isDataNode).map((node) => node.id))
  return order.filter((id) => dataIds.has(id) && !referenced.has(id))
}

/** Project the runner's gate verdict into the fixed report-row keys. */
function projectRunGate(gate: PipelineRunGateResult): PipelineRunGateRow {
  if (gate.class === 'validate') {
    return {
      class: 'validate',
      input: gate.input,
      against: null,
      valid: gate.valid,
      violatedRules: gate.violatedRules,
      added: null,
      removed: null,
      changed: null,
      blockedGates: null,
    }
  }
  if (gate.class === 'diff') {
    return {
      class: 'diff',
      input: gate.input,
      against: gate.against,
      valid: null,
      violatedRules: null,
      added: gate.added,
      removed: gate.removed,
      changed: gate.changed,
      blockedGates: null,
    }
  }
  return {
    class: 'publish',
    input: gate.input,
    against: null,
    valid: null,
    violatedRules: null,
    added: null,
    removed: null,
    changed: null,
    blockedGates: [...gate.blockedGates],
  }
}

/** True when an executed gate's verdict is "not the run-stopping failure". */
function gatePassed(gate: PipelineRunGateResult): boolean {
  if (gate.class === 'validate') return gate.valid
  if (gate.class === 'publish') return gate.blockedGates.length === 0
  return true
}

/**
 * Assemble the run report from the plan order, the IR (kinds + output
 * computation + effective materialization), and the runner outcome. Exactly
 * one of `result`/`error`/`refusal` is non-null: `result` for
 * `completed`/`gated`/`canceled`, `error` for a thrown `PipelineRunError`
 * (status `failed`), `refusal` for a pre-execution mode refusal
 * (status `refused`).
 */
export function buildPipelineRunReport(input: {
  readonly pipeline: PipelineV1
  readonly order: readonly string[]
  readonly result: PipelineRunResult | null
  readonly error: PipelineRunError | null
  readonly refusal?: PipelineRunRefusal | null
}): PipelineRunReport {
  const name = input.pipeline.pipeline
  const nodeOf = (id: string): PipelineNode | undefined => nodeById(input.pipeline, id)
  const kindOf = (id: string): string => nodeOf(id)?.type ?? 'unknown'
  const isGateId = (id: string): boolean => {
    const type = nodeOf(id)?.type
    return type === 'validate' || type === 'diff' || type === 'publish'
  }
  const effectiveMode = (id: string): string | null => {
    const node = nodeOf(id)
    if (node === undefined) return null
    return isDataNode(node) ? materializationOf(node) : 'gate'
  }

  if (input.refusal !== undefined && input.refusal !== null) {
    return {
      pipeline: name,
      status: 'refused',
      order: [],
      nodes: [],
      outputs: [],
      failingNode: null,
      nextNodeId: null,
      gatedAt: null,
      gate: null,
      refusal: input.refusal.reason,
      refusalNode: input.refusal.nodeId,
    }
  }

  const rowCountOf = (id: string): number | null => {
    if (input.result === null || input.result.status !== 'completed') return null
    return input.result.nodes.find((node) => node.nodeId === id)?.rowCount ?? null
  }

  if (input.error !== null) {
    // p2c-1: `PipelineRunError.partial` now carries each executed gate's
    // value-free verdict, so a gate that ran before the failure is rendered
    // with its real verdict — never a blanket `no-verdict`. `no-verdict`
    // remains only for the defensive case where the partial entry omits the
    // optional `gate` field (the real runner always sets it for an executed
    // gate). The failing node is not in `partial`, so it is never given a
    // fabricated verdict.
    const statusOfPartial = (entry: PipelineRunPartialNode): PipelineRunNodeStatus => {
      if (!isGateId(entry.nodeId)) return 'materialized'
      if (entry.gate === undefined) return 'no-verdict'
      return gatePassed(entry.gate) ? 'passed' : 'failed'
    }
    const nodes: PipelineRunNodeRow[] = input.error.partial.map((entry) => ({
      nodeId: entry.nodeId,
      kind: kindOf(entry.nodeId),
      relation: entry.relation,
      status: statusOfPartial(entry),
      rowCount: null,
      materialization: effectiveMode(entry.nodeId),
      gate: entry.gate === undefined ? null : projectRunGate(entry.gate),
    }))
    const done = new Set(input.error.partial.map((entry) => entry.nodeId))
    for (const id of input.order) {
      if (done.has(id)) continue
      nodes.push({
        nodeId: id,
        kind: kindOf(id),
        relation: id,
        status: id === input.error.nodeId ? 'failed' : 'not-run',
        rowCount: null,
        materialization: id === input.error.nodeId ? effectiveMode(id) : null,
        gate: null,
      })
    }
    return {
      pipeline: name,
      status: 'failed',
      order: [...input.order],
      nodes,
      outputs: [],
      failingNode: input.error.nodeId,
      nextNodeId: null,
      gatedAt: null,
      gate: null,
      refusal: null,
      refusalNode: null,
    }
  }

  const result = input.result
  if (result === null) {
    // Defensive: the caller must pass one outcome. An empty canceled-shape
    // report is the honest zero state — never a throw at a render boundary.
    return {
      pipeline: name,
      status: 'canceled',
      order: [...input.order],
      nodes: [],
      outputs: [],
      failingNode: null,
      nextNodeId: null,
      gatedAt: null,
      gate: null,
      refusal: null,
      refusalNode: null,
    }
  }

  const runById = new Map(result.nodes.map((node) => [node.nodeId, node]))
  const gatedAt = result.status === 'gated' ? result.gatedAt : null
  const nodes: PipelineRunNodeRow[] = input.order.map((id) => {
    const runNode = runById.get(id)
    if (runNode !== undefined) {
      const gate = runNode.gate === undefined ? null : projectRunGate(runNode.gate)
      let status: PipelineRunNodeStatus
      if (isGateId(id)) {
        // Symmetric with the error branch above: a gate the runner reported
        // WITHOUT a verdict (no `gate` field) is `no-verdict`, never a
        // fabricated `passed`. Unreachable while the runner always sets gate
        // results, but the fallthrough must not overclaim.
        status =
          id === gatedAt
            ? 'gated'
            : runNode.gate === undefined
              ? 'no-verdict'
              : !gatePassed(runNode.gate)
                ? 'failed'
                : 'passed'
      } else {
        status = 'materialized'
      }
      return {
        nodeId: id,
        kind: kindOf(id),
        relation: runNode.relation,
        status,
        rowCount: runNode.rowCount,
        materialization: runNode.materialization,
        gate,
      }
    }
    return {
      nodeId: id,
      kind: kindOf(id),
      relation: id,
      status: 'not-run',
      rowCount: null,
      materialization: null,
      gate: null,
    }
  })

  const status: PipelineRunReportStatus =
    result.status === 'completed' ? 'completed' : result.status === 'gated' ? 'gated' : 'canceled'

  const outputs =
    result.status === 'completed'
      ? pipelineOutputNodeIds(input.pipeline, input.order).flatMap((id) => {
          const rowCount = rowCountOf(id)
          return rowCount === null ? [] : [{ nodeId: id, relation: id, rowCount }]
        })
      : []

  return {
    pipeline: name,
    status,
    order: [...input.order],
    nodes,
    outputs,
    failingNode: null,
    nextNodeId: result.status === 'canceled' ? result.nextNodeId : null,
    gatedAt,
    gate: result.status === 'gated' ? result.gate : null,
    refusal: null,
    refusalNode: null,
  }
}

/** The value-free human description of a mode refusal. */
function describeRefusal(reason: PipelineRunRefusalReason): string {
  switch (reason) {
    case 'unsupported-materialization':
      return 'the pipeline declares a materialization mode this surface cannot execute (export/publish)'
    case 'export-with-consumers':
      return 'an export node is consumed by another node, but an export materializes no relation'
    default:
      return 'a plan precondition this surface cannot satisfy'
  }
}

/** The human one-line gate-result rendering (sanitized, value-free). */
function gateResultSuffix(node: PipelineRunNodeRow, style: ReportStyle): string {
  const gate = node.gate
  if (gate === null) return ''
  if (gate.class === 'validate') {
    if (gate.valid === true) return ''
    if (gate.valid === false) {
      return ` — ${style.fail(String(gate.violatedRules ?? 0))} ${plural(gate.violatedRules ?? 0, 'rule')} violated`
    }
    return ''
  }
  if (gate.class === 'diff') {
    return ` — added ${style.count(String(gate.added ?? 0))}, removed ${style.count(String(gate.removed ?? 0))}, changed ${style.count(String(gate.changed ?? 0))}`
  }
  if ((gate.blockedGates ?? []).length > 0) {
    return ` — blocked by ${(gate.blockedGates ?? []).map((ref) => sanitizePipelineText(ref)).join(', ')}`
  }
  return ''
}

/** One per-node human line (the `run:` block). */
function runNodeLine(node: PipelineRunNodeRow, index: number, style: ReportStyle): string {
  const head = `${String(index + 1)}. ${sanitizePipelineText(node.nodeId)} — ${node.kind}`
  if (node.status === 'not-run') return `  ${head} — not run`
  if (node.status === 'failed') {
    return `  ${head} — ${style.fail('FAILED')}${gateResultSuffix(node, style)}`
  }
  if (node.status === 'gated') {
    return `  ${head} — ${style.fail('GATED')}${gateResultSuffix(node, style)}`
  }
  if (node.status === 'passed') {
    return `  ${head} — passed${gateResultSuffix(node, style)}`
  }
  if (node.status === 'no-verdict') {
    // A gate whose verdict the runner did not carry (the optional `gate` field
    // is absent — defensive after p2c-1): neutral, never a fabricated pass/fail.
    return `  ${head} — ran (no verdict recorded)`
  }
  if (node.rowCount !== null) {
    return `  ${head} — materialized — ${style.count(String(node.rowCount))} ${plural(node.rowCount, 'row')}`
  }
  return `  ${head} — materialized`
}

/** The human run report. Line formats are byte-pinned by integration tests. */
export function renderHumanPipelineRunReport(
  report: PipelineRunReport,
  style: ReportStyle = plainStyle,
): string {
  const lines: string[] = []
  lines.push(`pipeline: ${sanitizePipelineText(report.pipeline)}`)
  lines.push(`nodes: ${String(report.nodes.length)}`)
  if (report.nodes.length > 0) {
    lines.push('run:')
    report.nodes.forEach((node, index) => lines.push(runNodeLine(node, index, style)))
  }
  if (report.status === 'completed') {
    lines.push('outputs (addressable relations):')
    for (const output of report.outputs) {
      lines.push(
        `  ${sanitizePipelineText(output.relation)} — ${style.count(String(output.rowCount))} ${plural(output.rowCount, 'row')}`,
      )
    }
    lines.push(
      "note: relations live in this run's in-memory session and end when the process exits",
    )
    lines.push(
      `verdict: ${style.pass('COMPLETED')} — ${style.count(String(report.nodes.length))} of ${String(report.nodes.length)} nodes materialized`,
    )
  } else if (report.status === 'gated') {
    lines.push(
      "note: the run stopped at the gate; later nodes were not run; relations already materialized live in this run's in-memory session, which end when the process exits",
    )
    lines.push(
      `verdict: ${style.fail('GATED')} — the run stopped at ${report.gate ?? 'gate'} gate "${sanitizePipelineText(report.gatedAt ?? '')}"`,
    )
  } else if (report.status === 'refused') {
    const node =
      report.refusalNode === null ? '' : `node "${sanitizePipelineText(report.refusalNode)}": `
    lines.push(
      `verdict: ${style.fail('REFUSED')} — ${node}${describeRefusal(report.refusal ?? 'unsupported-materialization')}; nothing was executed`,
    )
  } else if (report.status === 'failed') {
    lines.push(
      "note: the failing node left no relation; earlier nodes left named relations in this run's in-memory session, which end when the process exits",
    )
    lines.push(
      `verdict: ${style.fail('FAILED')} — node "${sanitizePipelineText(report.failingNode ?? '')}" could not be materialized`,
    )
  } else {
    const next =
      report.nextNodeId === null ? '' : ` at node "${sanitizePipelineText(report.nextNodeId)}"`
    lines.push(
      `verdict: ${style.warn('CANCELED')} — the run was abandoned before completion${next}`,
    )
  }
  return lines.join('\n') + '\n'
}

/**
 * The `--format json` run envelope — byte-stable reference shape (p2-5
 * extension):
 *
 *     report:          'assay-pipeline-run-report' (the format marker)
 *     reportVersion:   the CLI package version that produced the report
 *     pipeline:        the pipeline's declared name
 *     sessionLifetime: 'process' — relations are materialized in this run's
 *                      own in-memory session and end when the process exits
 *     nodeCount:       the executed plan's node count
 *     status:          'completed' | 'gated' | 'failed' | 'canceled' | 'refused'
 *     order:           the topological execution order
 *     nodes[]:         per-node outcomes in execution order (id, kind,
 *                      relation, status, rowCount, materialization, gate —
 *                      gate carries the value-free validate/diff/publish
 *                      verdict, never dataset values). `status` here is the
 *                      NODE status: 'materialized' | 'passed' | 'no-verdict'
 *                      | 'gated' | 'failed' | 'not-run'. `no-verdict` marks a
 *                      gate result the runner did not carry (the optional
 *                      `gate` field is absent — defensive after p2c-1; the
 *                      runner sets a verdict for every executed gate).
 *     outputs[]:       the terminal relations with their row counts
 *                      (completed runs only)
 *     failingNode:     the failed node ('failed' runs only, else null)
 *     nextNodeId:      the node a cancellation stopped before (null — a
 *                      one-shot CLI run cannot be canceled; the field keeps
 *                      the envelope honest across every runner outcome)
 *     gatedAt:         the gate a gated run stopped at (else null)
 *     gate:            which gate class stopped it (else null)
 *     refusal:         why a refused run never started (else null)
 *     refusalNode:     the node a refusal concerns (else null)
 *
 * Fixed key order, 2-space indent, trailing newline, no timestamps.
 */
export function renderJsonPipelineRunReport(report: PipelineRunReport): string {
  const payload = {
    report: 'assay-pipeline-run-report',
    reportVersion: REPORT_VERSION,
    pipeline: report.pipeline,
    sessionLifetime: 'process',
    nodeCount: report.nodes.length,
    status: report.status,
    order: [...report.order],
    nodes: report.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      relation: node.relation,
      status: node.status,
      rowCount: node.rowCount,
      materialization: node.materialization,
      gate:
        node.gate === null
          ? null
          : {
              class: node.gate.class,
              input: node.gate.input,
              against: node.gate.against,
              valid: node.gate.valid,
              violatedRules: node.gate.violatedRules,
              added: node.gate.added,
              removed: node.gate.removed,
              changed: node.gate.changed,
              blockedGates: node.gate.blockedGates === null ? null : [...node.gate.blockedGates],
            },
    })),
    outputs: report.outputs.map((output) => ({
      nodeId: output.nodeId,
      relation: output.relation,
      rowCount: output.rowCount,
    })),
    failingNode: report.failingNode,
    nextNodeId: report.nextNodeId,
    gatedAt: report.gatedAt,
    gate: report.gate,
    refusal: report.refusal,
    refusalNode: report.refusalNode,
  }
  return JSON.stringify(payload, null, 2) + '\n'
}
