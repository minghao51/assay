/**
 * @dataworkbench/data-sources — adapters that produce data handles from
 * files, directories, and (later) remote systems.
 *
 * Interface from docs/architecture/02-architecture.md §6. Planned
 * implementations: BrowserFileSource, BrowserDirectorySource,
 * VSCodeWorkspaceSource (M1/M7), HuggingFaceSource, S3Source, ADLSSource,
 * SnowflakeSource, DatabricksSource (gated, M11 — ADR 0015).
 */

/** Opaque handle to opened source data; engine-specific capabilities live behind the engine. */
export interface DataHandle {
  readonly kind: 'data-handle'
  readonly sourceId: string
}

export interface DataSourceMetadata {
  format: string
  sizeBytes?: number
  rowCount?: number
  partitions?: string[]
}

export interface DataSource {
  readonly id: string
  readonly kind: string
  open(): Promise<DataHandle>
  metadata(): Promise<DataSourceMetadata>
}
