// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// p-4 — `assay pipeline validate|run` report model + renderers
//
// The pipeline surfaces render from the SAME p-1/p-2/p-3 objects the other
// hosts consume (`PipelineError`, `PipelineCompilePlan`, the runner's
// `PipelineRunResult`), never from re-derived semantics. Byte stability is a
// contract (`--format json`): fixed key order, no timestamps, no absolute
// paths (the only paths rendered are the pipeline file's OWN authored source
// references, echoed verbatim as authored input — the m5-4 contract-structure
// rule), `JSON.stringify(…, 2)` + a trailing newline.
//
// Sanitization boundary (the p-2/p-3 carry-over): pipeline-derived text —
// node ids, relation names, source paths, and `describePipelineError`
// messages (which embed raw YAML excerpts from the `yaml` library, control
// characters included) — is rendered through `sanitizePipelineText` in EVERY
// human report line and stderr line, so an authored document cannot inject
// ANSI/terminal escapes. The JSON envelopes need no separate escaping:
// `JSON.stringify` already escapes control characters losslessly, and
// re-escaping would corrupt the byte pins.
//
// stderr carries authored, fixed messages only: parse errors quote the
// pipeline document's own structure (authored input, line/column), source
// resolution failures echo the pipeline's own authored path references.
// Dataset values never reach stderr (ADR 0025).
// ---------------------------------------------------------------------------

import { describePipelineError } from '@assay/pipeline'
import type {
  PipelineCompileResult,
  PipelineError,
  PipelineErrorCode,
  PipelineNode,
  PipelineValidationResult,
  PipelineV1,
} from '@assay/pipeline'
import type { PipelineRunError, PipelineRunResult } from '@assay/engine-duckdb/node'
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
 */
export function sanitizePipelineText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += char
    }
  }
  return out
}

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

/** The full validate report: the verdict plus the plan listing or the errors. */
export interface PipelineValidateReport {
  /** The pipeline's declared name. */
  readonly pipeline: string
  readonly valid: boolean
  /** The deterministic topological order ([] when DAG validation failed). */
  readonly order: readonly string[]
  /** The listed plan nodes, in `order` ([] when DAG validation failed). */
  readonly nodes: readonly PipelineValidateNodeRow[]
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

/**
 * Assemble the validate report from the DAG-validation and compile outcomes.
 * `compile` is `null` when DAG validation failed (compile was not attempted —
 * it would only re-report the same DAG errors). The plan listing is
 * IR-derived: it renders the pipeline's own nodes (kinds, relations, authored
 * source references), so it stays available even when compilation refused.
 */
export function buildPipelineValidateReport(input: {
  readonly pipeline: PipelineV1
  readonly validation: PipelineValidationResult
  readonly compile: PipelineCompileResult | null
}): PipelineValidateReport {
  const name = input.pipeline.pipeline
  if (!input.validation.ok) {
    return {
      pipeline: name,
      valid: false,
      order: [],
      nodes: [],
      errors: input.validation.errors.map(errorRow),
    }
  }
  const order =
    input.compile !== null && input.compile.ok ? input.compile.plan.order : input.validation.order
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
    })
  }
  const compileFailed = input.compile !== null && !input.compile.ok
  return {
    pipeline: name,
    valid: !compileFailed,
    order,
    nodes,
    errors: compileFailed ? input.compile.errors.map(errorRow) : [],
  }
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
  if (report.errors.length > 0) {
    lines.push(`errors: ${style.count(String(report.errors.length))}`)
    for (const error of report.errors) {
      lines.push(`  ${describePipelineErrorLine(error)}`)
    }
  }
  lines.push(
    report.valid
      ? `verdict: ${style.pass('VALID')} — the DAG validates and the plan compiles (nothing was executed)`
      : `verdict: ${style.fail('INVALID')} — ${style.count(String(report.errors.length))} ${plural(report.errors.length, 'error')}`,
  )
  return lines.join('\n') + '\n'
}

/**
 * The `--format json` validate envelope — byte-stable reference shape:
 *
 *     report:         'assay-pipeline-validate-report' (the format marker)
 *     reportVersion:  the CLI package version that produced the report
 *     pipeline:       the pipeline's declared name
 *     nodeCount:      the listed plan nodes' count
 *     valid:          the verdict (DAG validates AND plan compiles)
 *     order:          the topological order ([] when the DAG failed)
 *     nodes[]:        the listed plan (id, kind, relation, authored source
 *                     reference, operation) in `order`
 *     errors[]:       the located DAG/compile errors (code, message, path,
 *                     line, column, nodeId — null where not applicable)
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
    })),
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

/** One node's execution outcome, in execution order. */
export interface PipelineRunNodeRow {
  readonly nodeId: string
  readonly kind: string
  readonly relation: string
  /** `materialized`, `failed` (the run-stopping failure), or `not-run`. */
  readonly status: 'materialized' | 'failed' | 'not-run'
  /**
   * The materialized relation's row count. Non-null only for nodes that
   * materialized on a COMPLETED run (the runner reports counts once, at the
   * end; a failed run's partial relations have no reported counts).
   */
  readonly rowCount: number | null
}

/** One terminal (output) relation: addressable for inspection/export hosts. */
export interface PipelineRunOutputRow {
  readonly nodeId: string
  readonly relation: string
  readonly rowCount: number
}

/** The full run report: per-node outcomes, the outputs, and the verdict. */
export interface PipelineRunReport {
  readonly pipeline: string
  readonly status: 'completed' | 'failed' | 'canceled'
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
}

