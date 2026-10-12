// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spike webview main thread (ptv-1 harness; engine path re-wired by ptv1-1).
 * Collects the R4 evidence that must come from the webview origin itself
 * (cross-origin isolation, COOP/COEP resource headers, File System Access API
 * availability, OPFS reachability, main-thread heap) and drives the engine
 * through the REAL `@assay/engine-duckdb` adapter. Results are posted back to
 * the extension host, which writes them to the run's evidence JSON.
 *
 * ptv1-1 (the bundler-agnostic worker seam): the R4 spike's own engine boot
 * code is gone. The mvp/eh boots, the fixture open, the row count, the first
 * window, and the Parquet-extension probe all run through the real
 * `DuckDbEngineClient` and the real shared worker core
 * (`@assay/engine-duckdb/worker-core`, started injected by
 * `webview/worker.ts`). The host-side seam is exactly what production will use:
 * the extension worker bundle is fetched and re-exposed as a same-origin
 * `blob:` URL, the DuckDB glue + WASM likewise, and the blob URLs are posted
 * to the worker as one `engine/assets` control message BEFORE the client's
 * first `engine/init` (the factory below owns that ordering).
 *
 * ptv1-2 (vendored engine assets, local-first): the `mvp` glue worker is now
 * bootstrapped from the COMMITTED vendored binary (assets/duckdb/, checksum
 * pinned by scripts/build.mjs) with a shim APPENDED to the unmodified glue
 * text — the pinned bytes are not altered. The shim (a) after DuckDB
 * instantiation takes the vendored Parquet extension bytes in hand (fetched
 * from the extension package over the local webview resource path) and (b)
 * answers the Q5b CDN autoload URL (`extensions.duckdb.org/…/wasm_mvp/
 * parquet.duckdb_extension.wasm`) LOCALLY from those bytes, refusing every
 * other request to that host — so datasets open with ZERO network fetches.
 * (Registering the binary into the engine FS + INSTALL/LOAD was tried first;
 * the extension loader's existence check does not see registered buffers in
 * 1.32.0 — see assets/duckdb/VENDORED_ASSETS.md.) Drill mode
 * (`ASSAY_SPIKE_DRILL=missing-extension`) ships no vendored bytes: the open
 * must then FAIL on the refused CDN fetch, reproducing the Q5b failure mode
 * under the block and proving the negative (a non-vendored asset WOULD
 * fetch — and be caught).
 *
 * Worker-loading finding baked in here: `new Worker(webview.asWebviewUri(...))`
 * throws a cross-origin error in a desktop webview (the resource is served from
 * `https://file+.vscode-resource.vscode-cdn.net` while the document origin is
 * `vscode-webview://…`). The harness records that failure and then uses the
 * documented workaround — fetch each script/WASM as a Blob and construct the
 * worker from a same-origin `blob:` URL. Both the failure and the workaround
 * are measured, not assumed.
 *
 * Everything here is spike-only and value-free: the only dataset-derived
 * values in the report are one fixture row's id/bucket/label shape check —
 * enough to prove a real window was returned, not a data dump.
 */
import { DuckDbEngineClient } from '@assay/engine-duckdb'
import type { EngineAssetsMessage } from '@assay/engine-duckdb/worker-core'

interface BundleUrls {
  readonly workerUrl: string
  readonly wasmUrl: string
}

interface SpikeConfig {
  readonly target: string
  readonly vscodeVersion: string
  readonly mainScriptUrl: string
  readonly workerScriptUrl: string
  readonly probeUrl: string
  readonly bundles: {
    readonly mvp: BundleUrls
    readonly eh: BundleUrls
  }
  /** ptv1-2: the vendored Parquet extension served from the extension package. */
  readonly vendoredExtension: {
    readonly fileName: string
    readonly url: string
    readonly duckdbVersion: string
    /** The CDN URL path the shim serves locally (DuckDB-version specific). */
    readonly autoloadPath: string
  }
  /** ptv1-2: the CDN host the harness network-blocks (Q5b, pinned fixed). */
  readonly blockedExtensionHost: string
  /** ptv1-2 drill: skip the local install so the CDN path is exercised (and refused). */
  readonly drill: boolean
}

