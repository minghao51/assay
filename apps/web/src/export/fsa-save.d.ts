// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ambient declarations for the File System Access **save** entry point
 * (`showSaveFilePicker`) that TypeScript 5.9's `lib.dom.d.ts` does not ship
 * yet. Typed locally instead of falling back to `any` (AGENTS.md: strict
 * TypeScript). The *open* half lives in `@assay/data-sources`'s
 * `fsa-dom.d.ts`, which `apps/web`'s tsconfig path-includes; this package is
 * not modified (m4-5 authorization boundary).
 *
 * Feature-detected at runtime (`save-destination.ts`), never assumed.
 */

/** The subset of `SaveFilePickerOptions` this app passes. */
interface SaveFilePickerOptions {
  readonly suggestedName?: string
}

/** File System Access save picker global (Chromium; feature-detected at runtime). */
declare function showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
