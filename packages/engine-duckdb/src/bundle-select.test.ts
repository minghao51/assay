// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Headless pins for the capability-guarded DuckDB-WASM bundle selection
 * (ADR 0048, row R1-A).
 *
 * The selector is the whole fix for R1 on the web surface: `eh` when the
 * browser validates the wasm exception-handling probe the package's own
 * `getPlatformFeatures()` uses, `mvp` otherwise. These tests pin the decision
 * in both directions, pin the defensive degraded answer, and — the important
 * one — pin the exact bytes handed to `WebAssembly.validate`, so "which
 * capability are we asking about?" cannot change silently.
 *
 * The upstream probe is duplicated here as a literal on purpose: comparing the
 * capture against the module's own constant would keep passing after someone
 * edited the constant, which is exactly the drift this pin exists to catch.
 */
import { describe, expect, it } from 'vitest'
import {
  WASM_EXCEPTION_HANDLING_PROBE,
  selectEngineBundleAssets,
  supportsWasmExceptionHandling,
  type EngineBundleAssets,
  type WasmValidate,
} from './bundle-select.js'
import type { EngineAssetUrls } from './worker-core.js'

/**
 * `@duckdb/duckdb-wasm@1.32.0` (`dist/duckdb-browser.mjs`) — the
 * `wasmExceptions` probe, byte for byte, transcribed from the published
 * package. A change here (or in the constant) means the product asks a
 * different capability question than `selectBundle()` does.
 */
const UPSTREAM_EH_PROBE_BYTES: readonly number[] = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11,
]

const MVP: EngineAssetUrls = {
  duckdbWorkerUrl: '/assets/duckdb-browser-mvp.worker.js',
  duckdbWasmUrl: '/assets/duckdb-mvp.wasm',
}

const EH: EngineAssetUrls = {
  duckdbWorkerUrl: '/assets/duckdb-browser-eh.worker.js',
  duckdbWasmUrl: '/assets/duckdb-eh.wasm',
}

const BUNDLES: EngineBundleAssets = { mvp: MVP, eh: EH }

/** A validator that records every probe it was handed and answers `answer`. */
function recordingValidator(answer: boolean): {
  readonly validate: WasmValidate
  readonly calls: number[][]
} {
  const calls: number[][] = []
  return {
    validate: (bytes) => {
      calls.push(Array.from(bytes))
      return answer
    },
    calls,
  }
}

describe('the wasm exception-handling probe', () => {
  it('is the upstream array, frozen', () => {
    expect(WASM_EXCEPTION_HANDLING_PROBE).toEqual(UPSTREAM_EH_PROBE_BYTES)
    expect(Object.isFrozen(WASM_EXCEPTION_HANDLING_PROBE)).toBe(true)
  })

  it('handed to WebAssembly.validate is byte-identical to the upstream probe', () => {
    // The pin that matters: capture the bytes the selector validates and
    // compare them to the literal upstream sequence. An edit to the constant,
    // a truncation, or a switch to a different feature probe fails here.
    const seen: number[][] = []
    selectEngineBundleAssets(BUNDLES, (bytes) => {
      seen.push(Array.from(bytes))
      return true
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(UPSTREAM_EH_PROBE_BYTES)

    // …and it is a plain non-shared Uint8Array (what `WebAssembly.validate`
    // accepts), not a view over shared memory.
    const validator: WasmValidate = (bytes) => {
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.buffer).toBeInstanceOf(ArrayBuffer)
      expect(bytes.byteLength).toBe(UPSTREAM_EH_PROBE_BYTES.length)
      return true
    }
    selectEngineBundleAssets(BUNDLES, validator)
  })
})

describe('capability detection', () => {
  it('reports wasm exception handling when the probe validates', () => {
    expect(supportsWasmExceptionHandling(() => true)).toBe(true)
  })

  it('reports no wasm exception handling when the probe is rejected', () => {
    expect(supportsWasmExceptionHandling(() => false)).toBe(false)
  })

  it('degrades to false when the validator throws (never breaks the boot)', () => {
    const throwing: WasmValidate = () => {
      throw new Error('Capability detection exploded')
    }
    expect(supportsWasmExceptionHandling(throwing)).toBe(false)
  })
})

describe('bundle selection', () => {
  it('selects the eh pair when the platform validates wasm EH', () => {
    const recorder = recordingValidator(true)
    expect(selectEngineBundleAssets(BUNDLES, recorder.validate)).toEqual(EH)
    expect(recorder.calls).toHaveLength(1)
  })

  it('selects the mvp pair when the platform rejects wasm EH', () => {
    const recorder = recordingValidator(false)
    expect(selectEngineBundleAssets(BUNDLES, recorder.validate)).toEqual(MVP)
    expect(recorder.calls).toHaveLength(1)
  })

  it('selects the mvp pair when the validator throws', () => {
    const validate: WasmValidate = () => {
      throw new Error('no WebAssembly here')
    }
    expect(selectEngineBundleAssets(BUNDLES, validate)).toEqual(MVP)
  })

  it('asks the platform exactly once per selection', () => {
    // Two selections ask twice: the probe answers "what can this platform do",
    // and the selector must not spend a second validation on a bundle choice.
    const seen: number[][] = []
    const validate: WasmValidate = (bytes) => {
      seen.push(Array.from(bytes))
      return true
    }
    selectEngineBundleAssets(BUNDLES, validate)
    selectEngineBundleAssets(BUNDLES, validate)
    expect(seen).toHaveLength(2)
  })

  it('defaults to the real WebAssembly.validate seam', () => {
    // The executable answer is the host's business (Node's V8 validates wasm
    // EH, a pre-EH browser does not), so this pins only that the default path
    // is wired and returns a boolean instead of throwing.
    expect(typeof supportsWasmExceptionHandling()).toBe('boolean')
  })
})
