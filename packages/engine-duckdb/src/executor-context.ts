// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The explicit executor context for engine-local dispatch handlers (D04a).
 *
 * `EngineOpExecutor` used to be the only holder of these seams, and every
 * handler reached them through `this`. Extracted handlers (`./csv-dispatch`)
 * instead receive ONE context object carrying exactly the seams they use —
 * the injected DuckDB/session/file-op surface, the two registries, and the
 * op-channel lane the request was routed to. Properties, not a global:
 *
 * - one owner per registry — the executor constructs `TableRegistry` and
 *   `PreviewRegistry` and hands the SAME instances to every handler (the
 *   handler modules hold no module-level mutable state);
 * - one lane decision — routing happens in `accept`, and the lane object
 *   carries both its `OpChannel` (FIFO serialization) and the connection its
 *   ops run on, so a handler cannot pick a connection that disagrees with the
 *   lane it queued on (the m2-7 property);
 * - the response transport (`post`, `streamFirstBatch`) stays executor-owned
 *   so the zero-copy transfer list and the first-batch cleanup gating are not
 *   re-implemented per handler.
 *
 * This module must stay dependency-light (types plus the structural seams
 * only) so it can be imported by both the executor and the handler modules
 * without an import cycle.
 */
import type { RecordBatch, Table } from 'apache-arrow'
import type { OpChannel } from './op-channel.js'
import type { PreviewRegistry } from './preview-registry.js'
import type { TableRegistry } from './table-registry.js'
import type { EngineResponse } from './protocol.js'

/**
 * Minimal structural view of an Apache Arrow record-batch stream reader —
 * the slice of `arrow.AsyncRecordBatchStreamReader` the executor consumes
 * (`next` resolves batches; `cancel` releases the connection-side result).
 */
export interface EngineResultReaderLike {
  next(): Promise<IteratorResult<RecordBatch, undefined>>
  cancel(): Promise<void>
}

/**
 * Minimal structural view of a DuckDB connection: everything the executor
 * may touch. All three members are connection-scoped in duckdb-wasm — which
 * is why the executor never runs two of them concurrently (see op-channel).
 */
export interface EngineConnectionLike {
  /** Materialized query (`send` + full drain inside duckdb-wasm). */
  query(sql: string): Promise<Table>
  /** Stream a query; the pending-query slot is held until drain/cancel. */
  send(sql: string): Promise<EngineResultReaderLike>
  /** Cancel the connection's pending query (drains discarded tails). */
  cancelSent(): Promise<unknown>
}

/** Minimal structural view of a booted engine session (one lane pair). */
export interface EngineSessionLike {
  /** Version probe for `engine/init` (db-level, boot-time only). */
  getVersion(): Promise<string>
  /** Registry-lane connection: open/schema/range/rowCount/dispose. */
  readonly conn: EngineConnectionLike
  /** Query-lane connection: `engine/query` and `engine/profile` (m2-7). */
  readonly queryConn: EngineConnectionLike
}

/** Dependencies injected by the worker entry (or faked by unit tests). */
export interface EngineExecutorDeps {
  /** Lazy session boot; failures reset so the next op retries (unchanged). */
  ensureSession(): Promise<EngineSessionLike>
  /** Register the picked `File` under its engine-generated name (m1-4). */
  registerFileHandle(registeredFileName: string, file: File): Promise<void>
  /** Best-effort file deregistration (rollback + dispose). */
  dropFile(registeredFileName: string): Promise<unknown>
  /**
   * Read a file DuckDB wrote into its virtual filesystem (m4-2 export:
   * `COPY … TO` lands there; the bytes then move to OPFS scratch space).
   */
  copyExportBytes(registeredFileName: string): Promise<Uint8Array>
  /**
   * Persist export bytes into OPFS scratch space under the generated
   * destination path (ADR 0017 disposable-cache framing — never the source
   * path). Injected because the executor must stay Node-testable.
   */
  writeExportFile(path: string, bytes: Uint8Array): Promise<void>
  /** Deliver a protocol response (with an optional zero-copy transfer list). */
  post(response: EngineResponse, transfer?: ArrayBuffer[]): void
}

/**
 * One pending-query lane: its FIFO channel (`OpChannel`) plus the connection
 * its ops run on, derived from the session. Routing (`accept`) and connection
 * choice are the same decision — both come from this object — so rerouting an
 * op class to another lane moves it onto that lane's connection too. The m2-7
 * fix round pinned this: with the connection hard-coded per handler, rerouting
 * `profile` to the registry lane would run its DESCRIBE beside a parked user
 * query on the query-lane connection — the exact T2 pending-query collision
 * (guarded by the parked-query unit drill in engine-executor.test.ts).
 */
export interface EngineOpLane {
  readonly channel: OpChannel
  readonly connection: (session: EngineSessionLike) => EngineConnectionLike
}

/**
 * The first-batch Arrow transport result (ADR 0020): the IPC bytes of the
 * first record batch plus the honest continuation flag. Produced by the
 * executor's `streamFirstBatch`, which releases the reader in `finally`
 * BEFORE returning — so a handler that receives one of these already has its
 * cleanup done (successful-response cleanup gating).
 */
export interface EngineFirstBatch {
  readonly batchIpc: Uint8Array
  readonly hasMore: boolean
}

/**
 * The explicit executor context threaded into engine-local dispatch handlers
 * (D04a). Everything a handler may touch is named here; nothing is reachable
 * through a global, a module-level singleton, or a hidden mutable import.
 */
export interface EngineHandlerContext {
  /** The worker's injected engine surface (session boot, file handles, post). */
  readonly deps: EngineExecutorDeps
  /** The ONE session-table registry owner (opens reserve/roll back entries). */
  readonly registry: TableRegistry
  /** The ONE preview-slot registry owner (ADR 0049 decision 4). */
  readonly previews: PreviewRegistry
  /** The lane `accept` routed this request to (channel plus its connection). */
  readonly lane: EngineOpLane
  /**
   * Stream the first record batch of `sql` on `conn` — the executor's own
   * helper, so the reader is released in `finally` before anything is posted
   * (a handler never re-implements the drain/cancel ordering).
   */
  streamFirstBatch(conn: EngineConnectionLike, sql: string): Promise<EngineFirstBatch>
  /** Post a protocol response with the executor's zero-copy transfer handling. */
  post(response: EngineResponse): void
}
