// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `pickDataFile` — the package's picker entry point. It picks the right
 * strategy from detected capabilities (see `capabilities.ts` and the README
 * fallback matrix):
 *
 * - File System Access API available (`window.showOpenFilePicker`) → use it.
 *   The user cancels the native dialog ⇒ resolves `null` (AbortError is
 *   swallowed, everything else propagates).
 * - Otherwise → hidden `<input type="file">` fallback (works in every
 *   browser). Cancel is the input's `cancel` event; on engines without it the
 *   promise stays pending (same trade-off as most picker libraries).
 *
 * Both browser-facing steps are injectable so the selection/composition logic
 * is unit-testable in Node and so hosts (e.g. the M1-3 e2e harness) can drive
 * the File System Access path without a native dialog.
 */
import { BrowserFileSource } from './browser-file-source'
import { detectFileSystemCapabilities } from './capabilities'
import type { BrowserFileSystemCapabilities } from './capabilities'

/** How the picked file was obtained. */
export type PickerStrategy = 'file-system-access' | 'input-fallback'

/** A picked file wrapped in a ready-to-use `DataSource`. */
export interface PickedDataFile {
  readonly via: PickerStrategy
  readonly source: BrowserFileSource
}

/** The four advertised input extensions, in advertised order (R-04). */
export const DATA_FILE_EXTENSIONS = ['.parquet', '.csv', '.jsonl', '.json'] as const

/** accept value shared by the hidden-input fallback and the FSA hints. */
export const DATA_FILE_ACCEPT = DATA_FILE_EXTENSIONS.join(',')

/**
 * File System Access types hints: one standards-valid MIME key per advertised
 * extension (never the invalid wildcard key). The map is hints only — no data
 * validation happens here.
 */
export const DATA_FILE_PICKER_TYPES: readonly FilePickerAcceptType[] = [
  { description: 'Parquet', accept: { 'application/vnd.apache.parquet': ['.parquet'] } },
  { description: 'CSV', accept: { 'text/csv': ['.csv'] } },
  { description: 'JSON Lines', accept: { 'application/x-ndjson': ['.jsonl'] } },
  { description: 'JSON', accept: { 'application/json': ['.json'] } },
]

/** Options the picker passes to the File System Access API. */
export interface ShowOpenFilePickerOptions {
  readonly multiple: false
  readonly types: readonly FilePickerAcceptType[]
  /** Explicit false: keep the picker's standards-valid All files option. */
  readonly excludeAcceptAllOption: false
}

export interface PickerDependencies {
  /** Defaults to `detectFileSystemCapabilities()`. */
  readonly capabilities?: BrowserFileSystemCapabilities
  /** Defaults to the `window.showOpenFilePicker` global; only used when `capabilities.filePicker`. */
  readonly showOpenFilePicker?: (
    options: ShowOpenFilePickerOptions,
  ) => Promise<FileSystemFileHandle[]>
  /** Defaults to the hidden-input DOM implementation; only used on the fallback path. */
  readonly pickViaHiddenInput?: () => Promise<File | null>
}

/**
 * Ask the user to pick a single local data file. Resolves `null` when the
 * user cancels. Never logs anything (ADR 0025).
 */
export async function pickDataFile(deps: PickerDependencies = {}): Promise<PickedDataFile | null> {
  const capabilities = deps.capabilities ?? detectFileSystemCapabilities()

  if (capabilities.filePicker) {
    const showPicker = deps.showOpenFilePicker ?? defaultShowOpenFilePicker
    let handles: FileSystemFileHandle[]
    try {
      handles = await showPicker({
        multiple: false,
        types: DATA_FILE_PICKER_TYPES,
        excludeAcceptAllOption: false,
      })
    } catch (error) {
      if (isAbortError(error)) return null // user dismissed the native dialog
      throw error
    }
    const handle = handles[0]
    if (handle === undefined) return null
    return {
      via: 'file-system-access',
      source: new BrowserFileSource({ fileSystemHandle: handle }),
    }
  }

  const pickViaInput = deps.pickViaHiddenInput ?? pickFileWithHiddenInput
  const file = await pickViaInput()
  if (file === null) return null
  return { via: 'input-fallback', source: new BrowserFileSource({ file }) }
}

function defaultShowOpenFilePicker(
  options: ShowOpenFilePickerOptions,
): Promise<FileSystemFileHandle[]> {
  // Ambient-declared global (src/fsa-dom.d.ts). Only reached when the
  // filePicker capability check above confirmed it exists.
  return showOpenFilePicker(options)
}

/**
 * Hidden `<input type="file">` fallback: universally supported. The input is
 * created, used once, and removed; `change` resolves with the first file,
 * `cancel` (Chromium 113+/Firefox 91+) resolves `null`.
 */
function pickFileWithHiddenInput(): Promise<File | null> {
  if (typeof document === 'undefined') {
    return Promise.reject(
      new Error(
        'pickDataFile: input fallback needs a DOM document — inject `pickViaHiddenInput` for non-DOM environments',
      ),
    )
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = DATA_FILE_ACCEPT
    input.style.display = 'none'
    let settled = false
    const settle = (file: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => {
      settle(input.files?.[0] ?? null)
    })
    input.addEventListener('cancel', () => {
      settle(null)
    })
    document.body.appendChild(input)
    input.click()
  })
}

/** True for the DOMException browsers raise when a picker dialog is dismissed. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