declare global {
  interface Window {
    __ASSAY_SPIKE_CONFIG__: SpikeConfig
  }
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

const config = window.__ASSAY_SPIKE_CONFIG__
const vscodeApi = acquireVsCodeApi()

const results: Record<string, unknown> = {
  target: config.target,
  vscodeVersion: config.vscodeVersion,
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
}
const heap: Record<string, Record<string, number>> = { preBoot: heapSample() }
results['heap'] = heap

/** Raw worker progress/error lines, kept so a wedged boot is diagnosable. */
const diagnostics: Array<{ source: string; message: string }> = []
results['workerDiagnostics'] = diagnostics

function attachDiagnostics(worker: Worker, label: string): void {
  worker.addEventListener('message', (event) => {
    const data = event.data as { kind?: string; message?: string }
    if (data?.kind === 'progress' && data.message !== undefined) {
      diagnostics.push({ source: label, message: data.message })
    }
  })
  worker.addEventListener('error', (event) => {
    diagnostics.push({ source: label, message: `error: ${event.message}` })
  })
  worker.addEventListener('messageerror', () => {
    diagnostics.push({ source: label, message: 'messageerror' })
  })
}

function setStatus(message: string): void {
  const el = document.getElementById('status')
  if (el !== null) {
    el.textContent = message
  }
}

function heapSample(): Record<string, number> {
  // Force a GC when the launch flags expose it, so the sample reflects live
  // memory rather than the just-revoked blob allocations.
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') {
    gc()
  }
  const memory = (
    performance as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }
  ).memory
  return memory === undefined
    ? {}
    : {
        usedBytes: memory.usedJSHeapSize,
        totalBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      }
}

async function step(name: string, attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    setStatus(name)
    return await attempt()
  } catch (error) {
    const errors = (results['errors'] ??= {}) as Record<string, string>
    errors[name] = error instanceof Error ? error.message : String(error)
    return undefined
  }
}

