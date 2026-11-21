// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * COPY/export SQL emission (m4-2; extracted as its own module by D04b).
 *
 * The export/rewrite op materializes the effective view (base + overlay) into
 * a **new** file, never touching the source (ADR 0012). This module owns the
 * *emission* half of that op: the pinned per-format COPY option list, the
 * destination literal and extension convention, and the two composers the
 * executor calls. Everything exported here is a pure function of
 * (composition, format, destination) — no state, no engine handle, no session,
 * no module-level mutable state.
 *
 * Layering (D04b): the overlay composition group stays in
 * `./overlay-query.js` (base/insert branches, repair wraps, window/schema/
 * count SQL, the repair caps and the export budget). This module composes over
 * it and imports exactly two of its seams — the effective-source composer and
 * the pre-apply export budget assertion — so the export SELECT can never drift
 * from the relation the window/schema/count ops read.
 *
 * **Byte-identity is the contract** (D04b is a seam extraction, never a
 * semantics change): the COPY statement text, the pinned option tokens, the
 * guarded CSV header aliases, the CSV value guard the SELECT carries, and the
 * Arrow path's streamed SELECT are all unchanged from the pre-D04b module. The
 * existing golden / DuckDB-CLI agreement snapshots pin that and were not
 * edited (only their import path moved).
 *
 * The pinned option tokens have **one canonical owner here**:
 * {@link PARQUET_COPY_OPTIONS} is both the `parquet` entry of the format table
 * and the pipeline export node's option list (the executor consumes it instead
 * of re-typing the fragment).
 */
import { quotedIdentifier, sqlStringLiteral } from './format-view.js'
import {
  assertRepairExportBudget,
  composeEffectiveSourceSql,
  OVERLAY_SORT_KEY_COLUMN,
} from './overlay-query.js'
import type { OverlayComposition } from './overlay-query.js'
import type { EngineExportFormat } from './protocol.js'

/**
 * The pinned PARQUET COPY option list: ZSTD with the DuckDB default row-group
 * size — the same conventions as the repository's own fixture generator
 * (ADR 0038). Canonical owner of the fragment: the format table below and the
 * pipeline export node both reference it.
 */
export const PARQUET_COPY_OPTIONS = 'FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880'

