// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bundler-agnostic engine worker core (ptv1-1) — the protocol adapter the
 * engine worker runs, extracted from the former single-file `worker.ts` so a
 * second, esbuild-built entry (the VS Code desktop webview) can boot the SAME
 * core that the Vite web entry boots. One shared worker core, two bundler
 * entries (queue row ptv1-1; R4 report §8/§10 mandatory item 2/3).
 *
 * The core is parameterized by where its DuckDB-WASM asset URLs come from:
 *
 * - `{ source: 'static', urls }` — the bundler resolved them at build time
 *   (Vite `?url` imports; the web entry, `./worker.ts`). Every worker message
 *   is forwarded to the executor exactly as before — behavior is byte-identical
 *   to the pre-extraction worker by construction, and pinned headlessly in
 *   `worker-core.test.ts`.
 * - `{ source: 'injected' }` — the host supplies the URLs at runtime via ONE
 *   `engine/assets` control message posted before the first engine request.
 *   This is the spike-proven webview bootstrap (apps/vscode/webview/main.ts
 *   `toBlobUrl`): a desktop webview cannot construct a Worker from a
 *   cross-origin resource URI, so the host fetches each asset as a blob and
 *   hands the worker same-origin `blob:` URLs. Until the message arrives the
 *   boot simply waits — the host posts assets first thing in its
 *   `workerFactory`, so ordering is host-controlled and the client needs no
 *   protocol change (its default web path posts exactly one `engine/init`).
 *
 * The `engine/assets` message deliberately lives OUTSIDE `./protocol` (the
 * engine client↔worker contract): it is a host→worker control message sent
 * through the host's `workerFactory` seam
 * (`DuckDbEngineClientOptions.workerFactory`), never by the client itself.
 *
 * Everything inside `startEngineWorkerCore` is moved verbatim from the former
 * single-file `worker.ts` (lazy session boot, two-lane `EngineOpExecutor`
 * wiring, OPFS export scratch writes); see that file's history for the T2 /
 * m2-7 / m1-4 / m4-2 reasoning. The boot's only change is that the asset URLs
 * now come from the seam instead of module-scope `?url` imports.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import { EngineOpExecutor } from './engine-executor.js'
import type { EngineSessionLike } from './engine-executor.js'
import type { EngineResponse } from './protocol.js'

/** The two DuckDB-WASM asset URLs the core boots from. */
export interface EngineAssetUrls {
  /** The prebuilt DuckDB glue worker script (`duckdb-browser-mvp.worker.js`). */
  readonly duckdbWorkerUrl: string
  /** The DuckDB WASM module (`duckdb-mvp.wasm`). */
  readonly duckdbWasmUrl: string
}

/**
 * Host→worker control message carrying the injected asset URLs. Posted once,
 * before the first engine request, by the host's worker factory. Not part of
 * `./protocol`: the engine client never sends it (the default web path posts
 * `engine/init` only — pinned by `worker-core.test.ts`).
 */
export interface EngineAssetsMessage {
  readonly type: 'engine/assets'
  readonly duckdbWorkerUrl: string
  readonly duckdbWasmUrl: string
}

/**
 * The slice of the worker global scope the core relies on (kept narrow so
 * headless tests can pass a fake). The transfer list is what makes the Arrow
 * IPC transport zero-copy.
 */
export interface EngineWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(response: EngineResponse, transfer?: ArrayBuffer[]): void
}

/** Where the core's DuckDB asset URLs come from (see module doc). */
export type EngineWorkerCoreAssets =
  { readonly source: 'static'; readonly urls: EngineAssetUrls } | { readonly source: 'injected' }

/** Narrow structural guard for the injected control message. */
export function isEngineAssetsMessage(value: unknown): value is EngineAssetsMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['type'] === 'engine/assets' &&
    typeof record['duckdbWorkerUrl'] === 'string' &&
    typeof record['duckdbWasmUrl'] === 'string'
  )
}

/** The real worker scope, resolved lazily (Node test environments have no `self`). */
function defaultWorkerScope(): EngineWorkerScope {
  // SAFETY: inside a real worker `self` IS the DedicatedWorkerGlobalScope; the
  // package tsconfig uses the DOM lib (where `self` is typed as `Window`), so
  // this narrows once to the EngineWorkerScope subset the core actually uses
  // (message listener + postMessage with the Arrow IPC transfer list). Test
  // environments never call this — they inject a fake scope instead.
  return self as unknown as EngineWorkerScope
}

