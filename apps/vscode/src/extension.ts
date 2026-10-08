// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PT-V R4 webview feasibility spike (queue row ptv-1) — extension host entry.
 *
 * This is a deliberately minimal, spike-labeled scaffold: one command that
 * opens a webview, hands it the 1M-row on-demand Parquet fixture, and resolves
 * with the machine-readable evidence the webview produces. There is NO product
 * UX here and nothing in this file is a PT-V commitment (ruling D15). The
 * reviewer re-runs it with `pnpm --filter @assay/vscode run:spike`; the evidence
 * and its honesty tags live in
 * `docs/engineering/08-vscode-webview-feasibility.md`.
 *
 * Security posture (engineering/04 §6): strict CSP set on the webview HTML,
 * scripts only from the extension's own `dist/webview` via `asWebviewUri`, a
 * per-load nonce, and the fixture is passed as bytes (no file paths in the
 * webview DOM). No dataset values leave the machine.
 */
import * as vscode from 'vscode'

/** The command the test host (and a human) invokes; returns the spike report. */
const RUN_COMMAND = 'assay.spike.run'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_COMMAND, (fixturePath: string) =>
      runSpike(context, fixturePath),
    ),
  )
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
  readonly bundles: {
    readonly mvp: { readonly workerUrl: string; readonly wasmUrl: string }
    readonly eh: { readonly workerUrl: string; readonly wasmUrl: string }
  }
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
    bundles: {
      mvp: {
        workerUrl: asset('duckdb-browser-mvp.worker.js'),
        wasmUrl: asset('duckdb-mvp.wasm'),
      },
      eh: {
        workerUrl: asset('duckdb-browser-eh.worker.js'),
        wasmUrl: asset('duckdb-eh.wasm'),
      },
    },
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

/** Strict CSP: nonce scripts, wasm-unsafe-eval for DuckDB-WASM, own-origin + blob workers. */
function buildHtml(webview: vscode.Webview, nonce: string, config: SpikeWebviewConfig): string {
  const csp = [
    "default-src 'none'",
    // `blob:` is required: the worker bundle is loaded from a same-origin blob
    // URL (see webview/main.ts) and DuckDB-WASM fetches its WASM from a blob.
    // `extensions.duckdb.org` is where DuckDB-WASM 1.32.0 fetches the Parquet
    // extension at runtime (`read_parquet` is not statically linked) — a real
    // PT-V consideration recorded in the feasibility report.
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' blob:`,
    "style-src 'unsafe-inline'",
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource} blob: https://extensions.duckdb.org`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ')
  const serialized = JSON.stringify(config).replaceAll('<', '\\u003c')
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
