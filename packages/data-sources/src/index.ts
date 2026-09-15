/**
 * @assay/data-sources — adapters that produce data handles from
 * files, directories, and (later) remote systems.
 *
 * Interface from docs/architecture/02-architecture.md §6. Implementations:
 * BrowserFileSource (M1-3); planned: BrowserDirectorySource,
 * VSCodeWorkspaceSource (M1/M7), HuggingFaceSource, S3Source, ADLSSource,
 * SnowflakeSource, DatabricksSource (gated, M11 — ADR 0015).
 *
 * This root entry is environment-neutral (no DOM types): packages export raw
 * TypeScript source, so every importer type-checks this module under its own
 * compiler options — `@assay/engine` (no DOM lib) depends on it. The browser
 * implementations (BrowserFileSource, capability detection, pickDataFile)
 * live behind the `@assay/data-sources/browser` entry, which requires DOM
 * lib. The interfaces below are the package's public contract — extend
 * within the package, do not break them.
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
