// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Capability-guarded DuckDB-WASM bundle selection (ADR 0048, row R1-A).
 *
 * Why this exists: the browser build used to pin the legacy `mvp` pair
 * (`duckdb-browser-mvp.worker.js` + `duckdb-mvp.wasm`). In
 * `@duckdb/duckdb-wasm@1.32.0` that published glue is an incomplete
 * JS-exception-handling build — the wasm module exports `setThrew`,
 * `__cxa_can_catch`, `__cxa_increment_exception_refcount`,
 * `__cxa_decrement_exception_refcount` and `__cxa_get_exception_ptr`, but the
 * glue calls the free identifiers for them without binding any. Every DuckDB
 * failure therefore died in the `invoke_*` trampolines as
 * `ReferenceError: _setThrew is not defined` **before** DuckDB's message was
 * built, so catalog, conversion, IO and option failures were mutually
 * indistinguishable on both `query()` and `send()`.
 *
 * The package ships its own selector: `getPlatformFeatures()` probes wasm
 * exception handling with `WebAssembly.validate`, and `selectBundle()` returns
 * the `eh` assets whenever that probe passes (`mvp` is only the legacy
 * fallback). This module reproduces that **same capability question** so the
 * product's bundle choice matches the package's own decision, while keeping
 * the choice testable headlessly (the probe is an injectable seam).
 *
 * Deliberately internal: not re-exported from `index.ts`. It is an engine
 * boot detail of the static (Vite) worker entry, not part of the client API.
 */
import type { EngineAssetUrls } from './worker-core.js'

/**
 * The wasm exception-handling probe, **copied verbatim from the upstream
 * package** so the product's capability question is literally the one
 * `selectBundle()` asks.
 *
 * Upstream source of truth (`@duckdb/duckdb-wasm@1.32.0`, `dist/duckdb-browser.mjs`):
 *
 * ```js
 * var W = async () =>
 *   WebAssembly.validate(
 *     new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,8,1,6,0,6,64,25,11,11]),
 *   )
 * ```
 *
 * `getPlatformFeatures()` stores that as `wasmExceptions` and `selectBundle()`
 * prefers the `eh` pair when it is true. The bytes are a minimal module whose
 * code body uses the exception-handling `try`/`catch` opcodes (`0x06 0x40`), so
 * a browser without wasm EH support fails `validate`.
 *
 * Frozen so no caller can mutate the capability question at runtime;
 * `bundle-select.test.ts` pins the exact byte sequence, so an edit here cannot
 * silently change what is being validated.
 */
export const WASM_EXCEPTION_HANDLING_PROBE: readonly number[] = Object.freeze([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11,
])

/**
 * The `WebAssembly.validate` slice this module needs, as an injectable seam so
 * the selector is unit-testable in Node (where the answer is a V8 property,
 * not the browser's). `Uint8Array<ArrayBuffer>` is what `WebAssembly.validate`
 * accepts (`BufferSource`): the probe must never be a shared-memory view.
 */
export type WasmValidate = (bytes: Uint8Array<ArrayBuffer>) => boolean

/**
 * The two bundle pairs the static worker entry ships, keyed by platform tag.
 * `mvp` and `eh` share the same shape (`EngineAssetUrls`), so a selected pair
 * feeds `startEngineWorkerCore({ source: 'static', urls })` unchanged.
 */
export interface EngineBundleAssets {
  /** Legacy pair — the fallback for browsers without wasm EH (`wasm_mvp`). */
  readonly mvp: EngineAssetUrls
  /** Preferred pair when the browser supports wasm EH (`wasm_eh`). */
  readonly eh: EngineAssetUrls
}

/** A fresh, non-shared copy of the probe bytes (what the validator sees). */
function probeBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(WASM_EXCEPTION_HANDLING_PROBE.length)
  bytes.set(WASM_EXCEPTION_HANDLING_PROBE)
  return bytes
}

/** Default seam: the real platform check (invoked per call; its result is never cached). */
const defaultValidate: WasmValidate = WebAssembly.validate.bind(WebAssembly)

/**
 * Does this platform support wasm exception handling? True exactly when
 * `validate` accepts the upstream probe bytes.
 *
 * A throwing validator degrades to `false` on purpose: capability detection
 * must never be able to break the engine boot, and "I cannot answer" has the
 * safe answer — the `mvp` pair, i.e. the package's own fallback. (That bundle's
 * opaque error text is the known non-EH safety net, see ADR 0048 §2.)
 */
export function supportsWasmExceptionHandling(validate: WasmValidate = defaultValidate): boolean {
  try {
    // A fresh copy: `validate` must not be able to mutate the frozen constant,
    // and a detached backing buffer cannot affect the next call.
    return validate(probeBytes())
  } catch {
    return false
  }
}

/**
 * Pick the DuckDB-WASM asset pair for this platform: the `eh` pair when the
 * browser validates the wasm EH probe, the `mvp` pair otherwise (ADR 0048
 * decision 1). Called once per worker, before the core boots.
 */
export function selectEngineBundleAssets(
  bundles: EngineBundleAssets,
  validate: WasmValidate = defaultValidate,
): EngineAssetUrls {
  return supportsWasmExceptionHandling(validate) ? bundles.eh : bundles.mvp
}
