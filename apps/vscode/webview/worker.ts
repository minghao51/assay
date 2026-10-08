// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spike webview worker (ptv-1): boots `@duckdb/duckdb-wasm` inside a Web
 * Worker and answers the R4 evidence requests.
 *
 * The boot shape mirrors the real engine (`packages/engine-duckdb/src/worker.ts`):
 * a prebuilt DuckDB glue worker (`duckdb-browser-<bundle>.worker.js`) is created
 * as a classic Worker and driven through `AsyncDuckDB.instantiate(wasmUrl)`.
 * Both the `mvp` and `eh` bundles are probed so Q1 can answer "which build and
 * does it need cross-origin isolation" empirically. The worker URLs are injected
 * from the extension host (they are `vscode-webview-resource:` URIs), never
 * imported with a bundler `?url` — that keeps the spike honest about what the
 * webview origin actually allows.
 */
import * as duckdb from '@duckdb/duckdb-wasm'

interface BundleUrls {
  readonly workerUrl: string
  readonly wasmUrl: string
}

interface BootRequest {
  readonly kind: 'boot'
  readonly id: number
  readonly bundle: 'mvp' | 'eh'
  readonly urls: BundleUrls
}

interface OpenRequest {
  readonly kind: 'open'
  readonly id: number
  readonly name: string
  readonly bytes: ArrayBuffer
}

interface QueryRequest {
  readonly kind: 'query'
  readonly id: number
  readonly sql: string
}

interface OpfsRequest {
  readonly kind: 'opfsProbe'
  readonly id: number
}

type SpikeRequest = BootRequest | OpenRequest | QueryRequest | OpfsRequest

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<SpikeRequest>) => void): void
  postMessage(response: unknown, transfer?: ArrayBuffer[]): void
}

const scope = self as unknown as WorkerScope

let database: duckdb.AsyncDuckDB | null = null
let connection: duckdb.AsyncDuckDBConnection | null = null

function respond(id: number, result: unknown): void {
  scope.postMessage({ kind: 'response', id, ok: true, result })
}

function fail(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  scope.postMessage({ kind: 'response', id, ok: false, error: message })
}

/** Diagnostic progress lines the harness records (worker boot stage visibility). */
function progress(message: string): void {
  scope.postMessage({ kind: 'progress', message })
}

async function boot(request: BootRequest): Promise<unknown> {
  progress(`boot:${request.bundle}:start`)
  const started = performance.now()
  const worker = new Worker(request.urls.workerUrl)
  worker.onerror = (event: ErrorEvent) => {
    progress(`boot:${request.bundle}:duckdb-worker-onerror: ${event.message}`)
  }
  worker.onmessageerror = () => {
    progress(`boot:${request.bundle}:duckdb-worker-onmessageerror`)
  }
  progress(`boot:${request.bundle}:worker-created`)
  const instance = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
  progress(`boot:${request.bundle}:instantiate-start`)
  try {
    await instance.instantiate(request.urls.wasmUrl)
  } catch (error) {
    // Never leave a half-instantiated engine (or a live worker) behind.
    await instance.terminate().catch(() => undefined)
    throw error
  }
  progress(`boot:${request.bundle}:instantiated`)
  const version = await instance.getVersion()
  database = instance
  connection = await instance.connect()
  return {
    ok: true,
    bootMs: performance.now() - started,
    version,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  }
}

function requireConnection(): duckdb.AsyncDuckDBConnection {
  if (connection === null) {
    throw new Error('database is not booted')
  }
  return connection
}

function assertSafeFileName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`unsafe spike fixture name: ${JSON.stringify(name)}`)
  }
}

/** Register the fixture bytes, make a view, and time open → count → first row. */
async function openFixture(request: OpenRequest): Promise<unknown> {
  const db = database
  if (db === null) {
    throw new Error('database is not booted')
  }
  assertSafeFileName(request.name)
  const conn = requireConnection()
  const bytes = new Uint8Array(request.bytes)
  const byteLength = bytes.byteLength
  const openStarted = performance.now()
  await db.registerFileBuffer(request.name, bytes)
  await conn.query(
    `CREATE OR REPLACE VIEW spike_view AS SELECT * FROM read_parquet('${request.name}')`,
  )
  const openMs = performance.now() - openStarted

  const countStarted = performance.now()
  const countTable = await conn.query('SELECT count(*)::BIGINT AS n FROM spike_view')
  const countColumn = countTable.getChildAt(0)
  const rows = countColumn === null ? 0 : Number(countColumn.get(0))
  const rowCountMs = performance.now() - countStarted

  // Record the runtime extension dependency (`read_parquet` autoloads the
  // Parquet extension from extensions.duckdb.org in DuckDB-WASM 1.32.0).
  let parquetExtension: unknown = null
  try {
    const extTable = await conn.query(
      "SELECT extension_name, loaded, installed FROM duckdb_extensions() WHERE extension_name = 'parquet'",
    )
    parquetExtension = {
      name: String(extTable.getChildAt(0)?.get(0) ?? ''),
      loaded: Boolean(extTable.getChildAt(1)?.get(0)),
      installed: Boolean(extTable.getChildAt(2)?.get(0)),
    }
  } catch (error) {
    parquetExtension = { error: error instanceof Error ? error.message : String(error) }
  }

  const firstRowStarted = performance.now()
  const windowTable = await conn.query('SELECT id, bucket, label FROM spike_view LIMIT 1000')
  const ttfrMs = performance.now() - firstRowStarted
  const firstRow = {
    id: String(windowTable.getChildAt(0)?.get(0) ?? ''),
    bucket: String(windowTable.getChildAt(1)?.get(0) ?? ''),
    label: String(windowTable.getChildAt(2)?.get(0) ?? ''),
  }

  return {
    bytes: byteLength,
    rows,
    openMs,
    rowCountMs,
    ttfrMs,
    ttfrRows: windowTable.numRows,
    firstRow,
    pickerToFirstRowMs: openMs + rowCountMs + ttfrMs,
    parquetExtension,
  }
}

async function runQuery(request: QueryRequest): Promise<unknown> {
  const started = performance.now()
  const table = await requireConnection().query(request.sql)
  return { ms: performance.now() - started, rows: table.numRows }
}

/** Diagnostic OPFS round-trip (the m4-2 export path needs OPFS). */
async function opfsProbe(): Promise<unknown> {
  const result: Record<string, unknown> = { available: false }
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      result['reason'] = 'navigator.storage.getDirectory is unavailable'
      result['storageManager'] = typeof navigator.storage
      return result
    }
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('assay-spike', { create: true })
    const handle = await dir.getFileHandle('probe.bin', { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Uint8Array([1, 2, 3, 4]))
    await writable.close()
    const read = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    result['available'] = true
    result['wroteBytes'] = read.byteLength
    result['roundTrip'] = read.byteLength === 4 && read[0] === 1 && read[3] === 4
    await dir.removeEntry('probe.bin')
    try {
      result['estimate'] = await navigator.storage.estimate()
    } catch {
      // estimate() is optional; its absence must not fail the probe.
    }
  } catch (error) {
    result['reason'] = error instanceof Error ? error.message : String(error)
  }
  return result
}

scope.addEventListener('message', (event) => {
  const request = event.data
  void (async () => {
    try {
      switch (request.kind) {
        case 'boot':
          respond(request.id, await boot(request))
          break
        case 'open':
          respond(request.id, await openFixture(request))
          break
        case 'query':
          respond(request.id, await runQuery(request))
          break
        case 'opfsProbe':
          respond(request.id, await opfsProbe())
          break
      }
    } catch (error) {
      fail(request.id, error)
    }
  })()
})
