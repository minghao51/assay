// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Production dataset surface (ptv1-3): the `assay.dataset.open` command and
 * the `assay.datasetViewer` custom (read-only) editor. Both funnel into one
 * bridge: read the file through `vscode.workspace.fs` (typed errors for
 * missing file, unsupported format, empty file, read failures), then hand the
 * BYTES to the dataset webview — no file paths cross into the webview and no
 * dataset values are rendered there (counts only; ptv1-4 owns the grid).
 *
 * Security posture (engineering/04 §6, AGENTS.md): dataset values are
 * untrusted content — the webview HTML is a static template, config is
 * JSON-serialized with `<` escaping, and every DOM update in the webview is
 * `textContent`/`hidden` (no `innerHTML` anywhere). No telemetry exists in
 * this extension and none may be added (ADR 0025/0037).
 */
import * as vscode from 'vscode'
import { VENDORED_RUNTIME } from './assets'
import { buildDatasetHtml } from './webview-html'

/** The command that opens a dataset via `showOpenDialog` (or an explicit URI). */
export const OPEN_COMMAND = 'assay.dataset.open'
/** The custom read-only editor viewType for supported dataset formats. */
export const VIEW_TYPE = 'assay.datasetViewer'
/** Diagnostic/test surface: the latest bridge report (value-free counts). */
export const LAST_REPORT_COMMAND = 'assay.dataset.lastReport'

/**
 * The supported dataset formats — the web app's open set
 * (`apps/web/src/telemetry/emit.ts` formatKindFromName): Parquet, CSV,
 * JSONL/NDJSON, JSON, Arrow/Feather/IPC.
 */
export type DatasetFormat = 'parquet' | 'csv' | 'jsonl' | 'json' | 'arrow'

const SUPPORTED_EXTENSIONS: ReadonlyMap<string, DatasetFormat> = new Map([
  ['.parquet', 'parquet'],
  ['.csv', 'csv'],
  ['.jsonl', 'jsonl'],
  ['.ndjson', 'jsonl'],
  ['.json', 'json'],
  ['.arrow', 'arrow'],
  ['.feather', 'arrow'],
  ['.ipc', 'arrow'],
])

/** The filename patterns the custom editor contributes (same set). */
export const SUPPORTED_FILENAME_PATTERNS: readonly string[] = [
  '*.parquet',
  '*.csv',
  '*.jsonl',
  '*.ndjson',
  '*.json',
  '*.arrow',
  '*.feather',
  '*.ipc',
]

/** Map a file name to its supported dataset format, or undefined. */
export function formatFromName(name: string): DatasetFormat | undefined {
  const lower = name.toLowerCase()
  for (const [extension, format] of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return format
    }
  }
  return undefined
}

/** Typed open failures, surfaced verbatim in the webview's error state. */
export type DatasetErrorKind =
  'missing-file' | 'unsupported-format' | 'empty-file' | 'read-failed' | 'engine-failed'

export class DatasetOpenError extends Error {
  readonly kind: DatasetErrorKind

  constructor(kind: DatasetErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'DatasetOpenError'
  }
}

/** Value-free bridge report (counts and kinds only — never file contents). */
export type DatasetReport =
  | {
      readonly outcome: 'opened'
      readonly format: DatasetFormat
      readonly byteLength: number
      readonly rows: number
      readonly columns: number
    }
  | {
      readonly outcome: 'error'
      readonly kind: DatasetErrorKind
      readonly message: string
      /** True when the webview acknowledged the error (it rendered the state). */
      readonly shownInWebview: boolean
    }

export interface ReadDatasetResult {
  readonly format: DatasetFormat
  readonly byteLength: number
  readonly bytes: ArrayBuffer
}

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
  }
}

const BRIDGE_TIMEOUT_MS = 240_000

/**
 * Open (or reuse) a dataset panel for `uri` and bridge the file's bytes into
 * it. Resolves with the value-free report once the webview acknowledges the
 * opened state or the rendered typed error; rejects on timeout.
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
  const name = uri.path.split('/').pop() ?? 'dataset'
  return new Promise<DatasetReport>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`dataset bridge timed out after ${String(BRIDGE_TIMEOUT_MS / 1000)}s`))
    }, BRIDGE_TIMEOUT_MS)
    const finish = (report: DatasetReport): void => {
      clearTimeout(timeout)
      lastReport = report
      resolve(report)
    }
    const reading = readDataset(uri)
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const kind = (message as { kind?: unknown } | null)?.kind
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
              message: datasetError.message,
            })
          },
        )
        return
      }
      if (kind === 'opened') {
        const opened = message as { rows?: unknown; columns?: unknown }
        void reading.then((read) => {
          finish({
            outcome: 'opened',
            format: read.format,
            byteLength: read.byteLength,
            rows: Number(opened.rows ?? -1),
            columns: Number(opened.columns ?? -1),
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
