// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The vendored DuckDB-WASM runtime pin (ptv1-2) as the extension host sees
 * it. The machine-readable checksum pin lives in `scripts/build.mjs`; this
 * constant is the host-side copy used to build webview configs for BOTH the
 * spike harness and the production dataset viewer. Keep the three in step —
 * `VENDORED_ASSETS.md` documents the deliberate re-vendor flow.
 */
export const VENDORED_RUNTIME = {
  /** The DuckDB runtime embedded in the vendored bundle. */
  duckdbVersion: 'v1.4.3',
  /** Legacy spike fields retained for its Parquet-only boot proof. */
  extensionFileName: 'parquet.duckdb_extension.wasm',
  autoloadPath: '/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm',
  /** Vendored extensions copied to dist/webview and served at their CDN autoload paths. */
  extensions: [
    {
      fileName: 'parquet.duckdb_extension.wasm',
      autoloadPath: '/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm',
    },
    {
      fileName: 'json.duckdb_extension.wasm',
      autoloadPath: '/v1.4.3/wasm_mvp/json.duckdb_extension.wasm',
    },
  ],
  /** The CDN host that must never be fetched (the ptv1-2 network block). */
  blockedExtensionHost: 'extensions.duckdb.org',
} as const