/**
 * The pipeline's terminal data nodes: plan nodes whose relation no other node
 * consumes — the pipeline's outputs. Computed from the IR's references (the
 * compiled plan does not carry inputs), so gate references count too.
 */
export function pipelineOutputNodeIds(
  pipeline: PipelineV1,
  order: readonly string[],
): readonly string[] {
  const referenced = new Set<string>()
  for (const node of pipeline.nodes) {
    if (node.type === 'transform' || node.type === 'sql') {
      for (const input of node.inputs) referenced.add(input)
    } else if (node.type === 'validate') {
      referenced.add(node.input)
    } else if (node.type === 'publish') {
      referenced.add(node.input)
      for (const gate of node.requires ?? []) referenced.add(gate)
    }
  }
  return order.filter((id) => !referenced.has(id))
}

/**
 * Assemble the run report from the plan order, the IR (kinds + output
 * computation), and the runner outcome. Exactly one of `result`/`error` is
 * non-null: `result` for `completed`/`canceled`, `error` for a thrown
 * `PipelineRunError` (status `failed`).
 */
export function buildPipelineRunReport(input: {
  readonly pipeline: PipelineV1
  readonly order: readonly string[]
  readonly result: PipelineRunResult | null
  readonly error: PipelineRunError | null
}): PipelineRunReport {
  const name = input.pipeline.pipeline
  const kindOf = (id: string): string => nodeById(input.pipeline, id)?.type ?? 'unknown'
  const rowCountOf = (id: string): number | null => {
    if (input.result === null || input.result.status !== 'completed') return null
    return input.result.nodes.find((node) => node.nodeId === id)?.rowCount ?? null
  }

  if (input.error !== null) {
    const nodes: PipelineRunNodeRow[] = input.error.partial.map((entry) => ({
      nodeId: entry.nodeId,
      kind: kindOf(entry.nodeId),
      relation: entry.relation,
      status: 'materialized',
      rowCount: null,
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
    }
  }

  const doneIds = new Set(result.nodes.map((node) => node.nodeId))
  const nodes: PipelineRunNodeRow[] = input.order.map((id) => ({
    nodeId: id,
    kind: kindOf(id),
    relation: id,
    status: doneIds.has(id) ? 'materialized' : 'not-run',
    rowCount: doneIds.has(id) ? rowCountOf(id) : null,
  }))
  if (result.status === 'completed') {
    const outputs = pipelineOutputNodeIds(input.pipeline, input.order).flatMap((id) => {
      const rowCount = rowCountOf(id)
      return rowCount === null ? [] : [{ nodeId: id, relation: id, rowCount }]
    })
    return {
      pipeline: name,
      status: 'completed',
      order: [...input.order],
      nodes,
      outputs,
      failingNode: null,
      nextNodeId: null,
    }
  }
  return {
    pipeline: name,
    status: 'canceled',
    order: [...input.order],
    nodes,
    outputs: [],
    failingNode: null,
    nextNodeId: result.nextNodeId,
  }
}

/** One per-node human line (the `run:` block). */
function runNodeLine(node: PipelineRunNodeRow, index: number, style: ReportStyle): string {
  const head = `${String(index + 1)}. ${sanitizePipelineText(node.nodeId)} — ${node.kind}`
  if (node.status === 'materialized' && node.rowCount !== null) {
    return `  ${head} — materialized — ${style.count(String(node.rowCount))} ${plural(node.rowCount, 'row')}`
  }
  if (node.status === 'materialized') {
    return `  ${head} — materialized`
  }
  if (node.status === 'failed') {
    return `  ${head} — ${style.fail('FAILED')}`
  }
  return `  ${head} — not run`
}

/** The human run report. Line formats are byte-pinned by integration tests. */
export function renderHumanPipelineRunReport(
  report: PipelineRunReport,
  style: ReportStyle = plainStyle,
): string {
  const lines: string[] = []
  lines.push(`pipeline: ${sanitizePipelineText(report.pipeline)}`)
  lines.push(`nodes: ${String(report.nodes.length)}`)
  lines.push('run:')
  report.nodes.forEach((node, index) => lines.push(runNodeLine(node, index, style)))
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
 * The `--format json` run envelope — byte-stable reference shape:
 *
 *     report:          'assay-pipeline-run-report' (the format marker)
 *     reportVersion:   the CLI package version that produced the report
 *     pipeline:        the pipeline's declared name
 *     sessionLifetime: 'process' — relations are materialized in this run's
 *                      own in-memory session and end when the process exits
 *     nodeCount:       the executed plan's node count
 *     status:          'completed' | 'failed' | 'canceled'
 *     order:           the topological execution order
 *     nodes[]:         per-node outcomes in execution order (id, kind,
 *                      relation, status, rowCount — null unless materialized
 *                      on a completed run)
 *     outputs[]:       the terminal relations with their row counts
 *                      (completed runs only)
 *     failingNode:     the failed node ('failed' runs only, else null)
 *     nextNodeId:      the node a cancellation stopped before (null — a
 *                      one-shot CLI run cannot be canceled; the field keeps
 *                      the envelope honest across every runner outcome)
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
    })),
    outputs: report.outputs.map((output) => ({
      nodeId: output.nodeId,
      relation: output.relation,
      rowCount: output.rowCount,
    })),
    failingNode: report.failingNode,
    nextNodeId: report.nextNodeId,
  }
  return JSON.stringify(payload, null, 2) + '\n'
}