/** Fetch a webview resource and re-expose it as a same-origin blob URL. */
async function toBlobUrl(url: string, mimeType?: string): Promise<string> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: ${String(response.status)}`)
  }
  // `response.blob()` keeps the bytes in the browser's blob store instead of a
  // JS ArrayBuffer; `slice` re-types without copying, so the main-thread JS
  // heap stays comparable to the G1-R web numbers.
  const blob = await response.blob()
  const typed =
    mimeType === undefined || blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType)
  return URL.createObjectURL(typed)
}

/** Same-origin fetch of a webview resource, read for the host's COOP/COEP headers. */
async function probeResourceHeaders(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      crossOriginOpenerPolicy: response.headers.get('cross-origin-opener-policy'),
      crossOriginEmbedderPolicy: response.headers.get('cross-origin-embedder-policy'),
      crossOriginResourcePolicy: response.headers.get('cross-origin-resource-policy'),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The vendored-asset glue shim (ptv1-2). Emitted as SOURCE and APPENDED to
 * the unmodified vendored glue text — the pinned `duckdb-browser-mvp.worker.js`
 * bytes are never altered. Self-contained ES5-style code: it must survive as
 * verbatim text inside a classic worker.
 *
 * Local-first extension serving: when DuckDB requests the Parquet extension
 * binary from the CDN (the Q5b autoload URL), the shim answers the request
 * LOCALLY with the vendored bytes — `fetch` gets a synthesized `Response`,
 * the emscripten XHR helper gets a minimal synchronous fake — so the engine
 * consumes the official vendored binary with ZERO network traffic. Any other
 * request to the blocked host is refused outright (`assay-netblock-refusal`).
 * Drill mode has no vendored bytes: the CDN path runs into the refusal and
 * the fixture open reproduces the Q5b failure mode under the block.
 *
 * (Design note: registering the vendored binary into DuckDB's virtual
 * filesystem and running `INSTALL`/`LOAD` locally was tried first and works
 * for direct file reads (read_csv resolves registered buffers), but the
 * extension loader's own existence check does not see registered buffers in
 * DuckDB-WASM 1.32.0 and falls through to its HTTP filesystem. The local
 * serve answers at the network boundary instead — independent of the
 * engine's FS semantics, and the bytes on the wire are literally none.)
 */
function buildGlueShimSource(constants: {
  blockedHost: string
  /** The autoload URL path the shim serves locally (engine-version specific). */
  extensionPath: string
  /** Blob URL of the vendored extension bytes ('' in drill mode). */
  extensionUrl: string
  drill: boolean
}): string {
  const config = JSON.stringify(constants)
  return `;(function () {
  var cfg = ${config}
  var extensionBytes = null
  var state = { status: 'pending', detail: '' }
  function isBlocked(url) {
    try {
      return new URL(String(url), self.location.href).host === cfg.blockedHost
    } catch (_e) {
      return String(url).indexOf(cfg.blockedHost) !== -1
    }
  }
  function isVendoredExtensionUrl(url) {
    if (extensionBytes === null || cfg.drill) return false
    try {
      var u = new URL(String(url), self.location.href)
      return u.host === cfg.blockedHost && u.pathname === cfg.extensionPath
    } catch (_e) {
      return false
    }
  }
  function refuse(url) {
    throw new Error('assay-netblock-refusal: network fetch refused by vendored-asset harness: ' + String(url))
  }
  function serveLocally() {
    return new Response(extensionBytes.slice(0), {
      status: 200,
      headers: { 'Content-Type': 'application/wasm' },
    })
  }
  var nativeFetch = self.fetch
  self.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input)
    if (isVendoredExtensionUrl(url)) return Promise.resolve(serveLocally())
    if (isBlocked(url)) refuse(url)
    return nativeFetch.call(self, input, init)
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    // Minimal synchronous XHR fake for the vendored URL: the emscripten HTTP
    // helper calls open(method,url,false) + send(null) and then reads
    // status/response inline, so the fake can populate them synchronously.
    function VendoredXHR() {}
    VendoredXHR.prototype.open = function (method, url) {
      this._blocked = isVendoredExtensionUrl(url)
      if (!this._blocked && isBlocked(url)) refuse(url)
    }
    VendoredXHR.prototype.setRequestHeader = function () {}
    VendoredXHR.prototype.send = function () {
      if (this._blocked) {
        this.status = 200
        this.response = extensionBytes.slice(0)
      }
    }
    VendoredXHR.prototype.getResponseHeader = function () {
      return null
    }
    var nativeOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isVendoredExtensionUrl(url)) {
        // Serve: swap in the fake instance semantics by rerouting open/send.
        var fake = new VendoredXHR()
        fake.open(method, url)
        var nativeSend = XMLHttpRequest.prototype.send
        this.send = function () {
          fake.send()
        }
        this.setRequestHeader = function () {}
        this.getResponseHeader = function () {
          return null
        }
        var self2 = this
        Object.defineProperty(this, 'status', { value: 200 })
        Object.defineProperty(this, 'response', {
          set: function (_v) {},
          get: function () {
            return fake.response
          },
        })
        void nativeSend
        return
      }
      if (isBlocked(url)) refuse(url)
      try {
        return nativeOpen.apply(this, arguments)
      } catch (openError) {
        // Diagnostic: the URL that failed native open reaches the report via
        // the query error path (shim-thrown errors propagate to the client).
        throw new Error(
          'assay-xhr-open-failed url=' + String(url) + ' :: ' + String(openError && openError.message),
        )
      }
    }
  }
  var originalOnMessage = self.onmessage
  var gated = false
  var gating = false
  var queued = []
  function writeStateFile() {
    // Diagnostic channel: a tiny CSV the webview can read through DuckDB's
    // (statically linked) read_csv, since shim globals are unreachable from
    // the main thread. Registered through the glue's own protocol message.
    try {
      var csv = 'status,detail\\n' + JSON.stringify(state.status) + ',' + JSON.stringify(state.detail) + '\\n'
      return originalOnMessage({
        data: { type: 'REGISTER_FILE_BUFFER', data: ['/assay-shim-state.csv', new TextEncoder().encode(csv)] },
      })
    } catch (e) {
      state.status = 'state-file-register-threw'
      state.detail = String(e && e.message)
      return Promise.resolve()
    }
  }
  function loadVendoredBytes() {
    if (cfg.drill || !cfg.extensionUrl) {
      state.status = 'skipped-drill'
      return writeStateFile()
    }
    return fetch(cfg.extensionUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('vendored extension fetch failed: ' + String(r.status))
        return r.arrayBuffer()
      })
      .then(function (bytes) {
        extensionBytes = bytes
        state.status = 'ready'
        state.detail = 'vendored ' + String(bytes.byteLength) + ' bytes in hand (serve on ' + cfg.extensionPath + ')'
      })
      .then(
        function () {
          return writeStateFile()
        },
        function (error) {
          state.status = 'failed'
          state.detail = String(error && error.message)
          return writeStateFile()
        },
      )
  }
  function dispatch(event) {
    var type = event && event.data ? event.data.type : undefined
    if (type === 'INSTANTIATE' && !gated && !gating) {
      gating = true
      Promise.resolve(originalOnMessage(event))
        .then(loadVendoredBytes)
        .catch(function (error) {
          // Surface at the SQL/serve layer: without the vendored bytes the
          // CDN path is refused and the fixture open fails loudly.
          state.status = 'failed'
          state.detail = String(error && error.message)
        })
        .then(function () {
          gated = true
          gating = false
          var pending = queued.splice(0, queued.length)
          for (var i = 0; i < pending.length; i++) originalOnMessage(pending[i])
        })
      return
    }
    originalOnMessage(event)
  }
  self.onmessage = function (event) {
    if (gating) {
      queued.push(event)
      return
    }
    dispatch(event)
  }
})()`
}

/**
 * Build the mvp glue worker as a same-origin blob: the UNMODIFIED vendored
 * glue text with the ptv1-2 shim appended (see buildGlueShimSource). The
 * pinned asset bytes themselves are not altered — the shim is concatenation
 * only, and scripts/build.mjs verifies the committed bytes' checksums.
 */
async function buildShimmedGlueBlobUrl(
  glueUrl: string,
  constants: Parameters<typeof buildGlueShimSource>[0],
): Promise<string> {
  const response = await fetch(glueUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`fetch ${glueUrl} failed: ${String(response.status)}`)
  }
  const glueText = await response.text()
  const shimmed = glueText + '\n' + buildGlueShimSource(constants)
  return URL.createObjectURL(new Blob([shimmed], { type: 'text/javascript' }))
}

/**
 * ptv1-2: verify the vendored-asset serve state and record the evidence.
 * The shim answers the CDN autoload URL locally with the vendored bytes, so
 * there is nothing to INSTALL: the extension state after the open is the
 * Q5b signature (loaded=true, installed=false) — but earned with ZERO
 * network, which the drill run proves (no vendored bytes → the open fails
 * on the refused CDN fetch).
 */
async function verifyVendoredServe(
  client: DuckDbEngineClient,
  config: SpikeConfig,
): Promise<Record<string, unknown>> {
  if (config.drill) {
    return {
      drill: 'missing-extension (no vendored bytes; CDN blocked — Q5b reproduced on open)',
      blockedHost: config.blockedExtensionHost,
      extensionFile: config.vendoredExtension.fileName,
      autoloadPath: config.vendoredExtension.autoloadPath,
    }
  }
  // The glue shim's own state, read back through DuckDB's statically linked
  // read_csv: proves the vendored bytes were fetched (from the local blob)
  // before any query ran.
  let shimState = 'unreadable'
  try {
    const stateTable = await client.query(
      "SELECT status, detail FROM read_csv('/assay-shim-state.csv', header = true)",
    )
    shimState = `${String(stateTable.batch.getChildAt(0)?.get(0))}: ${String(stateTable.batch.getChildAt(1)?.get(0))}`
  } catch (error) {
    shimState = `unreadable (${error instanceof Error ? error.message : String(error)})`
  }
  const probe = await client.query(
    "SELECT extension_name, loaded, installed FROM duckdb_extensions() WHERE extension_name = 'parquet'",
  )
  return {
    drill: false,
    extensionFile: config.vendoredExtension.fileName,
    autoloadPath: config.vendoredExtension.autoloadPath,
    duckdbVersion: config.vendoredExtension.duckdbVersion,
    blockedHost: config.blockedExtensionHost,
    // Two independent network-block layers; the vendored run must pass under both.
    networkBlock:
      'CSP connect-src excludes the host + in-worker fetch/XHR interceptor serves the vendored bytes locally',
    shimState,
    installed: Boolean(probe.batch.getChildAt(2)?.get(0)),
    loaded: Boolean(probe.batch.getChildAt(1)?.get(0)),
  }
}

/** Wait for the extension host to post the fixture bytes. */
function waitForFixture(): Promise<{ name: string; bytes: ArrayBuffer }> {
  return new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      const data = event.data as { kind?: string; name?: string; bytes?: ArrayBuffer }
      if (data?.kind === 'fixture' && data.name !== undefined && data.bytes !== undefined) {
        resolve({ name: data.name, bytes: data.bytes })
      }
    })
  })
}

/**
 * Build the real adapter over a blob-URL-bootstrapped engine worker. This is
 * the host-side half of the ptv1-1 seam: the worker bundle is fetched from its
 * webview resource URI and re-exposed as a same-origin blob (a cross-origin
 * `new Worker(...)` throws in the webview — Q1a), and the DuckDB asset blob
 * URLs are posted as the FIRST message the worker receives, so the shared
 * core's injected mode resolves before the client's `engine/init`.
 */
function createAdapterClient(
  workerBlobUrl: string,
  label: 'mvp' | 'eh',
  assets: EngineAssetsMessage,
): DuckDbEngineClient {
  return new DuckDbEngineClient({
    workerFactory: () => {
      const worker = new Worker(workerBlobUrl, { type: 'module' })
      attachDiagnostics(worker, label)
      worker.postMessage(assets)
      return worker
    },
  })
}

/** Boot the real adapter and time it (the Q1 boot envelope). */
async function bootAdapter(client: DuckDbEngineClient): Promise<unknown> {
  const started = performance.now()
  const ready = await client.ensureReady()
  return {
    ok: true,
    bootMs: performance.now() - started,
    version: ready.duckdbVersion,
    // Evidence that the harness exercised the real adapter, not spike-local code.
    adapter: '@assay/engine-duckdb',
  }
}

/**
 * Register the fixture bytes through the real adapter and time
 * open → count → first row (the Q5 envelope, same methodology as the R4
 * spike: pickerToFirstRowMs is the sum of the three engine phases).
 */
async function openFixtureThroughAdapter(
  client: DuckDbEngineClient,
  fixture: { name: string; bytes: ArrayBuffer },
): Promise<unknown> {
  const fixtureFile = new File([fixture.bytes], fixture.name)
  const bytes = fixture.bytes.byteLength

  const openStarted = performance.now()
  const handle = await client.open({
    name: fixture.name,
    getFile: () => Promise.resolve(fixtureFile),
  })
  const openMs = performance.now() - openStarted

  const countStarted = performance.now()
  const rows = await client.rowCount(handle)
  const rowCountMs = performance.now() - countStarted

  // Record the runtime extension dependency (`read_parquet` autoloads the
  // Parquet extension from extensions.duckdb.org in DuckDB-WASM 1.32.0) —
  // through the real adapter's SQL surface, same evidence as the R4 spike.
  let parquetExtension: unknown = null
  try {
    const extTable = await client.query(
      "SELECT extension_name, loaded, installed FROM duckdb_extensions() WHERE extension_name = 'parquet'",
    )
    parquetExtension = {
      name: String(extTable.batch.getChildAt(0)?.get(0) ?? ''),
      loaded: Boolean(extTable.batch.getChildAt(1)?.get(0)),
      installed: Boolean(extTable.batch.getChildAt(2)?.get(0)),
    }
  } catch (error) {
    parquetExtension = { error: error instanceof Error ? error.message : String(error) }
  }

  const firstRowStarted = performance.now()
  const windowTable = await client.fetchRange(handle, {
    startRow: 0,
    endRow: 1000,
    columns: ['id', 'bucket', 'label'],
  })
  const ttfrMs = performance.now() - firstRowStarted
  const firstRow = {
    id: String(windowTable.batch.getChildAt(0)?.get(0) ?? ''),
    bucket: String(windowTable.batch.getChildAt(1)?.get(0) ?? ''),
    label: String(windowTable.batch.getChildAt(2)?.get(0) ?? ''),
  }

  return {
    bytes,
    rows,
    openMs,
    rowCountMs,
    ttfrMs,
    ttfrRows: windowTable.batch.numRows,
    firstRow,
    pickerToFirstRowMs: openMs + rowCountMs + ttfrMs,
    parquetExtension,
  }
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

async function run(): Promise<void> {
  // Environment / capability probes that need no worker.
  results['environment'] = {
    origin: location.origin,
    protocol: location.protocol,
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: (navigator as { deviceMemory?: number }).deviceMemory,
    performanceMemory: typeof (performance as { memory?: unknown }).memory !== 'undefined',
    storageManager: typeof navigator.storage,
    storageGetDirectory: typeof navigator.storage?.getDirectory === 'function',
    workerConstructor: typeof Worker !== 'undefined',
  }
  results['fileSystemAccess'] = {
    showOpenFilePicker:
      typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function',
    showSaveFilePicker:
      typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    showDirectoryPicker:
      typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
    fileSystemHandle:
      typeof (globalThis as { FileSystemHandle?: unknown }).FileSystemHandle !== 'undefined',
  }
  results['resourceHeaders'] = await probeResourceHeaders(config.probeUrl)

  const fixturePromise = waitForFixture()
  vscodeApi.postMessage({ kind: 'ready' })

  // Q1a: can a worker be constructed directly from an `asWebviewUri` script?
  const direct: Record<string, unknown> = { attempted: true }
  try {
    const worker = new Worker(config.workerScriptUrl, { type: 'module' })
    worker.terminate()
    direct['ok'] = true
  } catch (error) {
    direct['ok'] = false
    direct['error'] = error instanceof Error ? error.message : String(error)
  }
  results['workerDirectConstruction'] = direct

  // Q1b: blob-URL bootstrap for the REAL engine adapter's worker bundle.
  const workerUrl = await step('worker.blobUrl', () =>
    toBlobUrl(config.workerScriptUrl, 'text/javascript'),
  )
  if (typeof workerUrl !== 'string') {
    results['fixture'] = { blockedBy: 'worker.blobUrl' }
    results['opfs'] = { blockedBy: 'worker.blobUrl' }
    finish()
    return
  }
  results['workerBlobUrl'] = { ok: true }

  const bundles = (results['bundles'] = {}) as Record<string, unknown>

  // Q1c: the real adapter boots the `mvp` DuckDB bundle inside the webview —
  // the blob-URL asset injection the ptv1-1 seam exists for. The blob URLs are
  // revoked once instantiate() has consumed them (the spike's Q5 methodology:
  // the heap sample must reflect the dataset, not the workaround).
  // ptv1-2: the mvp glue worker is the vendored binary with the vendored-asset
  // shim appended (CDN block + local extension registration). The DuckDB WASM
  // itself stays a plain blob of the vendored bytes.
  // The vendored extension is fetched HERE (main thread — the proven
  // toBlobUrl path) and re-exposed as a same-origin blob for the shim:
  // direct worker-side fetches of vscode-webview-resource URLs 404 (they
  // route differently), while blob: fetches inside the glue worker are
  // exactly how DuckDB instantiation consumes its WASM. Drill mode passes
  // no bytes at all — the stock CDN path must run (and hit the block).
  const extensionBlobUrl = config.drill
    ? undefined
    : await toBlobUrl(config.vendoredExtension.url, 'application/wasm')
  if (!config.drill && typeof extensionBlobUrl !== 'string') {
    results['fixture'] = { blockedBy: 'vendored.extensionBlobUrl' }
    results['opfs'] = { blockedBy: 'vendored.extensionBlobUrl' }
    finish()
    return
  }
  const mvpGlueBlobUrl = await step('glue.shimmedBlobUrl', () =>
    buildShimmedGlueBlobUrl(config.bundles.mvp.workerUrl, {
      blockedHost: config.blockedExtensionHost,
      extensionUrl: extensionBlobUrl ?? '',
      extensionPath: config.vendoredExtension.autoloadPath,
      drill: config.drill,
    }),
  )
  if (typeof mvpGlueBlobUrl !== 'string') {
    results['fixture'] = { blockedBy: 'glue.shimmedBlobUrl' }
    results['opfs'] = { blockedBy: 'glue.shimmedBlobUrl' }
    finish()
    return
  }
  const mvpAssets: EngineAssetsMessage = {
    type: 'engine/assets',
    duckdbWorkerUrl: mvpGlueBlobUrl,
    duckdbWasmUrl: await toBlobUrl(config.bundles.mvp.wasmUrl, 'application/wasm'),
  }
  const mvpClient = createAdapterClient(workerUrl, 'mvp', mvpAssets)
  const mvpBoot = await step('boot.mvp', () => bootAdapter(mvpClient))
  bundles['mvp'] = mvpBoot ?? { ok: false, note: 'see errors["boot.mvp"]' }
  URL.revokeObjectURL(mvpAssets.duckdbWorkerUrl)
  URL.revokeObjectURL(mvpAssets.duckdbWasmUrl)
  if (typeof extensionBlobUrl === 'string') {
    URL.revokeObjectURL(extensionBlobUrl)
  }
  heap['postBoot'] = heapSample()

  if (mvpBoot !== undefined) {
    // ptv1-2: local-first extension install (skipped in drill mode), BEFORE
    // the fixture open so read_parquet never needs the CDN.
    const vendored = await step('vendored.serve', () => verifyVendoredServe(mvpClient, config))
    if (vendored !== undefined) {
      results['vendoredAssets'] = vendored
    }
    const fixture = await fixturePromise
    const opened = await step('open.million', () => openFixtureThroughAdapter(mvpClient, fixture))
    if (opened !== undefined) {
      results['fixture'] = opened
    }
    heap['postFirstRow'] = heapSample()
  } else {
    results['fixture'] = { blockedBy: 'boot.mvp' }
  }
  results['opfs'] = await step('opfs', () => opfsProbe())
  await step('dispose.mvp', () => mvpClient.dispose())

  // Q1d: probe the `eh` (exception-handling) bundle in a fresh adapter worker.
  // Measured result: it boots without cross-origin isolation, like `mvp`; only
  // the separate `coi` (threads) bundle would require it (not probed). The mvp
  // client is disposed first so the two ~40 MB WASM heaps do not coexist.
  const ehAssets: EngineAssetsMessage = {
    type: 'engine/assets',
    duckdbWorkerUrl: await toBlobUrl(config.bundles.eh.workerUrl, 'text/javascript'),
    duckdbWasmUrl: await toBlobUrl(config.bundles.eh.wasmUrl, 'application/wasm'),
  }
  const ehClient = createAdapterClient(workerUrl, 'eh', ehAssets)
  const ehBoot = await step('boot.eh', () => bootAdapter(ehClient))
  bundles['eh'] = ehBoot ?? { ok: false, note: 'see errors["boot.eh"]' }
  await step('dispose.eh', () => ehClient.dispose())
  URL.revokeObjectURL(ehAssets.duckdbWorkerUrl)
  URL.revokeObjectURL(ehAssets.duckdbWasmUrl)
  URL.revokeObjectURL(workerUrl)

  finish()
}

function finish(): void {
  results['finishedAt'] = new Date().toISOString()
  setStatus('done')
  vscodeApi.postMessage({ kind: 'results', results })
}

void run().catch((error: unknown) => {
  vscodeApi.postMessage({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
})

export {}
