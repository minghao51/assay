// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Node-side DuckDB connection + dataset registration (m5-4).
 *
 * The CLI's execution backend (the m5-4 spike's recommendation): the official
 * `@duckdb/node-api` package — native DuckDB 1.5.5 bindings, MIT-licensed,
 * npm-distributed with prebuilt per-platform binaries (no build scripts, no
 * bundled CLI binary). Version 1.5.5-r.5 deliberately tracks the pinned
 * DuckDB CLI (v1.5.5, ADR 0038) that derived the conformance expectations, so
 * type inference (e.g. the mixed-sign-JSON → HUGEINT widening) matches the
 * engine exactly — the agreement test pins this.
 *
 * What the CLI does NOT need (ADR 0040 honesty): no worker transport, no op
 * lanes, no registry of concurrent tables, no overlay machinery for validate
 * — one in-memory instance, one connection, one registered view per run.
 *
 * Privacy (ADR 0025): the dataset path appears only in SQL string literals
 * (properly escaped) and in `CliError` messages the user's own invocation
 * produced; dataset values never reach this module's errors.
 */
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import type { DuckDBConnection, DuckDBResultReader } from '@duckdb/node-api'
import { createViewSql, detectFileFormat, quotedIdentifier } from '@assay/engine-duckdb/node'
import type { EngineFileFormat } from '@assay/engine-duckdb/node'
import type { EngineSchema } from '@assay/validation'
import { usageError } from './errors.js'

/** The engine-generated view name the dataset is registered under. */
export const DATASET_VIEW = 'assay_t1'

/**
 * The binding name the compiled plan's SQL references (the compiler quotes it
 * into every FROM). A fixed per-surface constant: the executor materializes
 * the validated view under exactly this name, and byte-stable SQL follows
 * from the constant. Not a registered view name, so the plan gate's
 * no-shadowing check has real meaning.
 */
export const PLAN_RELATION = 'assay_cli_validate_src'

/** Formats the CLI can open (the engine's supported set: ADR 0002 scope). */
export const SUPPORTED_FORMATS = 'parquet, csv, jsonl, json'

/**
 * Open an in-memory DuckDB instance + connection. Cold cost is ~100 ms
 * (measured in the m5-4 spike; the native bindings load eagerly).
 */
export async function openConnection(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:')
  return instance.connect()
}

/**
 * Register the dataset file as the validate view, exactly like the engine's
 * `open` does (same extension-based format policy, same lazy reader
 * functions, same `CREATE VIEW` shape) and DESCRIBE it into the compiler's
 * schema shape.
 *
 * Path/format failures are typed usage errors with readable, value-free
 * messages; a DuckDB reader refusal becomes a fixed failure class (DuckDB's
 * own message is dropped — it is engine text, not ours).
 */
export async function registerDataset(
  conn: DuckDBConnection,
  datasetPath: string,
): Promise<{ readonly format: EngineFileFormat; readonly schema: EngineSchema }> {
  return registerDatasetAs(conn, datasetPath, DATASET_VIEW)
}

/**
 * Register one dataset file under a caller-chosen engine-generated view name
 * (m6-3): `assay diff` registers side A and side B under two distinct views.
 * The format/path/describe policy is identical to {@link registerDataset} —
 * only the view name differs, so validation stays untouched.
 */
export async function registerDatasetAs(
  conn: DuckDBConnection,
  datasetPath: string,
  viewName: string,
): Promise<{ readonly format: EngineFileFormat; readonly schema: EngineSchema }> {
  if (!existsSync(datasetPath)) {
    throw usageError(`dataset file not found: ${datasetPath}`)
  }
  if (!statSync(datasetPath).isFile()) {
    throw usageError(`dataset path is not a file: ${datasetPath}`)
  }
  const format = detectFileFormat(basename(datasetPath))
  if (format === null) {
    throw usageError(
      `unsupported dataset format '${basename(datasetPath)}' — supported: ${SUPPORTED_FORMATS}`,
    )
  }
  try {
    await conn.run(createViewSql(viewName, datasetPath, format))
  } catch {
    throw usageError(`the dataset could not be opened (${format} reader refused the file)`)
  }
  return { format, schema: await describeView(conn, viewName) }
}

/**
 * Count the rows registered under a view (the `dataset_opened` scale bucket).
 * Used only by the value-free telemetry path; a caller that cannot read the
 * count must degrade to emitting nothing rather than surface an error.
 */
export async function countViewRows(conn: DuckDBConnection, viewName: string): Promise<number> {
  const reader = await conn.runAndReadAll(
    `SELECT count(*) AS row_count FROM ${quotedIdentifier(viewName)}`,
  )
  const value = reader.getRowObjects()[0]?.['row_count']
  const count = typeof value === 'bigint' ? Number(value) : value
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw usageError('the dataset row count could not be read')
  }
  return count
}

/**
 * DESCRIBE a view into `{ name, type }[]` — the same shape (and the same
 * all-VARCHAR assumption) as the engine's schema surface, so the compiler
 * sees byte-identical type spellings on both surfaces.
 */
async function describeView(conn: DuckDBConnection, viewName: string): Promise<EngineSchema> {
  const reader = await conn.runAndReadAll(`DESCRIBE ${quotedIdentifier(viewName)}`)
  const rows = reader.getRowObjects()
  const schema: { name: string; type: string }[] = []
  for (const row of rows) {
    const name = row['column_name']
    const type = row['column_type']
    if (typeof name !== 'string' || typeof type !== 'string') {
      throw usageError('the dataset could not be described (unexpected DESCRIBE shape)')
    }
    schema.push({ name, type })
  }
  if (schema.length === 0) {
    throw usageError('the dataset has no columns — nothing to validate against')
  }
  return schema
}

/** The result reader type the executor converts to Arrow (exported for tests). */
export type { DuckDBResultReader }
