// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Production dataset surface (ptv1-3 bridge + ptv1-4 grid): the
 * `assay.dataset.open` command and the `assay.datasetViewer` custom
 * (read-only) editor. Both funnel into one bridge: read the file through
 * `vscode.workspace.fs` (typed errors for missing file, unsupported format,
 * empty file, read failures), then hand the BYTES to the dataset webview.
 *
 * Posture (made literally true in ptv1-4 — the ptv1-3 carry-note): NO file
 * paths cross into the webview. The bridge posts a FORMAT-DERIVED NEUTRAL
 * name (`dataset.parquet`, for the engine's format detection — never the
 * user's file or folder name), and typed errors surface in the webview as
 * kind + PATH-FREE text (`WEBVIEW_ERROR_TEXT`); the full error message (with
 * the URI, when one exists) stays host-side in the value-free report. The
 * ptv1-4 grid renders dataset values as untrusted TEXT only (counts in the
 * report; no values, no paths).
 *
 * Security posture (engineering/04 §6, AGENTS.md): dataset values are
 * untrusted content — the webview HTML is a static template, config is
 * JSON-serialized with `<` escaping, and every DOM update in the webview is
 * `textContent`/`hidden`/`setAttribute` (no `innerHTML` anywhere). No
 * telemetry exists in this extension and none may be added (ADR 0025/0037).
 */
import * as vscode from 'vscode'
import { createOnlyWriter } from './pure/create-only-writer'
import { acceptExportFrame, EXPORT_MAX_BYTES } from './pure/export-transfer'
import { VENDORED_RUNTIME } from './assets'
import { buildDatasetHtml } from './webview-html'
import {
  formatFromName,
  neutralDatasetName,
  SUPPORTED_FILENAME_PATTERNS,
} from './pure/dataset-format'
import {
  DatasetOpenError,
  normalizeEditProof,
  WEBVIEW_ERROR_TEXT,
  type DatasetReport,
  type ReadDatasetResult,
} from './pure/bridge-contracts'

/** The command that opens a dataset via `showOpenDialog` (or an explicit URI). */
export const OPEN_COMMAND = 'assay.dataset.open'
/** The custom read-only editor viewType for supported dataset formats. */
export const VIEW_TYPE = 'assay.datasetViewer'
/** Diagnostic/test surface: the latest bridge report (value-free counts). */
export const LAST_REPORT_COMMAND = 'assay.dataset.lastReport'
let testExportSequence = 0

export {
  formatFromName,
  neutralDatasetName,
  SUPPORTED_FILENAME_PATTERNS,
  type DatasetFormat,
} from './pure/dataset-format'
export {
  DatasetOpenError,
  WEBVIEW_ERROR_TEXT,
  type DatasetErrorKind,
  type DatasetReport,
  type ReadDatasetResult,
} from './pure/bridge-contracts'

/**
 * Read a dataset through `workspace.fs` with typed failures. Order is the
 * production contract: cheap validation first (unsupported format needs no
 * I/O), then existence, then read, then emptiness.
 */
export async function readDataset(uri: vscode.Uri): Promise<ReadDatasetResult> {
  const format = formatFromName(uri.path.split('/').pop() ?? uri.path)
  if (format === undefined) {
    throw new DatasetOpenError('unsupported-format', `unsupported dataset format: ${uri.path}`)
  }
  let stat: vscode.FileStat
  try {
    stat = await vscode.workspace.fs.stat(uri)
  } catch (error) {
    throw toReadError(error, uri)
  }
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    throw new DatasetOpenError('read-failed', `not a file: ${uri.path}`)
  }
  let bytes: Uint8Array
  try {
    bytes = await vscode.workspace.fs.readFile(uri)
  } catch (error) {
    throw toReadError(error, uri)
  }
  if (bytes.byteLength === 0) {
    throw new DatasetOpenError('empty-file', `file is empty: ${uri.path}`)
  }
  // A plain ArrayBuffer clone: `Uint8Array.buffer` may be a wider-than-needed
  // SharedArrayBuffer under the DOM lib typing, and structured clone needs a
  // clean, exactly-sized ArrayBuffer.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return { format, byteLength: bytes.byteLength, bytes: buffer }
}

function toReadError(error: unknown, uri: vscode.Uri): DatasetOpenError {
  // `FileSystemError.FileNotFound` is typed as a constructor (string|Uri) in
  // @types/vscode 1.90, so test the documented `code` on the narrowed error.
  if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
    return new DatasetOpenError('missing-file', `file not found: ${uri.path}`)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new DatasetOpenError('read-failed', `could not read ${uri.path}: ${detail}`)
}

