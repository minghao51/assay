// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Webview HTML construction (ptv1-3): the measured R4 CSP, shared by the
 * spike harness and the production dataset viewer so the measured posture
 * cannot drift between them, plus the dataset panel's static document.
 *
 * Both documents are fully static templates: the only dynamic text is the
 * JSON-serialized config (with `<` escaped) and per-load nonces. Dataset
 * bytes never appear in HTML — they cross by `postMessage` — and the webview
 * scripts update the DOM exclusively via `textContent`/`hidden` (no
 * `innerHTML` anywhere; engineering/04 §6).
 */
import type * as vscode from 'vscode'
import type { DatasetWebviewConfig } from './dataset'

/**
 * Strict CSP: nonce scripts, wasm-unsafe-eval for DuckDB-WASM, own-origin +
 * blob workers. This string construction is the R4-measured posture (report
 * §8): `blob:` is required for the same-origin worker/WASM bootstrap, and
 * `extensions.duckdb.org` is deliberately NOT in connect-src since ptv1-2 —
 * the Parquet extension is vendored and any CDN request must be refused.
 */
export function webviewCsp(webview: vscode.Webview, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' blob:`,
    "style-src 'unsafe-inline'",
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource} blob:`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ')
}

/** Serialize config into a `<script>`-safe literal (escape `<` for `</script>`). */
export function serializeConfig(config: unknown): string {
  return JSON.stringify(config).replaceAll('<', '\\u003c')
}

/** The dataset viewer's static document (ptv1-3): status, error slot, counts. */
export function buildDatasetHtml(
  webview: vscode.Webview,
  nonce: string,
  config: DatasetWebviewConfig,
): string {
  const csp = webviewCsp(webview, nonce)
  const serialized = serializeConfig(config)
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Assay dataset</title>
  </head>
  <body>
    <main>
      <h1>Assay dataset</h1>
      <p id="status">connecting…</p>
      <p id="error" role="alert" hidden></p>
      <dl id="report" hidden>
        <dt>rows</dt>
        <dd id="report-rows"></dd>
        <dt>columns</dt>
        <dd id="report-columns"></dd>
      </dl>
    </main>
    <script nonce="${nonce}">
      window.__ASSAY_DATASET_CONFIG__ = ${serialized};
    </script>
    <script type="module" nonce="${nonce}" src="${config.mainScriptUrl}"></script>
  </body>
</html>`
}
