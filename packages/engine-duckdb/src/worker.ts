/**
 * Engine worker entry — runs DuckDB-WASM off the main thread (ADR 0002/0021).
 *
 * Bootstrapping is lazy: nothing is instantiated until the first request
 * arrives. DuckDB itself runs on its own nested worker (the async duckdb
 * bundle's architecture); this worker is a thin protocol adapter speaking the
 * typed messages from `./protocol`.
 *
 * Query results cross the boundary as Apache Arrow (ADR 0020): the query runs
 * through `conn.send()` so batches stream out of DuckDB instead of
 * materializing a full JS-object result. Only the *first* record batch is
 * transported (M1-2 scope) — it is serialized to an Arrow IPC stream and its
 * ArrayBuffer is listed in the postMessage transfer list, so the bytes move
 * to the main thread zero-copy. If further batches exist, `hasMore` is
 * reported and the pending query is cancelled to free the connection.
 *
 * Bundle choice: the `mvp` browser bundle requires no cross-origin isolation
 * (no COOP/COEP headers, no SharedArrayBuffer), which we cannot assume for
 * every serving context (app, test harness, future VS Code webview). Moving
 * to the `eh` bundle later for parallelism is a two-URL change in this file.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import { Table, tableToIPC } from 'apache-arrow'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import { parseEngineRequest } from './protocol'
import type { EngineResponse } from './protocol'

/**
 * Structural type for the worker global scope. The package tsconfig uses the
 * DOM lib (where `self` is typed as `Window`), so we narrow once to the
 * DedicatedWorkerGlobalScope subset this worker actually uses. The transfer
 * list is what makes the Arrow IPC transport zero-copy.
 */
interface EngineWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(response: EngineResponse, transfer?: ArrayBuffer[]): void
}

const scope: EngineWorkerScope = self as unknown as EngineWorkerScope

interface EngineSession {
  readonly db: duckdb.AsyncDuckDB
  readonly conn: duckdb.AsyncDuckDBConnection
}

let session: Promise<EngineSession> | null = null

/** Lazy bootstrap: first use instantiates DuckDB; failures reset for a retry. */
function ensureSession(): Promise<EngineSession> {
  if (session === null) {
    session = bootSession().catch((error: unknown) => {
      session = null
      throw error
    })
  }
  return session
}

async function bootSession(): Promise<EngineSession> {
  // Classic worker: duckdb's prebuilt glue script (it sets globalThis.onmessage).
  const duckdbWorker = new Worker(duckdbWorkerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), duckdbWorker)
  try {
    await db.instantiate(duckdbWasmUrl)
    const conn = await db.connect()
    return { db, conn }
  } catch (error) {
    // Never leave a half-instantiated engine behind.
    await db.terminate().catch(() => undefined)
    throw error
  }
}

scope.addEventListener('message', (event) => {
  void handleRequest(event.data)
})

async function handleRequest(data: unknown): Promise<void> {
  const request = parseEngineRequest(data)
  if (request === null) {
    // Foreign message: not our protocol; there is no requestId to reply to.
    return
  }
  try {
    switch (request.type) {
      case 'engine/init': {
        const { db } = await ensureSession()
        post({
          type: 'engine/ready',
          requestId: request.requestId,
          duckdbVersion: await db.getVersion(),
        })
        break
      }
      case 'engine/query': {
        await runQuery(request.requestId, request.sql)
        break
      }
    }
  } catch (error) {
    post({ type: 'engine/error', requestId: request.requestId, message: errorMessage(error) })
  }
}

/**
 * Execute the query and transport the first record batch as an Arrow IPC
 * stream. A second `next()` peek determines `hasMore` honestly; when the
 * result continues past the first batch, the remaining batches are dropped
 * (out of M1-2 scope) and the pending query is cancelled so the connection
 * stays usable for follow-up queries.
 */
async function runQuery(requestId: number, sql: string): Promise<void> {
  const { conn } = await ensureSession()
  const reader = await conn.send(sql)
  const first = await reader.next()
  if (first.value === undefined) {
    // DuckDB always emits a batch for a result (a 0-row batch still carries
    // the schema), so an empty stream here means the engine lied to us.
    reader.cancel()
    throw new Error('query produced no record batches')
  }
  const peek = await reader.next()
  const hasMore = !peek.done
  reader.cancel()
  if (hasMore) {
    // Free the connection; the discarded tail is reported via `hasMore`.
    await conn.cancelSent().catch(() => undefined)
  }
  const batchIpc = tableToIPC(new Table(first.value))
  post({ type: 'engine/query-result', requestId, batchIpc, hasMore })
}

function post(response: EngineResponse): void {
  // Zero-copy: when the IPC bytes own their whole ArrayBuffer (the writer's
  // joined output normally does), transfer the buffer instead of cloning it.
  // Ownership moves to the main thread; we never touch the bytes again.
  const transfer: ArrayBuffer[] = []
  if (response.type === 'engine/query-result') {
    const buffer = transferableBuffer(response.batchIpc)
    if (buffer !== null) transfer.push(buffer)
  }
  scope.postMessage(response, transfer)
}

/** The underlying buffer, when it is exactly owned and transferable. */
function transferableBuffer(bytes: Uint8Array): ArrayBuffer | null {
  const { buffer, byteOffset, byteLength } = bytes
  // SharedArrayBuffer cannot go into a transfer list (structured clone).
  if (!(buffer instanceof ArrayBuffer)) return null
  return byteOffset === 0 && byteLength === buffer.byteLength ? buffer : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