/** The dataset webview's config — the vendored engine asset URLs (ptv1-1/2 seam). */
export interface DatasetWebviewConfig {
  readonly target: 'desktop-webview'
  readonly vscodeVersion: string
  /** The dataset webview module script (dist/webview/dataset.js). */
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
  /** Internal real-host proof switch; unavailable to production extensions. */
  readonly testHarness: boolean
}

/** Build the webview config for one panel: own-origin asset URIs only. */
export function buildDatasetConfig(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
): DatasetWebviewConfig {
  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')
  const asset = (name: string): string =>
    panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, name)).toString()
  return {
    target: 'desktop-webview',
    vscodeVersion: vscode.version,
    mainScriptUrl: asset('dataset.js'),
    workerEntryUrl: asset('worker.js'),
    mvpGlueUrl: asset('duckdb-browser-mvp.worker.js'),
    mvpWasmUrl: asset('duckdb-mvp.wasm'),
    vendoredExtension: {
      url: asset(VENDORED_RUNTIME.extensionFileName),
      autoloadPath: VENDORED_RUNTIME.autoloadPath,
      duckdbVersion: VENDORED_RUNTIME.duckdbVersion,
    },
    blockedExtensionHost: VENDORED_RUNTIME.blockedExtensionHost,
    testHarness:
      context.extensionMode === vscode.ExtensionMode.Test &&
      process.env['ASSAY_E2E_EDIT_PROOF'] === '1',
  }
}

const BRIDGE_TIMEOUT_MS = 240_000

/**
 * Open (or reuse) a dataset panel for `uri` and bridge the file's bytes into
 * it. Resolves with the value-free report once the webview acknowledges the
 * opened state or the rendered typed error; rejects on timeout.
 *
 * This command path owns its panel and tears it down when the report
 * resolves — the engine lives in the WEBVIEW session (webview/engine-session.ts:
 * booted once per panel, disposed when the host posts `dispose` here or the
 * page dies with the panel). The custom-editor path keeps the panel open
 * instead; on both paths the webview holds the engine for the panel's whole
 * life — the grid fetches windows through it as the user scrolls, sorts, and
 * filters (the ptv1-3 carry-note: the panel owns the engine, now in code).
 */
export async function openDatasetPanel(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
): Promise<DatasetReport> {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Assay dataset',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    },
  )
  try {
    return await bridgeDatasetIntoPanel(context, panel, uri)
  } finally {
    // Host-orchestrated close: let the webview dispose its engine before the
    // page goes away (best-effort — page teardown terminates the worker too).
    void Promise.resolve(panel.webview.postMessage({ kind: 'dispose' })).catch(() => undefined)
    panel.dispose()
  }
}

/**
 * Wire one panel to one dataset: build the webview, read the file with typed
 * errors, post bytes (or the typed error) on the webview's `ready`, and
 * resolve with the report the webview acknowledges.
 */
