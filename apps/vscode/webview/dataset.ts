// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Production dataset-viewer webview (ptv1-3). Receives dataset BYTES from the
 * extension host (read via `workspace.fs` — no file paths cross into the
 * webview), boots the vendored engine through the ptv1-1 seam + ptv1-2
 * vendored assets (`webview/engine-boot.ts`), opens the dataset through the
 * real `@assay/engine-duckdb` client, and reports value-free counts only:
 * rows and columns. No dataset values are rendered here (ptv1-4 owns the grid
 * surface); typed host errors are rendered as text — the DOM is static HTML
 * updated exclusively via `textContent`/`hidden` (no `innerHTML` anywhere,
 * engineering/04 §6).
 */
import { bootVendoredEngine } from './engine-boot'
import type { WorkerDiagnostic } from './engine-boot'

/** Mirror of the host-side config in `src/dataset.ts` (buildDatasetConfig). */
interface DatasetWebviewConfig {
  readonly target: 'desktop-webview'
  readonly vscodeVersion: string
  /** Host-injected module script URL (consumed by the HTML, not this script). */
  readonly mainScriptUrl: string
  readonly workerEntryUrl: string
  readonly mvpGlueUrl: string
  readonly mvpWasmUrl: string
  readonly vendoredExtension: {
    readonly url: string
    readonly autoloadPath: string
    readonly duckdbVersion: string
  }
  readonly blockedExtensionHost: string
}

declare global {
  interface Window {
    __ASSAY_DATASET_CONFIG__: DatasetWebviewConfig
  }
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

const config = window.__ASSAY_DATASET_CONFIG__
const vscodeApi = acquireVsCodeApi()

const diagnostics: Array<WorkerDiagnostic> = []

function elementOrThrow(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) {
    throw new Error(`dataset webview DOM is missing #${id}`)
  }
  return el
}

function setStatus(message: string): void {
  elementOrThrow('status').textContent = message
}

/** Render a typed error state (text only) and acknowledge it to the host. */
function renderError(kind: string, message: string): void {
  setStatus('error')
  const errorEl = elementOrThrow('error')
  errorEl.textContent = `${kind}: ${message}`
  errorEl.hidden = false
}

function renderReport(rows: number, columns: number): void {
  setStatus('opened')
  const report = elementOrThrow('report')
  elementOrThrow('report-rows').textContent = String(rows)
  elementOrThrow('report-columns').textContent = String(columns)
  report.hidden = false
}

/** Open the posted bytes through the real adapter; report counts only. */
async function openDataset(name: string, bytes: ArrayBuffer): Promise<void> {
  setStatus('booting engine…')
  const boot = await bootVendoredEngine(
    {
      workerEntryUrl: config.workerEntryUrl,
      mvpGlueUrl: config.mvpGlueUrl,
      mvpWasmUrl: config.mvpWasmUrl,
      vendoredExtensionUrl: config.vendoredExtension.url,
      autoloadPath: config.vendoredExtension.autoloadPath,
      blockedHost: config.blockedExtensionHost,
    },
    diagnostics,
  )
  setStatus('opening dataset…')
  try {
    const file = new File([bytes], name)
    const handle = await boot.client.open({ name, getFile: () => Promise.resolve(file) })
    const rows = await boot.client.rowCount(handle)
    const columns = (await boot.client.schema(handle)).length
    renderReport(rows, columns)
    vscodeApi.postMessage({ kind: 'opened', rows, columns })
  } finally {
    // The panel owns the engine for later surfaces (ptv1-4); a hidden panel
    // keeps the client, a closed one is torn down with the webview. The boot
    // blob URLs are consumed and revoked either way.
    void boot.dispose().catch(() => undefined)
  }
}

let datasetReceived = false

window.addEventListener('message', (event) => {
  const data = event.data as {
    kind?: string
    name?: string
    bytes?: ArrayBuffer
    errorKind?: string
    message?: string
  }
  if (data?.kind === 'dataset' && !datasetReceived && data.bytes instanceof ArrayBuffer) {
    datasetReceived = true
    openDataset(data.name ?? 'dataset', data.bytes).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      renderError('engine-failed', message)
      vscodeApi.postMessage({ kind: 'engine-error', message })
    })
    return
  }
  if (data?.kind === 'error' && typeof data.errorKind === 'string') {
    renderError(data.errorKind, data.message ?? '')
    vscodeApi.postMessage({ kind: 'error-shown', errorKind: data.errorKind })
  }
})

vscodeApi.postMessage({ kind: 'ready' })

export {}
