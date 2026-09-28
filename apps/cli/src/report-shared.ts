// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared building blocks for the CLI's split report modules.
 *
 * The three renderer modules (`report-validate`, `report-profile`,
 * `report-diff`) share exactly the concerns that must not drift between
 * surfaces: the single `reportVersion` stamp every `--format json` envelope
 * carries (`REPORT_VERSION`, the CLI's own package version — q-4/au3-12), the
 * anchor-free row-key grammar (`displayRowKey`/`exportRowKey`, single-sourced
 * from `@assay/domain` beside `parseRowId` and re-exported here), and the
 * basename-only dataset display helper. Keeping them in one small module
 * keeps those contract-visible values single-sourced.
 */
import { basename } from 'node:path'
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
 * Anchor-free row-key grammar, single-sourced from `@assay/domain` (AU-2
 * f-9): `displayRowKey` renders `base #12` / `insert #3` / `unknown row`,
 * `exportRowKey` renders `base:12` / `insert:3` / `unknown`. The re-export
 * keeps `./report-shared.js`'s historical public surface unchanged.
 */
export { displayRowKey, exportRowKey } from '@assay/domain'

/** The dataset's basename for the report meta (paths stay out of stdout). */
export function datasetDisplayName(datasetPath: string): string {
  return basename(datasetPath)
}
