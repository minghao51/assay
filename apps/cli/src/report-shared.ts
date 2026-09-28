// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared building blocks for the CLI's split report modules.
 *
 * The three renderer modules (`report-validate`, `report-profile`,
 * `report-diff`) share exactly the concerns that must not drift between
 * surfaces: the single `reportVersion` stamp every `--format json` envelope
 * carries (`REPORT_VERSION`, the CLI's own package version — q-4/au3-12), the
 * anchor-free row-key grammar (`displayRowKey`/`exportRowKey`, used by both
 * the validation and diff renderers), and the basename-only dataset display
 * helper. Keeping them in one small module keeps those contract-visible
 * values single-sourced.
 */
import { basename } from 'node:path'
import { parseRowId } from '@assay/domain'
import type { RowId } from '@assay/domain'
import { readCliVersion } from './version.js'

/**
 * The report-format version stamped into every `--format json` envelope: the
 * CLI's own package version — the same single source `--version` prints (q-4)
 * — so a machine consumer can attribute a report to its producer build. This
 * is deliberately NOT a wire-schema version; the `report` marker names the
 * shape. Read once at module load; the value is byte-stable for a released
 * build.
 */
export const REPORT_VERSION = readCliVersion()

/**
 * Anchor-free display form of a row key (the anchor token is host-derived and
 * never rendered). Unparsable keys cannot occur from the executor (it
 * guarantees resolvable keys) and degrade to `unknown row`.
 */
export function displayRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown row'
  return parsed.origin === 'base'
    ? `base #${String(parsed.ordinal)}`
    : `insert #${String(parsed.seq)}`
}

/**
 * Anchor-free export form (`base:<ordinal>` / `insert:<seq>`) — stable enough
 * to join against the source data without carrying the anchor fingerprint.
 */
export function exportRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown'
  return parsed.origin === 'base'
    ? `base:${String(parsed.ordinal)}`
    : `insert:${String(parsed.seq)}`
}

/** The dataset's basename for the report meta (paths stay out of stdout). */
export function datasetDisplayName(datasetPath: string): string {
  return basename(datasetPath)
}
