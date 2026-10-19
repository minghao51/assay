// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared webview engine boot (ptv1-1 seam + ptv1-2 vendored assets, consumed
 * by both the spike harness `main.ts` and the production dataset viewer
 * `dataset.ts` since ptv1-3).
 *
 * The host-side seam is exactly what production uses: the extension's engine
 * worker bundle is fetched and re-exposed as a same-origin `blob:` URL (a
 * cross-origin `new Worker(...)` throws in the desktop webview — R4 Q1a), the
 * DuckDB glue + WASM + vendored extensions likewise, and the blob URLs
 * are posted to the worker as one `engine/assets` control message BEFORE the
 * client's first `engine/init` (the ptv1-1 injected mode). The mvp glue worker
 * is the UNMODIFIED vendored binary with the ptv1-2 vendored-asset shim
 * appended as text (checksummed, local-first — zero network fetches).
 */
import { DuckDbEngineClient } from '@assay/engine-duckdb'
import type { EngineAssetsMessage } from '@assay/engine-duckdb/worker-core'

/** One engine-worker progress/error line (kept for diagnosability). */
export interface WorkerDiagnostic {
  readonly source: string
  readonly message: string
}

/** Fetch a webview resource and re-expose it as a same-origin blob URL. */
export async function toBlobUrl(url: string, mimeType?: string): Promise<string> {
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

/**
 * The vendored-asset glue shim (ptv1-2). Emitted as SOURCE and APPENDED to
 * the unmodified vendored glue text — the pinned `duckdb-browser-mvp.worker.js`
 * bytes are never altered. Self-contained ES5-style code: it must survive as
 * verbatim text inside a classic worker.
 *
 * Local-first extension serving: when DuckDB requests a vendored extension
 * binary from the CDN autoload URL, the shim answers the request
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
export function buildGlueShimSource(constants: {
  blockedHost: string
  /** Vendored extension URLs and their engine-version-specific autoload paths. */
  extensions?: readonly { extensionPath: string; extensionUrl: string }[]
  /** Legacy single-extension fields used by the Parquet-only spike harness. */
  extensionPath?: string
  extensionUrl?: string
  drill: boolean
}): string {
  const extensions =
    constants.extensions ??
    (constants.extensionPath !== undefined && constants.extensionUrl !== undefined
      ? [{ extensionPath: constants.extensionPath, extensionUrl: constants.extensionUrl }]
      : [])
  const config = JSON.stringify({ ...constants, extensions })
  return `;(function () {
  var cfg = ${config}
  var extensionBytes = Object.create(null)
  var state = { status: 'pending', detail: '' }
  function isBlocked(url) {
    try {
      return new URL(String(url), self.location.href).host === cfg.blockedHost
    } catch (_e) {
      return String(url).indexOf(cfg.blockedHost) !== -1
    }
  }
  function extensionForUrl(url) {
    if (cfg.drill) return null
    try {
      var u = new URL(String(url), self.location.href)
      if (u.host !== cfg.blockedHost) return null
      for (var i = 0; i < cfg.extensions.length; i++) {
        if (u.pathname === cfg.extensions[i].extensionPath) return cfg.extensions[i]
      }
      return null
    } catch (_e) {
      return null
    }
  }
  function refuse(url) {
    throw new Error('assay-netblock-refusal: network fetch refused by vendored-asset harness: ' + String(url))
  }
  function serveLocally(extension) {
    var bytes = extensionBytes[extension.extensionPath]
    return new Response(bytes.slice(0), {
      status: 200,
      headers: { 'Content-Type': 'application/wasm' },
    })
  }
  var nativeFetch = self.fetch
  self.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input)
    var extension = extensionForUrl(url)
    if (extension !== null && extensionBytes[extension.extensionPath]) return Promise.resolve(serveLocally(extension))
    if (isBlocked(url)) refuse(url)
    return nativeFetch.call(self, input, init)
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    // Minimal synchronous XHR fake for the vendored URL: the emscripten HTTP
    // helper calls open(method,url,false) + send(null) and then reads
    // status/response inline, so the fake can populate them synchronously.
    function VendoredXHR() {}
    VendoredXHR.prototype.open = function (method, url) {
      this._extension = extensionForUrl(url)
      this._blocked = this._extension !== null && !!extensionBytes[this._extension.extensionPath]
      if (!this._blocked && isBlocked(url)) refuse(url)
    }
    VendoredXHR.prototype.setRequestHeader = function () {}
    VendoredXHR.prototype.send = function () {
      if (this._blocked) {
        this.status = 200
        this.response = extensionBytes[this._extension.extensionPath].slice(0)
      }
    }
    VendoredXHR.prototype.getResponseHeader = function () {
      return null
    }
    var nativeOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url) {
      if (extensionForUrl(url) !== null) {
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
    if (cfg.drill || cfg.extensions.length === 0) {
      state.status = 'skipped-drill'
      return writeStateFile()
    }
    return Promise.all(cfg.extensions.map(function (extension) {
      return fetch(extension.extensionUrl).then(function (r) {
        if (!r.ok) throw new Error('vendored extension fetch failed: ' + String(r.status))
        return r.arrayBuffer()
      }).then(function (bytes) {
        extensionBytes[extension.extensionPath] = bytes
      })
    })).then(function () {
      state.status = 'ready'
      state.detail = 'vendored ' + String(cfg.extensions.length) + ' extensions in hand'
    }).then(
      function () { return writeStateFile() },
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
export async function buildShimmedGlueBlobUrl(
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

/** Raw worker progress/error lines land in the supplied sink. */
export function attachDiagnostics(
  worker: Worker,
  label: string,
  sink: Array<WorkerDiagnostic>,
): void {
  worker.addEventListener('message', (event) => {
    const data = event.data as { kind?: string; message?: string }
    if (data?.kind === 'progress' && data.message !== undefined) {
      sink.push({ source: label, message: data.message })
    }
  })
  worker.addEventListener('error', (event) => {
    sink.push({ source: label, message: `error: ${event.message}` })
  })
  worker.addEventListener('messageerror', () => {
    sink.push({ source: label, message: 'messageerror' })
  })
}

/**
 * Build the real adapter over a blob-URL-bootstrapped engine worker. This is
 * the host-side half of the ptv1-1 seam: the worker bundle is fetched from its
 * webview resource URI and re-exposed as a same-origin blob, and the DuckDB
 * asset blob URLs are posted as the FIRST message the worker receives, so the
 * shared core's injected mode resolves before the client's `engine/init`.
 */
export function createAdapterClient(
  workerBlobUrl: string,
  assets: EngineAssetsMessage,
  label: string,
  diagnostics: Array<WorkerDiagnostic> = [],
): DuckDbEngineClient {
  return new DuckDbEngineClient({
    workerFactory: () => {
      const worker = new Worker(workerBlobUrl, { type: 'module' })
      attachDiagnostics(worker, label, diagnostics)
      worker.postMessage(assets)
      return worker
    },
  })
}

/** Boot the real adapter and time it (the Q1 boot envelope). */
export async function bootAdapter(client: DuckDbEngineClient): Promise<unknown> {
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

/** What a host must hand the boot to start the vendored engine in a webview. */
export interface EngineBootSpec {
  /** Webview URI of the injected engine-worker bundle (dist/webview/worker.js). */
  readonly workerEntryUrl: string
  /** Webview URI of the vendored DuckDB-WASM mvp glue worker. */
  readonly mvpGlueUrl: string
  /** Webview URI of the vendored duckdb-mvp.wasm. */
  readonly mvpWasmUrl: string
  /** Webview URIs and CDN paths for the vendored DuckDB extensions. */
  readonly vendoredExtensions: readonly {
    readonly url: string
    readonly autoloadPath: string
  }[]
  /** The CDN host that must never be fetched (the ptv1-2 block). */
  readonly blockedHost: string
}

/** A booted vendored engine: the real client plus its blob-URL bookkeeping. */
export interface VendoredEngineBoot {
  readonly client: DuckDbEngineClient
  /** `blob:` URLs backing the boot; dispose() revokes them (early revoke is safe/idempotent). */
  readonly blobUrls: readonly string[]
  dispose(): Promise<void>
}

/**
 * One-shot production boot of the vendored engine (the ptv1-1 seam + ptv1-2
 * vendored serve) for the dataset viewer. The spike keeps its own measured
 * boot sequence (per-step evidence + heap samples); this composes the same
 * primitives for the product path. Throws on any boot failure — the host maps
 * that to the typed `engine-failed` error surfaced in the webview.
 */
export async function bootVendoredEngine(
  spec: EngineBootSpec,
  diagnostics: Array<WorkerDiagnostic> = [],
): Promise<VendoredEngineBoot> {
  const workerBlobUrl = await toBlobUrl(spec.workerEntryUrl, 'text/javascript')
  const extensionBlobUrls = await Promise.all(
    spec.vendoredExtensions.map((extension) => toBlobUrl(extension.url, 'application/wasm')),
  )
  const glueBlobUrl = await buildShimmedGlueBlobUrl(spec.mvpGlueUrl, {
    blockedHost: spec.blockedHost,
    extensions: spec.vendoredExtensions.map((extension, index) => ({
      extensionPath: extension.autoloadPath,
      extensionUrl: extensionBlobUrls[index]!,
    })),
    drill: false,
  })
  const wasmBlobUrl = await toBlobUrl(spec.mvpWasmUrl, 'application/wasm')
  const client = createAdapterClient(
    workerBlobUrl,
    {
      type: 'engine/assets',
      duckdbWorkerUrl: glueBlobUrl,
      duckdbWasmUrl: wasmBlobUrl,
    },
    'mvp',
    diagnostics,
  )
  const blobUrls = [workerBlobUrl, ...extensionBlobUrls, glueBlobUrl, wasmBlobUrl]
  try {
    await client.ensureReady()
  } catch (error) {
    for (const url of blobUrls) URL.revokeObjectURL(url)
    await client.dispose().catch(() => undefined)
    throw error
  }
  return {
    client,
    blobUrls,
    dispose: async () => {
      for (const url of blobUrls) URL.revokeObjectURL(url)
      await client.dispose()
    },
  }
}