/** Deterministic COPY options pinned for v1 exports (per format). */
const EXPORT_FORMAT_OPTIONS: ReadonlyMap<EngineExportFormat, string> = new Map([
  // ZSTD + the DuckDB default row-group size: same conventions as the
  // repository's own fixture generator (ADR 0038).
  ['parquet', PARQUET_COPY_OPTIONS],
  ['csv', "FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"'"],
  // ARRAY false = newline-delimited JSON (JSONL); ARRAY true = one array.
  ['jsonl', 'FORMAT JSON, ARRAY false'],
  ['json', 'FORMAT JSON, ARRAY true'],
])

/** The file extension an exported destination carries for each format. */
export function exportFileExtension(format: EngineExportFormat): string {
  return format
}

/**
 * The CSV **header** form of one column name — the header is row 1 of any
 * spreadsheet, so a hostile column name (`=SUM(A2:A3)`, `+x`, `-x`, `@x`, or
 * a name carrying TAB/LF/CR anywhere) is a live formula unless guarded. The
 * policy is the identifier twin of `formulaInjectionGuardSql`
 * (`./overlay-query.js`): prefix the apostrophe (SQL `chr(39) || name`) when
 * the name triggers. Because the name is a known composition-time string, the
 * prefix is applied directly and the guarded name interpolated as a
 * string-literal SELECT alias. Non-CSV exports never call this: there the name
 * is a data key, not a formula, and must stay byte-identical.
 *
 * Known, accepted corners: (1) guarding is not injective — `=cmd` and
 * `'=cmd` both guard to `'=cmd`, and DuckDB dedupes the colliding COPY
 * header to `'=cmd_1` silently (no error, no data loss) — the identifier
 * twin of the value-guard prefix collision; (2) `read_csv` cannot re-open
 * a CSV whose *header* carries quoted CR/LF (the auto-sniffer refuses the
 * file), so those guarded forms are pinned at the composed-SQL level, not
 * via a round-trip — pre-existing sniffer behavior, out of our control.
 *
 * Deliberate **no-BOM** policy: the exported CSV carries no UTF-8 BOM
 * (`\uFEFF`). Byte-stable golden/conformance fixtures and programmatic
 * consumers win over Excel's double-click encoding heuristic; a BOM is a
 * documented non-goal of this data-interchange format, never emitted.
 */
function csvHeaderGuardName(name: string): string {
  const startsWithTrigger =
    name.startsWith('=') || name.startsWith('+') || name.startsWith('-') || name.startsWith('@')
  const containsControl = name.includes('\t') || name.includes('\n') || name.includes('\r')
  return startsWithTrigger || containsControl ? `'${name}` : name
}

/**
 * The COPY statement materializing the effective view (base + overlay) in
 * effective order — the export/rewrite op's SQL (ADR 0012: commit creates a
 * *new* file; the source is never written). The projection applies the CSV
 * formula-injection guard for `csv` exports. Row ids are *not* exported: a
 * written file is a new base version, and logical row ids are session-scoped
 * (the documented survival boundary). Returns `null` for `arrow`, which is
 * materialized by streaming the (identical) SELECT through Arrow IPC
 * instead — see {@link composeOverlayExportSelectSql} for why.
 */
export function composeOverlayExportSql(
  composition: OverlayComposition,
  format: EngineExportFormat,
  destination: string,
): string | null {
  if (format === 'arrow') return null
  const options = EXPORT_FORMAT_OPTIONS.get(format)
  if (options === undefined) {
    throw new Error(`unsupported export format: ${format}`)
  }
  return (
    `COPY (${composeOverlayExportSelectSql(composition, format)}) TO ` +
    `${sqlStringLiteral(destination)} (${options})`
  )
}

/**
 * The bare export SELECT (effective view, effective order, CSV guard
 * applied) — what the COPY wraps, and the statement the `arrow` path streams
 * (DuckDB-WASM's bundled build has no Arrow COPY writer, so Arrow IPC
 * *streams* are assembled worker-side from the streamed result (the web layer
 * advertises the stream MIME `application/vnd.apache.arrow.stream` — not the
 * feather-file MIME); the SELECT is byte-
 * identical to the COPY path's input, keeping the two formats honest
 * siblings).
 *
 * The projection is the **outer** SELECT above `composeSourceSql`'s
 * `UNION ALL` branches, so a CSV header alias applies uniformly to the base
 * and every insert branch (the branches already agree on raw column names,
 * and the alias is positional). For `csv` only, each projected column is
 * aliased to its apostrophe-guarded name (row 1 is a spreadsheet surface);
 * every other format projects the raw name verbatim so json/jsonl/parquet/
 * arrow bytes are unchanged — there a name is a data key, not a formula.
 */
export function composeOverlayExportSelectSql(
  composition: OverlayComposition,
  format: EngineExportFormat,
): string {
  // The export budget is a pre-apply refusal: projected rows × mapping pairs
  // over the published envelope refuses before any SQL is composed or run
  // (never claimed as an interrupt).
  assertRepairExportBudget(composition)
  const source = composeEffectiveSourceSql(composition, {
    withRowIds: false,
    sanitizeCsv: format === 'csv',
    withKey: true,
  })
  const projection = composition.state.columns
    .map((column) => {
      const reference = quotedIdentifier(column.name)
      if (format !== 'csv') return reference
      return `${reference} AS ${sqlStringLiteral(csvHeaderGuardName(column.name))}`
    })
    .join(', ')
  let sql = `SELECT ${projection} FROM (${source})`
  if ([...composition.state.inserts.values()].some((record) => record.live)) {
    sql += ` ORDER BY ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`
  }
  return sql
}
