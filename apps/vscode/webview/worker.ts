// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Engine worker entry for the VS Code desktop webview (ptv1-1) — the esbuild
 * twin of `packages/engine-duckdb/src/worker.ts` (the Vite web entry).
 *
 * This is the REAL `@assay/engine-duckdb` worker core, not spike-local boot
 * code: the R4 spike's duplicated engine worker (former contents of this file)
 * is gone. The core starts in INJECTED mode — a desktop webview cannot
 * construct a Worker from a cross-origin `vscode-webview-resource:` URI, so
 * the host (webview/main.ts) fetches the DuckDB-WASM glue + WASM as blobs
 * (`toBlobUrl`, the spike-proven workaround) and posts one `engine/assets`
 * control message before the first engine request. The extension's own worker
 * bundle is bootstrapped the same way (blob URL, measured in the harness as
 * Q1a/Q1b).
 *
 * One shared worker core, two bundler entries: Vite for web (static asset
 * URLs), esbuild for the extension (injected blob URLs). Queue row ptv1-1;
 * R4 report §8/§10 mandatory items.
 */
import { startEngineWorkerCore } from '@assay/engine-duckdb/worker-core'

startEngineWorkerCore({ source: 'injected' })
