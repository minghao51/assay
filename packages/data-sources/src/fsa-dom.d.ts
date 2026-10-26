// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ambient declarations for the slice of the File System Access API that
 * TypeScript 5.9's `lib.dom.d.ts` does not ship yet (`showOpenFilePicker`
 * global and `DataTransferItem.getAsFileSystemHandle`). Typed locally instead
 * of falling back to `any` (AGENTS.md: strict TypeScript, no unexplained
 * `any`). Remove once the declarations land in lib.dom.
 *
 * Single source of truth (consolidated in m2-3; this package owns it).
 * Ambient global declarations travel via tsconfig `include` — never via
 * imports (a global-script `.d.ts` cannot be re-exported) — and this
 * package's raw-TS browser exports are type-checked under *importers*'
 * compiler options (m1-3 convention). Consumers that compile those exports
 * in their own program (currently `apps/web`) therefore path-include this
 * exact file from their tsconfig instead of keeping a mirrored copy.
 */

/** One picker type hint: a MIME key mapped to the extensions it admits. */
interface FilePickerAcceptType {
  readonly description?: string
  readonly accept: Readonly<Record<string, readonly string[]>>
}

/** Options of `window.showOpenFilePicker` — only what this package uses. */
interface OpenFilePickerOptions {
  readonly multiple?: boolean
  readonly types?: readonly FilePickerAcceptType[]
  readonly excludeAcceptAllOption?: boolean
}

/** File System Access API picker global (Chromium; feature-detected at runtime). */
declare function showOpenFilePicker(
  options?: OpenFilePickerOptions,
): Promise<FileSystemFileHandle[]>

/** Chromium extension: obtain a file-system handle for a drag/paste item. */
interface DataTransferItem {
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>
}
