/**
 * @assay/engine — the engine interface layer (interfaces only).
 *
 * Every engine implementation (engine-duckdb, engine-parquet, future
 * DataFusion/native engines) passes the same conformance suite
 * (docs/engineering/05-repository-structure.md §4) and stays behind this
 * interface so browser WASM constraints never become product constraints
 * (docs/engineering/03-tech-stack.md §7, ADR 0002/0020).
 */
import type { DataSource } from '@assay/data-sources'

/** Opaque handle to a table registered with an engine. */
export interface TableHandle {
  readonly kind: 'table'
  readonly id: string
}

/**
 * Placeholder stream type. From M1 this becomes Apache Arrow record batches
 * transported from a worker (ADR 0020/0021); the exact Arrow binding is an
 * implementation detail behind this alias.
 */
export type ArrowBatchStream = AsyncIterable<unknown>

export interface QueryRequest {
  sql: string
  limit?: number
  offset?: number
}

export interface ColumnProfile {
  name: string
  type: string
  nullCount: number
  distinctCount: number
}

export interface DatasetProfile {
  rowCount: number
  columns: ColumnProfile[]
}

export type ExportFormat = 'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow'

export interface ExportOptions {
  compression?: string
  rowGroupSize?: number
  partitionBy?: string[]
}

/** The engine contract (docs/architecture/02-architecture.md §7). */
export interface DataEngine {
  open(source: DataSource): Promise<TableHandle>
  query(request: QueryRequest): Promise<ArrowBatchStream>
  schema(table: TableHandle): Promise<Array<{ name: string; type: string }>>
  profile(table: TableHandle): Promise<DatasetProfile>
  exportTable(
    table: TableHandle,
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<ReadableStream<Uint8Array>>
}
