/**
 * Engine worker entry — runs DuckDB-WASM off the main thread (ADR 0002/0021).
 *
 * Bootstrapping is lazy: nothing is instantiated until the first request
 * arrives. DuckDB itself runs on its own nested worker (the async duckdb
 * bundle's architecture); this worker is a thin protocol adapter speaking the
 * typed messages from `./protocol`.
 *
 * T2 operation serialization, two lanes since m2-7: every request is
 * dispatched through one of two pending-query channels (`EngineOpExecutor` +
 * `OpChannel`), one per DuckDB connection. duckdb-wasm 1.32 polls one pending
 * query per connection, so two operations interleaving on ONE connection
 * could collide (misattributed result batches, opaque `_setThrew` failures).
 * Before T2 the one-message-at-a-time behavior was only an accident of
 * postMessage dispatch; T2 made it structural. m2-7 measured the remaining
 * head-of-line cost (an interactive burst behind a long user query waited
 * ~2.4 s against a ~2–6 ms idle baseline) and split the single channel into
 * a query lane (user SQL, profile — on its own connection) and a registry
 * lane (open/schema/range/rowCount/dispose — on another), so the grid's
 * windows no longer queue behind a running query; within each lane the T2
 * guarantees are unchanged. The decision and evidence are documented in
 * `./op-channel`; the operation logic lives in `./engine-executor`.
 *
 * Query results cross the boundary as Apache Arrow (ADR 0020): queries run
 * through `conn.send()` so batches stream out of DuckDB instead of
 * materializing a full JS-object result. Only the *first* record batch is
 * transported (M1-2) — it is serialized to an Arrow IPC stream and its
 * ArrayBuffer is listed in the postMessage transfer list, so the bytes move
 * to the main thread zero-copy. If further batches exist, `hasMore` is
 * reported and the pending query is cancelled to free the connection.
 *
 * M1-4 file lifecycle: `engine/open` registers the picked `File` with
 * DuckDB under the generated table id (reader protocol `BROWSER_FILEREADER`:
 * DuckDB slices the `File` lazily on demand — no upfront copy of the dataset
 * bytes, so multi-GB files stay cheap) and creates a per-format view. Tables
 * are tracked in a `TableRegistry`; `engine/dispose` drops every view and
 * file registration. Range fetches are ordinary windowed SQL (`LIMIT`/
 * `OFFSET` over the view) reusing the same first-batch Arrow transport, with
 * the window validated and clamped against `MAX_RANGE_ROWS` so the engine can
 * never be made to imply full-dataset materialization.
 *
 * Bundle choice: the `mvp` browser bundle requires no cross-origin isolation
 * (no COOP/COEP headers, no SharedArrayBuffer), which we cannot assume for
 * every serving context (app, test harness, future VS Code webview). Moving
 * to the `eh` bundle later for parallelism is a two-URL change in this file.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import { EngineOpExecutor } from './engine-executor'
import type { EngineSessionLike } from './engine-executor'
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

let session: Promise<EngineSessionLike> | null = null
let db: duckdb.AsyncDuckDB | null = null

/** Lazy bootstrap: first use instantiates DuckDB; failures reset for a retry. */
function ensureSession(): Promise<EngineSessionLike> {
  if (session === null) {
    session = bootSession().catch((error: unknown) => {
      session = null
      db = null
      throw error
    })
  }
  return session
}

async function bootSession(): Promise<EngineSessionLike> {
  // Classic worker: duckdb's prebuilt glue script (it sets globalThis.onmessage).
  const duckdbWorker = new Worker(duckdbWorkerUrl)
  const booted = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), duckdbWorker)
  try {
    await booted.instantiate(duckdbWasmUrl)
    // One connection per lane (m2-7): the registry lane's connection creates
    // and drops the persistent views (catalog-level, visible to both); the
    // query lane's connection runs user SQL and profile scans so a long query
    // cannot block the registry lane's short window/metadata ops. Per
    // connection the T2 invariant holds: at most one pending query at a time.
    const conn = await booted.connect()
    const queryConn = await booted.connect()
    db = booted
    // Structural adaptation to the executor's session seam; the executor
    // touches each connection only through `query`/`send`/`cancelSent` and —
    // via its lanes — strictly one operation at a time per connection.
    return {
      getVersion: () => booted.getVersion(),
      conn,
      queryConn,
    }
  } catch (error) {
    // Never leave a half-instantiated engine behind.
    await booted.terminate().catch(() => undefined)
    throw error
  }
}

/** The booted database, for db-level (non-connection) operations. */
async function requireDb(): Promise<duckdb.AsyncDuckDB> {
  await ensureSession()
  if (db === null) {
    throw new Error('engine database is not running')
  }
  return db
}

const executor = new EngineOpExecutor({
  ensureSession,
  // Lazy reference registration (m1-4): the file bytes stay in the picked
  // `File`; DuckDB slices it on demand (BROWSER_FILEREADER protocol case 2
  // of the 1.32.0 worker bundle). Engine-generated names only — user file
  // names never enter the engine (ADR 0025).
  registerFileHandle: (registeredFileName, file) =>
    requireDb().then((database) =>
      database.registerFileHandle(
        registeredFileName,
        file,
        duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
        false,
      ),
    ),
  dropFile: (registeredFileName) =>
    requireDb().then((database) => database.dropFile(registeredFileName)),
  post: (response, transfer) => scope.postMessage(response, transfer),
})

scope.addEventListener('message', (event) => {
  executor.accept(event.data)
})
