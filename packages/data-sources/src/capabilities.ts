// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Capability detection for browser file-system APIs (roadmap risk R5: engines
 * diverge across browsers, so the package decides per capability instead of
 * per user agent).
 *
 * The detector inspects a structural snapshot of the globals it cares about,
 * so unit tests can inject fake scopes in Node; production callers use the
 * default (`globalThis`). No user data is consulted — detection only checks
 * for the *existence* of API functions.
 */

/**
 * What the current browser can do for local file picking.
 *
 * See the package README for the full per-browser fallback matrix.
 */
export interface BrowserFileSystemCapabilities {
  /**
   * `window.showOpenFilePicker()` exists — the File System Access API picker
   * path is available (Chromium-based browsers today).
   */
  readonly filePicker: boolean
  /**
   * `DataTransferItem.getAsFileSystemHandle()` exists (Chromium today) — a
   * page can turn a dropped/pasted/programmatically-added `File` into a real
   * `FileSystemFileHandle` without a native dialog.
   */
  readonly dataTransferHandle: boolean
}

/**
 * Structural view of the browser globals the detector needs. Both members
 * are optional so any environment (browser, Node, test double) conforms.
 */
export interface FileSystemCapabilityScope {
  readonly showOpenFilePicker?: unknown
  readonly DataTransferItem?: {
    readonly prototype: {
      readonly getAsFileSystemHandle?: unknown
    }
  }
}

/** Detect browser file-system capabilities against `scope` (default: `globalThis`). */
export function detectFileSystemCapabilities(
  scope: FileSystemCapabilityScope = globalThis,
): BrowserFileSystemCapabilities {
  return {
    filePicker: typeof scope.showOpenFilePicker === 'function',
    dataTransferHandle:
      typeof scope.DataTransferItem?.prototype.getAsFileSystemHandle === 'function',
  }
}
