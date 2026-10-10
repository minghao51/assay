// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The p3-3 `assay dcr` export report model + renderers.
 *
 * The report says what the export DID — which run produced the artifact,
 * which sides were derived, what the artifact carries, and (honestly) what it
 * does NOT carry. It never re-renders the artifact itself (the artifact's
 * canonical YAML is the product; the report is the envelope around writing
 * it), and it never fabricates a verdict: a run whose gates carried no
 * validate verdicts says `validation: none carried` — the p2-5 `no-verdict`
 * honesty, one level up.
 *
 * Byte stability is a contract (`--format json`): fixed key order, no
 * timestamps, `JSON.stringify(…, 2)` + trailing newline (the m5-4
 * discipline). Paths stay out of stdout except through the output file's
 * BASENAME (the report-shared rule); every pipeline-derived string is
 * sanitized at this boundary; dataset values never appear (the artifact
 * itself is value-free by construction — the builder's ADR 0025 pins).
 */
import { REPORT_VERSION } from './report-shared.js'
import { sanitizePipelineText } from './report-pipeline.js'
import { plainStyle } from './style.js'
import type { ReportStyle } from './style.js'

/** The producing run's outcome, as the export report states it. */
export type DcrRunStatusSummary = 'completed' | 'gated' | 'failed' | 'canceled' | 'refused'

/** One side of the comparison, as the report summarizes it. */
export interface DcrSideSummary {
  readonly datasetId: string
  readonly versionId: string
  /** The run node whose materialized output the version is. */
  readonly node: string
}

/**
 * Why nothing was written — the result-class refusals (exit 1, the report on
 * stdout IS the result). Usage-class failures (bad flags, an existing output
 * path) never reach this shape: they are authored stderr (`CliError`, exit 2)
 * per the CLI's error taxonomy.
 */
export type DcrNoArtifactReason =
  /**
   * D19-OQ-5: a materialization reference did not resolve in the run session
   * at export time (the relation was dropped, or the introspection the
   * derivation needs failed) — refuse loudly, never a partial artifact.
   */
  | 'dangling-materialization'
  /** The run was canceled before the named sides materialized. */
  | 'run-canceled'
  /** A node failed mid-run — the named partial state is no export basis. */
  | 'run-failed'
  /** The run was refused before execution (a mode this surface cannot run). */
  | 'run-refused'

/** Why nothing was written, with the node it concerns (when attributed). */
export interface DcrExportRefusal {
  readonly reason: DcrNoArtifactReason
  readonly nodeId: string | null
}

/** The full export report: the run, the sides, the carried counts, the file. */
export interface DcrExportReport {
  readonly pipeline: string
  readonly runStatus: DcrRunStatusSummary
  /** The gate a `gated` run stopped at; `null` otherwise. */
  readonly gatedAt: string | null
  /** Which gate class stopped a `gated` run; `null` otherwise. */
  readonly gate: 'validation-failed' | 'publish-blocked' | null
  /** Why no artifact was written; `null` when one was. */
  readonly refusal: DcrExportRefusal | null
  readonly base: DcrSideSummary | null
  readonly candidate: DcrSideSummary | null
  /** Schema-drift findings carried into `deltas.schemaDrift`; `null` when no artifact. */
  readonly schemaDriftFindings: number | null
  /** Validate verdicts carried into `validation`; `null` when no artifact. */
  readonly validationVerdicts: number | null
  /**
   * The honest roll-up of the carried verdicts: `true`/`false` when at least
   * one validate verdict exists, `null` when none carried — never a
   * fabricated default.
   */
  readonly validationValid: boolean | null
  /** The written file: BASENAME only (paths stay out of stdout), and its size. */
  readonly artifact: { readonly file: string; readonly bytes: number } | null
}

/** Human plural (the report-pipeline helper's local twin). */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

/** The human report. Line formats are part of the byte-pinned integration contract. */
export function renderHumanDcrExportReport(
  report: DcrExportReport,
  style: ReportStyle = plainStyle,
): string {
  const lines: string[] = []
  lines.push(`pipeline: ${sanitizePipelineText(report.pipeline)}`)
  if (report.runStatus === 'gated') {
    lines.push(
      `run: gated — stopped at ${report.gate ?? 'gate'} gate "${sanitizePipelineText(report.gatedAt ?? '')}"`,
    )
  } else if (report.runStatus === 'completed') {
    lines.push('run: completed')
  } else if (report.runStatus === 'failed') {
    lines.push('run: failed — a node could not be materialized')
  } else if (report.runStatus === 'canceled') {
    lines.push('run: canceled — abandoned before completion')
  } else {
    lines.push('run: refused — nothing was executed')
  }
  if (report.base !== null && report.candidate !== null) {
    lines.push(
      `base: ${sanitizePipelineText(report.base.datasetId)} (${sanitizePipelineText(report.base.versionId)}) — node "${sanitizePipelineText(report.base.node)}"`,
    )
    lines.push(
      `candidate: ${sanitizePipelineText(report.candidate.datasetId)} (${sanitizePipelineText(report.candidate.versionId)}) — node "${sanitizePipelineText(report.candidate.node)}"`,
    )
  }
  if (report.artifact !== null) {
    lines.push(
      `schema drift: ${String(report.schemaDriftFindings ?? 0)} ${plural(report.schemaDriftFindings ?? 0, 'finding')} carried`,
    )
    if (report.validationVerdicts === 0 || report.validationVerdicts === null) {
      // Honest absence: no validate verdicts existed to carry — said, never papered over.
      lines.push('validation: none carried — the run executed no validate gates')
    } else {
      const verdict = report.validationValid === true ? style.pass('valid') : style.fail('invalid')
      lines.push(
        `validation: ${String(report.validationVerdicts)} ${plural(report.validationVerdicts, 'verdict')} carried — ${verdict}`,
      )
    }
    lines.push(
      `artifact: ${sanitizePipelineText(report.artifact.file)} — ${String(report.artifact.bytes)} bytes — new file (never overwritten)`,
    )
  }
  if (report.refusal !== null) {
    const node =
      report.refusal.nodeId === null
        ? ''
        : ` for node "${sanitizePipelineText(report.refusal.nodeId)}"`
    const why =
      report.refusal.reason === 'dangling-materialization'
        ? `the materialization reference${node} no longer resolves in the run session; nothing was written (dangling-materialization)`
        : report.refusal.reason === 'run-canceled'
          ? 'the run was canceled; nothing was written'
          : report.refusal.reason === 'run-failed'
            ? 'the run failed; nothing was written'
            : 'the run was refused before execution; nothing was written'
    lines.push(`verdict: ${style.fail('REFUSED')} — ${why}`)
  } else if (report.runStatus === 'gated') {
    lines.push(
      `verdict: ${style.warn('GATED')} — the artifact is written; the run stopped at the gate, and the artifact carries exactly the evidence the run executed`,
    )
  } else {
    lines.push(`verdict: ${style.pass('WRITTEN')} — the artifact is written from the completed run`)
  }
  return lines.join('\n') + '\n'
}

/**
 * The `--format json` envelope — byte-stable reference shape:
 *
 *     report:              'assay-dcr-export' (the format marker)
 *     reportVersion:       the CLI package version that produced the report
 *     pipeline:            the pipeline's declared name
 *     runStatus:           the producing run's outcome
 *     gatedAt / gate:      where a gated run stopped (null otherwise)
 *     refusal:             { reason, nodeId } when nothing was written
 *     base / candidate:    { datasetId, versionId, node } per side
 *     schemaDriftFindings: findings carried (null when no artifact)
 *     validationVerdicts:  verdicts carried (null when no artifact)
 *     validationValid:     the carried verdicts' roll-up (null = none carried)
 *     artifact:            { file (basename), bytes } when written
 *
 * Fixed key order, 2-space indent, trailing newline, no timestamps, no paths.
 */
export function renderJsonDcrExportReport(report: DcrExportReport): string {
  const payload = {
    report: 'assay-dcr-export',
    reportVersion: REPORT_VERSION,
    pipeline: report.pipeline,
    runStatus: report.runStatus,
    gatedAt: report.gatedAt,
    gate: report.gate,
    refusal:
      report.refusal === null
        ? null
        : { reason: report.refusal.reason, nodeId: report.refusal.nodeId },
    base:
      report.base === null
        ? null
        : {
            datasetId: report.base.datasetId,
            versionId: report.base.versionId,
            node: report.base.node,
          },
    candidate:
      report.candidate === null
        ? null
        : {
            datasetId: report.candidate.datasetId,
            versionId: report.candidate.versionId,
            node: report.candidate.node,
          },
    schemaDriftFindings: report.schemaDriftFindings,
    validationVerdicts: report.validationVerdicts,
    validationValid: report.validationValid,
    artifact:
      report.artifact === null
        ? null
        : { file: report.artifact.file, bytes: report.artifact.bytes },
  }
  return JSON.stringify(payload, null, 2) + '\n'
}
