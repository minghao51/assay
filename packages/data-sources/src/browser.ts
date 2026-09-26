// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@assay/data-sources/browser` — the browser-flavored entry of this package
 * (M1-3): `BrowserFileSource`, file-system capability detection, format
 * detection, and `pickDataFile`.
 *
 * Why a subpath entry: packages here export raw TypeScript source, so any
 * importer type-checks these files under its own compiler options. This
 * module names DOM types (`File`, `FileSystemFileHandle`, `document`),
 * which need `lib: DOM` — keeping them out of the environment-neutral root
 * entry (`.`) lets `@assay/engine` (no DOM lib) keep importing the
 * `DataSource` interfaces. Import this entry only from DOM-typed contexts
 * (web app, webview, harness).
 */
export { BrowserFileSource } from './browser-file-source'
export type { BrowserFileSourceInput } from './browser-file-source'
export { detectFileSystemCapabilities } from './capabilities'
export type { BrowserFileSystemCapabilities, FileSystemCapabilityScope } from './capabilities'
export { detectFormatFromFileName } from './detect-format'
export type { DatasetFileFormat } from './detect-format'
export { pickDataFile } from './pick-file'
export type {
  PickedDataFile,
  PickerDependencies,
  PickerStrategy,
  ShowOpenFilePickerOptions,
} from './pick-file'
