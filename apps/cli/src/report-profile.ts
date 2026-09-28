// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// ar-5 — `assay profile` report model + renderers (AR-C4)
//
// The `profile` command renders the `DatasetProfile` the `./node` seam's
// `profileView` builds from the REUSED m2-5 profile SQL (never forked). Both
// forms are byte-stable: the JSON envelope has fixed key order, 2-space
// indent, a trailing newline, no timestamps, and basenames only. Profile
// output is product content on stdout (ADR 0025); stderr stays value-free.
// Nullable statistics render as `null` in JSON and `n/a` in the human report
// — an undefined statistic is shown as missing, never faked as a value.
// ---------------------------------------------------------------------------

import type { ColumnProfile, DatasetProfile } from '@assay/diff'
import { REPORT_VERSION } from './report-shared.js'

/** Render metadata for the profile report (no dataset values allowed here). */
export interface ProfileReportMeta {
  /** The dataset file's BASENAME (never the full path — byte-stability). */
  readonly datasetName: string
  readonly format: string
  /** The engine's fixed categorical top-k limit (`PROFILE_TOP_K`). */
  readonly topK: number
}

/** A finite statistic or `null`/`undefined`, as human report text. */
function profileMetric(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : String(value)
}

/** One column's human identity + counts line (the numeric/categorical body follows). */
function profileColumnHead(column: ColumnProfile): string {
  return (
    `column ${column.name} (${column.type}) — ${column.kind} — ` +
    `nulls ${String(column.nullCount)}, distinct ${String(column.distinctCount)}`
  )
}

/**
 * The human profile report: one identity/counts line per column, then the
 * kind-specific body (numeric stats in a fixed order, or the categorical
 * top-k ranked by count). Line formats are part of the byte-pinned
 * integration contract.
 */
export function renderHumanProfile(profile: DatasetProfile, meta: ProfileReportMeta): string {
  const lines: string[] = []
  lines.push(
    `dataset: ${meta.datasetName} (${meta.format}) — base view only (the raw file; no edits)`,
  )
  lines.push(`rows: ${String(profile.rowCount)}`)
  lines.push(`columns: ${String(profile.columns.length)}`)
  for (const column of profile.columns) {
    lines.push(profileColumnHead(column))
    if (column.numeric !== undefined) {
      const stats = column.numeric
      lines.push(
        `  min ${profileMetric(stats.min)}, max ${profileMetric(stats.max)}, ` +
          `mean ${profileMetric(stats.mean)}, stddev ${profileMetric(stats.stddev)}, ` +
          `p50 ${profileMetric(stats.quantiles.p50)}, p90 ${profileMetric(stats.quantiles.p90)}, ` +
          `p95 ${profileMetric(stats.quantiles.p95)}, p99 ${profileMetric(stats.quantiles.p99)}`,
      )
    } else if (column.categorical !== undefined) {
      const topK = column.categorical.topK
      if (topK.length === 0) {
        lines.push('  no non-null values')
      } else {
        lines.push(
          `  top ${String(topK.length)} of ${String(column.distinctCount)} distinct non-null values:`,
        )
        for (const entry of topK) {
          lines.push(`    ${String(entry.count)} × ${entry.value}`)
        }
      }
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * The `--format json` profile envelope (byte-stable reference shape):
 *
 *     report:        'assay-profile-report' (the format marker)
 *     reportVersion: the CLI package version that produced the report
 *     baseViewOnly:  true — the CLI profiled the RAW file (no overlay)
 *     dataset:       { name (basename), format }
 *     rows:          the profiled row count
 *     topK:          the engine's categorical top-k limit
 *     columns[]:     name, type, kind, nullCount, distinctCount, and the
 *                    kind payload (`numeric` stats or `categorical.topK`),
 *                    the other one null
 *
 * Fixed key order, 2-space indent, trailing newline, no timestamps, no paths.
 */
export function renderJsonProfile(profile: DatasetProfile, meta: ProfileReportMeta): string {
  const payload = {
    report: 'assay-profile-report',
    reportVersion: REPORT_VERSION,
    baseViewOnly: true,
    dataset: { name: meta.datasetName, format: meta.format },
    rows: profile.rowCount,
    topK: meta.topK,
    columns: profile.columns.map((column) => ({
      name: column.name,
      type: column.type,
      kind: column.kind,
      nullCount: column.nullCount,
      distinctCount: column.distinctCount,
      numeric:
        column.numeric === undefined
          ? null
          : {
              min: column.numeric.min,
              max: column.numeric.max,
              mean: column.numeric.mean,
              stddev: column.numeric.stddev,
              quantiles: {
                p50: column.numeric.quantiles.p50,
                p90: column.numeric.quantiles.p90,
                p95: column.numeric.quantiles.p95,
                p99: column.numeric.quantiles.p99,
              },
            },
      categorical:
        column.categorical === undefined
          ? null
          : {
              topK: column.categorical.topK.map((entry) => ({
                value: entry.value,
                count: entry.count,
              })),
            },
    })),
  }
  return JSON.stringify(payload, null, 2) + '\n'
}
