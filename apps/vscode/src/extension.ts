// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PT-V R4 webview feasibility spike (queue row ptv-1) — extension host entry.
 *
 * The spike command remains the slice-1 evidence harness (ptv1-5 hardens it;
 * the reviewer re-runs it with `pnpm --filter @assay/vscode run:spike`; the
 * evidence and its honesty tags live in
 * `docs/engineering/08-vscode-webview-feasibility.md`). Since ptv1-3 the
 * production dataset surface (command + custom read-only editor, the
 * `workspace.fs` -> webview bytes bridge, typed error paths) is registered
 * alongside it - see `src/dataset.ts`. The webview CSP is shared with the
 * production panels (`src/webview-html.ts`) so the measured posture cannot
 * drift; the vendored-runtime pin literals come from `src/assets.ts`.
 *
 * Security posture (engineering/04 §6): strict CSP set on the webview HTML,
 * scripts only from the extension's own `dist/webview` via `asWebviewUri`, a
 * per-load nonce, and the fixture is passed as bytes (no file paths in the
 * webview DOM). No dataset values leave the machine.
 */
import * as vscode from 'vscode'
import { VENDORED_RUNTIME } from './assets'
import { registerDatasetSurface } from './dataset'
import { serializeConfig, webviewCsp } from './webview-html'

/** The command the test host (and a human) invokes; returns the spike report. */
const RUN_COMMAND = 'assay.spike.run'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_COMMAND, (fixturePath: string) =>
      runSpike(context, fixturePath),
    ),
  )
  registerDatasetSurface(context)
}

export function deactivate(): void {
  // Nothing to tear down — the webview panel owns all spike resources.
}

interface SpikeWebviewConfig {
  readonly target: 'desktop-webview'
  readonly vscodeVersion: string
  readonly mainScriptUrl: string
  readonly workerScriptUrl: string
  readonly probeUrl: string
  /**
   * The vendored DuckDB-WASM bundle the spike boots (R1-B: the `eh` pair only
   * — Electron's Chromium is fixed and wasm-EH-capable, ADR 0048 decision 3).
   */
  readonly bundle: { readonly workerUrl: string; readonly wasmUrl: string }
  /** ptv1-2: the vendored Parquet extension (local-first; runtime never fetches). */
  readonly vendoredExtension: {
    readonly fileName: string
    readonly url: string
    readonly duckdbVersion: string
    /** The CDN URL path the shim serves locally (DuckDB-version specific). */
    readonly autoloadPath: string
  }
  /** ptv1-2: the CDN host the harness network-blocks (Q5b failure mode, pinned fixed). */
  readonly blockedExtensionHost: string
  /**
   * ptv1-2 drill mode (ASSAY_SPIKE_DRILL=missing-extension): skip the local
   * extension install so the stock CDN autoload path is exercised — the run
   * must then FAIL with the refused fetch, reproducing the Q5b failure mode
   * under the network block (structural proof the block would catch it).
   */
  readonly drill: boolean
}

/**
 * Open the spike webview and resolve with its report. The fixture bytes are
 * read through `vscode.workspace.fs` (no node fs import) and posted to the
 * webview as an ArrayBuffer; the webview signals `ready` when its message
 * listener is installed so the bytes are never posted into the void.
 */
async function runSpike(context: vscode.ExtensionContext, fixturePath: string): Promise<unknown> {
  const panel = vscode.window.createWebviewPanel(
    'assaySpike',
    'Assay R4 webview spike',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    },
  )

  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')
  const asset = (name: string): string =>
    panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, name)).toString()

  const nonce = crypto.randomUUID().replaceAll('-', '')
  const config: SpikeWebviewConfig = {
    target: 'desktop-webview',
    vscodeVersion: vscode.version,
    mainScriptUrl: asset('main.js'),
    workerScriptUrl: asset('worker.js'),
    probeUrl: asset('probe.json'),
    bundle: {
      workerUrl: asset('duckdb-browser-eh.worker.js'),
      wasmUrl: asset('duckdb-eh.wasm'),
    },
    vendoredExtension: {
      fileName: VENDORED_RUNTIME.extensionFileName,
      url: asset(VENDORED_RUNTIME.extensionFileName),
      duckdbVersion: VENDORED_RUNTIME.duckdbVersion,
      // The CDN URL path the shim serves locally (Q5b autoload URL of the
      // pinned DuckDB version; must move with any deliberate re-vendor).
      autoloadPath: VENDORED_RUNTIME.autoloadPath,
    },
    blockedExtensionHost: VENDORED_RUNTIME.blockedExtensionHost,
    drill: process.env['ASSAY_SPIKE_DRILL'] === 'missing-extension',
  }
  panel.webview.html = buildHtml(panel.webview, nonce, config)

  const fixtureBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fixturePath))
  // A plain ArrayBuffer clone: `Uint8Array.buffer` may be a wider-than-needed
  // SharedArrayBuffer under the DOM lib typing, and structured clone needs a
  // clean, exactly-sized ArrayBuffer.
  const fixtureBuffer = fixtureBytes.buffer.slice(
    fixtureBytes.byteOffset,
    fixtureBytes.byteOffset + fixtureBytes.byteLength,
  ) as ArrayBuffer

  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      panel.dispose()
      reject(new Error('spike harness timed out after 240s'))
    }, 240_000)

    panel.webview.onDidReceiveMessage((message: unknown) => {
      const kind = (message as { kind?: unknown } | null)?.kind
      if (kind === 'ready') {
        void panel.webview.postMessage({
          kind: 'fixture',
          name: 'million.parquet',
          bytes: fixtureBuffer,
        })
        return
      }
      if (kind === 'results') {
        clearTimeout(timeout)
        resolve((message as { results: unknown }).results)
        return
      }
      if (kind === 'error') {
        clearTimeout(timeout)
        const detail = (message as { message?: unknown }).message
        reject(new Error(`spike webview error: ${String(detail)}`))
      }
    })
  })
}

/** The spike document: shared measured CSP (see webview-html.ts) + config. */
function buildHtml(webview: vscode.Webview, nonce: string, config: SpikeWebviewConfig): string {
  const csp = webviewCsp(webview, nonce)
  const serialized = serializeConfig(config)
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Assay webview spike</title>
  </head>
  <body>
    <h1>Assay R4 webview feasibility spike</h1>
    <p id="status">booting…</p>
    <pre id="log"></pre>
    <script nonce="${nonce}">
      window.__ASSAY_SPIKE_CONFIG__ = ${serialized};
    </script>
    <script type="module" nonce="${nonce}" src="${config.mainScriptUrl}"></script>
  </body>
</html>`
}