export function bridgeDatasetIntoPanel(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  uri: vscode.Uri,
): Promise<DatasetReport> {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  panel.webview.html = buildDatasetHtml(panel.webview, nonce, buildDatasetConfig(context, panel))
  // Neutral, format-derived name — never the user's file name (module doc).
  const name = neutralDatasetName(
    formatFromName(uri.path.split('/').pop() ?? uri.path) ?? 'parquet',
  )
  return new Promise<DatasetReport>((resolve, reject) => {
    let exportWriter: Awaited<ReturnType<typeof createOnlyWriter>> | undefined
    let exportState: import('./pure/export-transfer').ExportTransferState | undefined
    let exportId: string | undefined
    let exportGeneration = 0
    let exportWritePending = false
    const exportCleanup = async (): Promise<void> => {
      await exportWriter?.cleanup()
      exportWriter = undefined
      exportState = undefined
      exportId = undefined
      exportWritePending = false
    }
    const timeout = setTimeout(() => {
      reject(new Error(`dataset bridge timed out after ${String(BRIDGE_TIMEOUT_MS / 1000)}s`))
    }, BRIDGE_TIMEOUT_MS)
    panel.onDidDispose(() => {
      void exportCleanup()
    })
    const finish = (report: DatasetReport): void => {
      clearTimeout(timeout)
      void exportCleanup()
      lastReport = report
      resolve(report)
    }
    const reading = readDataset(uri)
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const kind = (message as { kind?: unknown } | null)?.kind
      if (kind === 'export-request') {
        const request = message as { id?: unknown; generation?: unknown; format?: unknown }
        if (
          typeof request.id !== 'string' ||
          request.id.length === 0 ||
          request.id.length > 64 ||
          !Number.isSafeInteger(request.generation) ||
          Number(request.generation) < 0 ||
          !['parquet', 'jsonl', 'json', 'csv', 'arrow'].includes(String(request.format))
        )
          return
        const id = request.id
        const generation = Number(request.generation)
        if (exportWriter !== undefined || exportId !== undefined) {
          void panel.webview.postMessage({
            kind: 'export-error',
            id,
            generation,
            errorKind: 'export-busy',
          })
          return
        }
        void (async () => {
          const testHarness =
            context.extensionMode === vscode.ExtensionMode.Test &&
            process.env['ASSAY_E2E_EDIT_PROOF'] === '1'
          const target = testHarness
            ? vscode.Uri.file(
                `${process.env['ASSAY_E2E_WORKSPACE'] ?? ''}/assay-export-proof-${String(++testExportSequence)}.${String(request.format)}`,
              )
            : await vscode.window.showSaveDialog({
                saveLabel: 'Export new dataset file',
                filters: { 'Dataset export': [String(request.format)] },
              })
          if (target === undefined) {
            void panel.webview.postMessage({ kind: 'export-cancelled', id, generation })
            return
          }
          if (target.scheme !== 'file' || target.fsPath === uri.fsPath) {
            void panel.webview.postMessage({
              kind: 'export-error',
              id,
              generation,
              errorKind: 'destination-refused',
            })
            return
          }
          try {
            exportWriter = await createOnlyWriter(target.fsPath, [uri.fsPath])
            exportId = id
            exportGeneration = generation
            void panel.webview.postMessage({ kind: 'export-ready', id, generation })
          } catch {
            void panel.webview.postMessage({
              kind: 'export-error',
              id,
              generation,
              errorKind: 'destination-refused',
            })
          }
        })().catch(() => {
          void panel.webview.postMessage({
            kind: 'export-error',
            id,
            generation,
            errorKind: 'export-failed',
          })
        })
        return
      }
      if (kind === 'export-start') {
        const start = message as { id?: unknown; generation?: unknown; totalBytes?: unknown }
        if (
          start.id !== exportId ||
          start.generation !== exportGeneration ||
          !Number.isSafeInteger(start.totalBytes) ||
          Number(start.totalBytes) < 0 ||
          Number(start.totalBytes) > EXPORT_MAX_BYTES
        ) {
          void exportCleanup()
          return
        }
        if (typeof exportId !== 'string') return
        exportState = {
          id: exportId,
          generation: exportGeneration,
          totalBytes: Number(start.totalBytes),
          nextSequence: 0,
          nextOffset: 0,
        }
        void panel.webview.postMessage({
          kind: 'export-credit',
          id: exportId,
          generation: exportGeneration,
        })
        return
      }
      if (kind === 'export-chunk') {
        try {
          if (exportState === undefined || exportWriter === undefined || exportWritePending)
            throw new Error('invalid-frame')
          const accepted = acceptExportFrame(exportState, message)
          exportState = accepted.state
          exportWritePending = true
          void exportWriter.write(accepted.bytes).then(
            () => {
              exportWritePending = false
              void panel.webview.postMessage({
                kind: 'export-credit',
                id: exportId,
                generation: exportGeneration,
              })
            },
            () => {
              exportWritePending = false
              void exportCleanup()
              void panel.webview.postMessage({
                kind: 'export-error',
                id: exportId,
                generation: exportGeneration,
                errorKind: 'export-failed',
              })
            },
          )
        } catch {
          void exportCleanup()
          void panel.webview.postMessage({
            kind: 'export-error',
            id: exportId,
            generation: exportGeneration,
            errorKind: 'export-failed',
          })
        }
        return
      }
      if (kind === 'export-finish') {
        const done = message as { id?: unknown; generation?: unknown }
        if (
          done.id !== exportId ||
          done.generation !== exportGeneration ||
          exportState === undefined ||
          exportWriter === undefined ||
          exportState.nextOffset !== exportState.totalBytes
        ) {
          void exportCleanup()
          return
        }
        void exportWriter
          .close()
          .then(() => {
            exportWriter = undefined
            void panel.webview.postMessage({
              kind: 'export-complete',
              id: exportId,
              generation: exportGeneration,
            })
            exportState = undefined
            exportId = undefined
          })
          .catch(() => {
            void exportCleanup()
            void panel.webview.postMessage({
              kind: 'export-error',
              id: done.id,
              generation: done.generation,
              errorKind: 'export-failed',
            })
          })
        return
      }
      if (kind === 'export-cancel') {
        const cancel = message as { id?: unknown; generation?: unknown }
        if (cancel.id === exportId && cancel.generation === exportGeneration) {
          void exportCleanup()
          void panel.webview.postMessage({
            kind: 'export-cancelled',
            id: cancel.id,
            generation: cancel.generation,
          })
        }
        return
      }
      if (kind === 'ready') {
        void reading.then(
          (read) => {
            void panel.webview.postMessage({ kind: 'dataset', name, bytes: read.bytes })
          },
          (error: unknown) => {
            const datasetError = asDatasetError(error)
            void panel.webview.postMessage({
              kind: 'error',
              errorKind: datasetError.kind,
              // Path-free text only — the URI never enters the webview (see
              // WEBVIEW_ERROR_TEXT; the full message stays host-side).
              message: WEBVIEW_ERROR_TEXT[datasetError.kind],
            })
          },
        )
        return
      }
      if (kind === 'opened') {
        const opened = message as {
          rows?: unknown
          columns?: unknown
          firstRowVisibleMs?: unknown
          gridRendered?: unknown
          gridAudit?: { ok?: unknown }
          editProof?: unknown
        }
        void reading.then((read) => {
          finish({
            outcome: 'opened',
            format: read.format,
            byteLength: read.byteLength,
            rows: Number(opened.rows ?? -1),
            columns: Number(opened.columns ?? -1),
            gridRendered: opened.gridRendered === true,
            gridAuditOk: opened.gridAudit?.ok === true,
            firstRowVisibleMs: Number(opened.firstRowVisibleMs ?? -1),
            ...(context.extensionMode === vscode.ExtensionMode.Test
              ? (() => {
                  const proof = normalizeEditProof(opened.editProof)
                  return proof === undefined ? {} : { editProof: proof }
                })()
              : {}),
          })
        })
        return
      }
      if (kind === 'error-shown') {
        void reading.then(undefined, (error: unknown) => {
          const datasetError = asDatasetError(error)
          finish({
            outcome: 'error',
            kind: datasetError.kind,
            message: datasetError.message,
            shownInWebview: true,
          })
        })
        return
      }
      if (kind === 'engine-error') {
        const engineError = message as { message?: unknown }
        finish({
          outcome: 'error',
          kind: 'engine-failed',
          message: String(engineError.message ?? 'engine failed'),
          shownInWebview: true,
        })
      }
    })
  })
}

