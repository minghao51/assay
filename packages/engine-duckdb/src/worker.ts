// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Engine worker entry — the Vite web build (ptv1-1).
 *
 * This is the same worker the web app has always booted: the client's default
 * factory constructs it via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`,
 * Vite bundles it as a worker chunk, and the DuckDB-WASM asset URLs come from
 * bundler-resolved `?url` imports (same-origin build assets). All adapter
 * logic lives in the shared core (`./worker-core`), which this entry starts
 * with `{ source: 'static' }` — every worker message is forwarded to the
 * executor exactly as before (pinned headlessly in `worker-core.test.ts` and by
 * the unchanged web-app engine tests: the conformance suite, worker-op
 * serialization, and engine-target-compat).
 *
 * **Bundle choice is capability-guarded (ADR 0048, row R1-A).** The build
 * emits BOTH DuckDB-WASM pairs — `mvp` (legacy) and `eh` (wasm
 * exception-handling) — and `./bundle-select` picks one per session with the
 * package's own capability question: `WebAssembly.validate` on the probe bytes
 * `getPlatformFeatures()` uses. On a browser that supports wasm EH the `eh`
 * pair is the package's own preferred bundle, and it is the one whose glue
 * binds the exception-library imports the wasm module exports — so a failing
 * query or open rejects with the engine's REAL first message line instead of
 * the shipped `mvp` glue's `ReferenceError: _setThrew is not defined`, which
 * masks every failure class (catalog, conversion, IO, option alike). Browsers
 * without wasm EH keep the `mvp` pair and its opaque-error fallback, unchanged
 * (that fallback is the non-EH safety net, never file evidence). Only one pair
 * is fetched and instantiated per session; the protocol is untouched — the
 * worker already posted `{name, message, stack}` on failure.
 *
 * The esbuild-built twin entry (VS Code desktop webview,
 * `apps/vscode/webview/worker.ts`) starts the SAME core with
 * `{ source: 'injected' }` and blob-URL assets the host supplies at runtime —
 * one shared worker core, two bundler entries (queue row ptv1-1). Its runtime
 * is fixed and known-capable, so it ships the `eh` pair only (row R1-B).
 *
 * Historical (now in `./worker-core`): the lazy DuckDB-WASM bootstrap, the T2
 * two-lane operation serialization (m2-7), the Arrow IPC transport (ADR 0020),
 * the m1-4 file lifecycle, and the m4-2 OPFS export path.
 */
import duckdbMvpWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbMvpWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdbEhWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import duckdbEhWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import { selectEngineBundleAssets } from './bundle-select.js'
import { startEngineWorkerCore } from './worker-core.js'

startEngineWorkerCore({
  source: 'static',
  urls: selectEngineBundleAssets({
    mvp: { duckdbWorkerUrl: duckdbMvpWorkerUrl, duckdbWasmUrl: duckdbMvpWasmUrl },
    eh: { duckdbWorkerUrl: duckdbEhWorkerUrl, duckdbWasmUrl: duckdbEhWasmUrl },
  }),
})
