/**
 * Ambient declarations for the slice of the File System Access API that
 * TypeScript 5.9's `lib.dom.d.ts` does not ship yet (`showOpenFilePicker`
 * global and `DataTransferItem.getAsFileSystemHandle`). Typed locally instead
 * of falling back to `any` (AGENTS.md: strict TypeScript, no unexplained
 * `any`). Remove once the declarations land in lib.dom.
 */

/** Options of `window.showOpenFilePicker` — only what this package uses. */
interface OpenFilePickerOptions {
  multiple?: boolean
}

/** File System Access API picker global (Chromium; feature-detected at runtime). */
declare function showOpenFilePicker(
  options?: OpenFilePickerOptions,
): Promise<FileSystemFileHandle[]>

/** Chromium extension: obtain a file-system handle for a drag/paste item. */
interface DataTransferItem {
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>
}
