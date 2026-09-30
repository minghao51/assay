// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-format view registration SQL (task M1-4).
 *
 * An opened file becomes a DuckDB *view* over a lazy reader table function —
 * nothing is materialized at open time; every later range/schema query re-reads
 * only the bytes it needs (multi-GB files stay cheap, ADR 0002). The view is
 * created once per open with a generated, engine-controlled name; the file is
 * registered under the generated table id (`t1`, …), so user-controlled file
 * names never appear inside SQL — no quoting, escaping, or glob surprises.
 *
 * Format selection is deliberately extension-based (same policy as
 * `@assay/data-sources` `detectFormatFromFileName`): DuckDB's readers sniff the
 * *contents* (schema, dialect); the extension only picks the reader function.
 * Type strings pass through DuckDB verbatim (no mapping layer yet — that is
 * m1-6's concern).
 */

/** Formats this engine can register a view for (arrow/feather: deferred). */
export type EngineFileFormat = 'parquet' | 'csv' | 'jsonl' | 'json'

/**
 * Detect the DuckDB reader format from a file name (case-insensitive last
 * extension). Returns `null` for anything the engine cannot read yet — callers
 * must surface a clear error instead of guessing.
 */
export function detectFileFormat(fileName: string): EngineFileFormat | null {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return null
  }
  switch (fileName.slice(lastDot + 1).toLowerCase()) {
    case 'parquet':
      return 'parquet'
    case 'csv':
      return 'csv'
    case 'jsonl':
      return 'jsonl'
    case 'json':
      return 'json'
    default:
      return null
  }
}

/** Quote a SQL identifier (double-quote escaping), e.g. a column name. */
export function quotedIdentifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"'
}

/** Quote a SQL string literal (single-quote escaping), e.g. a file name. */
export function sqlStringLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'"
}

/**
 * SQL that reads the registered file with the format's lazy reader. The name
 * argument is normally the engine-generated table id; it is still escaped so
 * this function stays safe for any input.
 */
export function fileScanSql(registeredFileName: string, format: EngineFileFormat): string {
  const file = sqlStringLiteral(registeredFileName)
  switch (format) {
    case 'parquet':
      return `read_parquet(${file})`
    case 'csv':
      return `read_csv(${file})`
    case 'jsonl':
      // Explicit NDJSON dialect; column names/types stay auto-detected.
      return `read_json_auto(${file}, format = 'newline_delimited')`
    case 'json':
      // Auto-detects array-of-objects vs newline-delimited vs unstructured.
      return `read_json_auto(${file})`
  }
}

/** `CREATE VIEW` statement binding a generated view name to the file scan. */
export function createViewSql(
  viewName: string,
  registeredFileName: string,
  format: EngineFileFormat,
): string {
  return `CREATE VIEW ${quotedIdentifier(viewName)} AS SELECT * FROM ${fileScanSql(registeredFileName, format)}`
}

/**
 * `CREATE OR REPLACE VIEW` variant (p-3): the pipeline runner re-materializes
 * a source relation on every run, so the statement must be idempotent rather
 * than collide with the previous run's view. Same binding and quoting as
 * {@link createViewSql}.
 */
export function createOrReplaceViewSql(
  viewName: string,
  registeredFileName: string,
  format: EngineFileFormat,
): string {
  return `CREATE OR REPLACE VIEW ${quotedIdentifier(viewName)} AS SELECT * FROM ${fileScanSql(registeredFileName, format)}`
}
