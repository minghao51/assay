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

/**
 * The dataset viewer's static document (ptv1-3 bridge + ptv1-4 grid): the
 * status line, error slot, value-free counts, a visually-hidden grid heading
 * (the web app's a11y pattern: the grid section's heading sits OUTSIDE the
 * role=grid element, whose owned children must be rows/rowgroups), and the
 * ptv1-4 grid mount point. The grid's own DOM (role=grid viewport, toolbar,
 * footer) is built by `webview/data-grid.ts` at runtime — textContent/
 * setAttribute only, never innerHTML.
 */
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
      <p id="git-context" role="status" hidden></p>
      <p id="error" role="alert" hidden></p>
      <dl id="report" hidden>
        <dt>rows</dt>
        <dd id="report-rows"></dd>
        <dt>columns</dt>
        <dd id="report-columns"></dd>
      </dl>
      <p>Edits are session-only and are discarded when this view closes unless exported. Export writes the effective view in natural row order, independent of grid sort, filters, and viewport.</p>
      <section id="validation-controls" aria-label="Validate effective view" hidden>
        <button id="contract-select" type="button">Select contract…</button>
        <button id="validate-button" type="button" disabled>Validate effective view</button>
        <button id="validate-cancel" type="button" hidden>Cancel validation</button>
        <p id="validation-status" role="status"></p>
        <p id="validation-stale" role="status" hidden>STALE — edits changed the effective view. Re-validate explicitly.</p>
        <div id="validation-results"></div>
      </section>
      <section id="diff-controls" aria-label="Compare dataset" hidden>
        <h2>Compare with another dataset</h2>
        <button id="comparison-select" type="button">Select or replace comparison…</button>
        <p id="diff-status" role="status"></p>
        <div id="diff-disclosure"></div>
        <label for="diff-keys">Comparison keys (select one or more columns)</label>
        <select id="diff-keys" multiple size="6"></select>
        <div id="diff-candidates"></div>
        <button id="diff-confirm" type="button" disabled>Confirm keys and run diff</button>
        <button id="diff-cancel" type="button" hidden>Cancel diff</button>
        <p id="diff-stale" role="status" hidden>STALE — accepted edits changed the effective view. The shown report is retained; run the diff again explicitly.</p>
        <button id="diff-export" type="button" disabled>Export JSON report to new file…</button>
        <div id="diff-results"></div>
      </section>
      <section id="export-controls" aria-label="Export dataset" hidden>
        <label for="export-format">Format</label>
        <select id="export-format"><option value="parquet">Parquet</option><option value="csv">CSV</option><option value="jsonl">JSONL</option><option value="json">JSON</option><option value="arrow">Arrow</option></select>
        <button id="export-button" type="button">Export to new file…</button>
        <button id="export-cancel" type="button">Cancel export</button>
        <p id="export-status" role="status"></p>
      </section>
      <style>
        /* Minimal static style for the pre-mount hidden heading; the grid
           injects its own stylesheet on mount (CSP: style-src 'unsafe-inline'
           — the measured CSP string is untouched). */
        .assay-visually-hidden {
          position: absolute; width: 1px; height: 1px; padding: 0;
          margin: -1px; overflow: hidden; clip: rect(0 0 0 0);
          white-space: nowrap; border: 0;
        }
      </style>
      <h2 class="assay-visually-hidden">Grid</h2>
      <div id="grid-root"></div>
    </main>
    <script nonce="${nonce}">
      window.__ASSAY_DATASET_CONFIG__ = ${serialized};
    </script>
    <script type="module" nonce="${nonce}" src="${config.mainScriptUrl}"></script>
  </body>
</html>`
}
