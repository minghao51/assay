/**
 * Ambient declarations for the slice of the File System Access API that
 * TypeScript 5.9's `lib.dom.d.ts` does not ship yet (`showOpenFilePicker`
 * global and `DataTransferItem.getAsFileSystemHandle`).
 *
 * Mirrors `packages/data-sources/src/fsa-dom.d.ts` (keep in sync, remove when
 * lib.dom ships these): package code is type-checked under *importers'*
 * compiler options (raw-TS exports convention, m1-3), and ambient global
 * declarations travel via tsconfig `include` — not via imports — so the web
 * app's project must declare them itself to compile the browser entry.
 */

/** Options of `window.showOpenFilePicker` — only what this app uses. */
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