/** Normalize any read failure into the typed error (unknown hosts included). */
function asDatasetError(error: unknown): DatasetOpenError {
  return error instanceof DatasetOpenError
    ? error
    : new DatasetOpenError('read-failed', error instanceof Error ? error.message : String(error))
}

/** The latest bridge report (diagnostics + the e2e's custom-editor surface). */
let lastReport: DatasetReport | undefined

/** Last report accessor for `assay.dataset.lastReport`. */
export function lastDatasetReport(): DatasetReport | undefined {
  return lastReport
}

/** Read-only custom editor: same bridge, panel owned by VS Code. */
class DatasetViewerProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    // The viewer is read-only and byte-based: no custom document state beyond
    // the URI — every open re-reads through `workspace.fs` with typed errors.
    return { uri, dispose: () => undefined }
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    void bridgeDatasetIntoPanel(this.context, panel, document.uri)
  }
}

/** Register the ptv1-3 production surface: command + custom editor + report. */
export function registerDatasetSurface(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, async (uri?: vscode.Uri) => {
      let target = uri
      if (target === undefined) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Open dataset',
          filters: {
            // spread: OpenDialogOptions.filters is a mutable record type
            'Dataset files (Parquet, CSV, JSONL, JSON, Arrow)': [...SUPPORTED_FILENAME_PATTERNS],
          },
        })
        if (picked === undefined || picked.length === 0) {
          return undefined
        }
        target = picked[0]
      }
      return openDatasetPanel(context, target)
    }),
    vscode.commands.registerCommand(LAST_REPORT_COMMAND, () => lastDatasetReport()),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new DatasetViewerProvider(context), {
      supportsMultipleEditorsPerDocument: false,
    }),
  )
}