/**
 * Install the engine worker core on a worker scope. Called once per worker at
 * entry-module top level (web: `./worker.ts` with static asset URLs; VS Code
 * webview: the esbuild entry with injected assets).
 */
export function startEngineWorkerCore(
  assets: EngineWorkerCoreAssets,
  scope: EngineWorkerScope = defaultWorkerScope(),
): void {
  // Injected mode resolves this promise from the `engine/assets` control
  // message. It is awaited inside the boot, so a request that races the
  // assets message parks until the URLs arrive instead of failing (the host
  // posts assets first, making the wait zero-length in practice).
  let resolveInjected: ((urls: EngineAssetUrls) => void) | null = null
  let injected = false
  const assetUrls: Promise<EngineAssetUrls> =
    assets.source === 'static'
      ? Promise.resolve(assets.urls)
      : new Promise<EngineAssetUrls>((resolve) => {
          resolveInjected = resolve
        })

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
    const urls = await assetUrls
    // Classic worker: duckdb's prebuilt glue script (it sets globalThis.onmessage).
    const duckdbWorker = new Worker(urls.duckdbWorkerUrl)
    const booted = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), duckdbWorker)
    try {
      await booted.instantiate(urls.duckdbWasmUrl)
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
    // m4-2 export: COPY writes an engine-generated file into DuckDB's virtual
    // filesystem; the bytes are read back once and moved to OPFS scratch space
    // (see writeExportFileToOpfs). The wasm-side copy is dropped by the executor.
    copyExportBytes: (registeredFileName) =>
      requireDb().then((database) => database.copyFileToBuffer(registeredFileName)),
    writeExportFile: (path, bytes) => writeExportFileToOpfs(path, bytes),
    post: (response, transfer) => scope.postMessage(response, transfer),
  })

  scope.addEventListener('message', (event) => {
    // Injected mode consumes the control message here, before protocol
    // dispatch: the executor must never see it (it is not an `EngineRequest`).
    // Later `engine/assets` messages are swallowed too — the seam resolves
    // exactly once per worker. Static mode (the web entry) forwards EVERY
    // message to the executor, byte-identical to the pre-extraction worker.
    if (assets.source === 'injected' && isEngineAssetsMessage(event.data)) {
      if (!injected) {
        injected = true
        resolveInjected?.({
          duckdbWorkerUrl: event.data.duckdbWorkerUrl,
          duckdbWasmUrl: event.data.duckdbWasmUrl,
        })
        resolveInjected = null
      }
      return
    }
    executor.accept(event.data)
  })
}

/**
 * Write export bytes into OPFS scratch space (ADR 0017 disposable-cache
 * framing) under the generated destination path. Dedicated workers have the
 * same origin OPFS as the page, so exports land next to the staged sources
 * without any main-thread hop. The path is slash-separated; all but the last
 * segment are created as directories.
 */
async function writeExportFileToOpfs(path: string, bytes: Uint8Array): Promise<void> {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const fileName = segments.pop()
  if (fileName === undefined || segments.length === 0) {
    throw new Error(`invalid export destination path: ${JSON.stringify(path)}`)
  }
  let dir = await navigator.storage.getDirectory()
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true })
  }
  let fileHandle: FileSystemFileHandle
  try {
    fileHandle = await dir.getFileHandle(fileName, { create: true })
  } catch {
    // A stale entry of the wrong kind under the engine's own scratch
    // namespace (e.g. left by an interrupted older write) is removed and
    // recreated — this tree is a rebuildable disposable cache (ADR 0017),
    // never user data.
    await dir.removeEntry(fileName, { recursive: true }).catch(() => undefined)
    fileHandle = await dir.getFileHandle(fileName, { create: true })
  }
  const writable = await fileHandle.createWritable()
  // Copy once: the incoming bytes' buffer is transferred/cloned downstream.
  const chunk = new Uint8Array(bytes.byteLength)
  chunk.set(bytes)
  await writable.write(chunk)
  await writable.close()
}
