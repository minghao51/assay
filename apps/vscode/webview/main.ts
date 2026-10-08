// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spike webview main thread (ptv-1). Collects the R4 evidence that must come
 * from the webview origin itself (cross-origin isolation, COOP/COEP resource
 * headers, File System Access API availability, OPFS reachability, main-thread
 * heap) and drives the DuckDB worker. Results are posted back to the extension
 * host, which writes them to the run's evidence JSON.
 *
 * Worker-loading finding baked in here: `new Worker(webview.asWebviewUri(...))`
 * throws a cross-origin error in a desktop webview (the resource is served from
 * `https://file+.vscode-resource.vscode-cdn.net` while the document origin is
 * `vscode-webview://…`). The harness records that failure and then falls back
 * to the documented workaround — fetch each script/WASM as a Blob and construct
 * the worker from a same-origin `blob:` URL. Both the failure and the workaround
 * are measured, not assumed.
 *
 * Everything here is spike-only and value-free: the only dataset-derived
 * values in the report are one fixture row's id/bucket/label shape check —
 * enough to prove a real window was returned, not a data dump.
 */

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

interface WorkerResponse {
  readonly kind: 'response'
  readonly id: number
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

let callSequence = 0

/** Request/response over one worker, with a timeout so a wedged boot cannot hang the run. */
function call(
  worker: Worker,
  request: Record<string, unknown>,
  timeoutMs: number,
  transfer: ArrayBuffer[] = [],
): Promise<unknown> {
  const id = ++callSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error(`worker timeout after ${timeoutMs}ms: ${String(request['kind'])}`))
    }, timeoutMs)
    function onMessage(event: MessageEvent<WorkerResponse>): void {
      const data = event.data
      if (data?.kind !== 'response' || data.id !== id) {
        return
      }
      clearTimeout(timer)
      worker.removeEventListener('message', onMessage)
      if (data.ok) {
        resolve(data.result)
      } else {
        reject(new Error(data.error ?? 'worker returned an unnamed error'))
      }
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ ...request, id }, transfer)
  })
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
 * Blob-wrap a bundle's glue script and WASM, boot it in the worker, then
 * release the blob URLs. Revoking matters for the Q5 heap number: without it
 * the ~39 MB WASM blob stays alive in the renderer and the main-thread heap is
 * dominated by the workaround rather than by the dataset.
 */
async function bootBundle(
  worker: Worker,
  name: 'mvp' | 'eh',
  bundle: BundleUrls,
): Promise<unknown> {
  const glueUrl = await toBlobUrl(bundle.workerUrl, 'text/javascript')
  const wasmUrl = await toBlobUrl(bundle.wasmUrl, 'application/wasm')
  try {
    return await call(
      worker,
      { kind: 'boot', bundle: name, urls: { workerUrl: glueUrl, wasmUrl } },
      90_000,
    )
  } finally {
    URL.revokeObjectURL(wasmUrl)
    URL.revokeObjectURL(glueUrl)
  }
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

  // Q1b: blob-URL workaround for the extension's own worker bundle.
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

  // Q1c: DuckDB-WASM `mvp` boot inside a nested worker.
  const mvpWorker = new Worker(workerUrl, { type: 'module' })
  attachDiagnostics(mvpWorker, 'mvp')
  const mvpBoot = await step('boot.mvp', () => bootBundle(mvpWorker, 'mvp', config.bundles.mvp))
  bundles['mvp'] = mvpBoot ?? { ok: false, note: 'see errors["boot.mvp"]' }
  heap['postBoot'] = heapSample()

  if (mvpBoot !== undefined) {
    const fixture = await fixturePromise
    const opened = await step('open.million', () =>
      call(mvpWorker, { kind: 'open', name: fixture.name, bytes: fixture.bytes }, 180_000, [
        fixture.bytes,
      ]),
    )
    if (opened !== undefined) {
      results['fixture'] = opened
    }
    heap['postFirstRow'] = heapSample()
    results['opfs'] = await step('opfs', () => call(mvpWorker, { kind: 'opfsProbe' }, 30_000))
  } else {
    results['fixture'] = { blockedBy: 'boot.mvp' }
    results['opfs'] = { blockedBy: 'boot.mvp' }
  }
  mvpWorker.terminate()

  // Q1d: probe the `eh` (exception-handling) bundle in a fresh worker too.
  // Measured result: it boots without cross-origin isolation, like `mvp`; only
  // the separate `coi` (threads) bundle would require it (not probed).
  const ehWorker = new Worker(workerUrl, { type: 'module' })
  attachDiagnostics(ehWorker, 'eh')
  const ehBoot = await step('boot.eh', () => bootBundle(ehWorker, 'eh', config.bundles.eh))
  bundles['eh'] = ehBoot ?? { ok: false, note: 'see errors["boot.eh"]' }
  ehWorker.terminate()
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
