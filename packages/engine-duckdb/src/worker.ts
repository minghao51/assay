// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Engine worker entry — the Vite web build (ptv1-1).
 *
 * This is the same worker the web app has always booted: the client's default
 * factory constructs it via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`,
 * Vite bundles it as a worker chunk, and the two DuckDB-WASM asset URLs come
 * from bundler-resolved `?url` imports (same-origin build assets). All adapter
 * logic lives in the shared core (`./worker-core`), which this entry starts
 * with `{ source: 'static' }` — every worker message is forwarded to the
 * executor exactly as before, so the default web path is byte-identical by
 * construction (pinned headlessly in `worker-core.test.ts` and by the
 * unchanged web-app engine tests: the conformance suite, worker-op
 * serialization, and engine-target-compat).
 *
 * The esbuild-built twin entry (VS Code desktop webview,
 * `apps/vscode/webview/worker.ts`) starts the SAME core with
 * `{ source: 'injected' }` and blob-URL assets the host supplies at runtime —
 * one shared worker core, two bundler entries (queue row ptv1-1).
 *
 * Historical (now in `./worker-core`): the lazy DuckDB-WASM bootstrap, the T2
 * two-lane operation serialization (m2-7), the Arrow IPC transport (ADR 0020),
 * the m1-4 file lifecycle, and the m4-2 OPFS export path.
 */
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import { startEngineWorkerCore } from './worker-core.js'

startEngineWorkerCore({ source: 'static', urls: { duckdbWorkerUrl, duckdbWasmUrl } })
