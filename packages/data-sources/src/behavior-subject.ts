// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The BrowserFileSource adapter for the data-source behavior suite in
 * `@assay/testing` (task T3; docs/engineering/03-repository-structure.md §4).
 *
 * Dependency direction: implementations import the testing package — never
 * the reverse — so the suite stays implementation-agnostic and a future
 * source (BrowserDirectorySource, VSCodeWorkspaceSource) can run the same
 * scenarios by providing its own subject.
 *
 * This module is internal to the package (not part of the `.` or `./browser`
 * entries): the Node unit test (`src/behavior-subject.test.ts`) and the
 * browser harness (`harness/main.ts`) import it directly. It names DOM types,
 * which is safe because nothing outside the package can import it.
 *
 * Staging: `makeHandle` defaults to an in-memory `FileSystemFileHandle`
 * stand-in (enough for Node vitest, mirroring the fakes in the package's own
 * unit tests); browser contexts pass `stageHandle`, which stages the file in
 * the OPFS sandbox and returns the genuine handle (ADR 0017 disposable-cache
 * framing — the same trick as the m1-3 harness).
 *
 * Privacy (ADR 0001/0025): every file name here is a synthetic suite fixture
 * (`assay-behavior-…`); the suite's reports contain ids, counts, and flags
 * only — never dataset contents or user files.
 */
import { BrowserFileSource } from './browser-file-source'
import { detectFileSystemCapabilities } from './capabilities'
import { pickDataFile } from './pick-file'
import type {
  BehaviorCapabilityScope,
  BehaviorFile,
  BehaviorFileHandle,
  BehaviorPickSteps,
  BehaviorPickedFile,
  DataSourceBehaviorSubject,
} from '@assay/testing'
import type { ShowOpenFilePickerOptions } from './pick-file'

export interface BrowserFileSourceBehaviorSubjectOptions {
  /**
   * Provide a genuine `FileSystemFileHandle` serving the given file's name and
   * bytes. Defaults to an in-memory stand-in (Node); the harness passes an
   * OPFS-backed stager so the suite runs against real handles.
   */
  readonly stageHandle?: (file: File) => Promise<FileSystemFileHandle>
}

/** In-memory `FileSystemFileHandle` stand-in for the handle path (same fake as the package's unit tests). */
function inMemoryHandle(file: File): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: async () => file,
    isSameEntry: async () => false, // unused by the package; required by the interface
    createWritable: async () => {
      throw new Error('createWritable is not part of the read-only source contract')
    },
  }
}

/**
 * The suite's structural types are satisfied here only by objects this
 * adapter constructed itself (`makeFile`, `makeHandle`, `stageHandle`, or the
 * injected steps built on them), so the runtime values really are the DOM
 * objects the `BrowserFileSource`/`pickDataFile` signatures ask for.
 */
function asFile(file: BehaviorFile): File {
  return file as File
}

function asFileSystemHandle(handle: BehaviorFileHandle): FileSystemFileHandle {
  return handle as FileSystemFileHandle
}

export function createBrowserFileSourceBehaviorSubject(
  options: BrowserFileSourceBehaviorSubjectOptions = {},
): DataSourceBehaviorSubject {
  const defaultStageHandle = async (file: File): Promise<FileSystemFileHandle> =>
    inMemoryHandle(file)
  const stageHandle = options.stageHandle ?? defaultStageHandle
  return {
    name: 'browser-file-source',
    makeFile: (name, sizeBytes) => new File([new Uint8Array(sizeBytes)], name),
    makeHandle: async (file) => stageHandle(asFile(file)),
    createFallbackSource: (file) => new BrowserFileSource({ file: asFile(file) }),
    createHandleSource: (handle) =>
      new BrowserFileSource({ fileSystemHandle: asFileSystemHandle(handle) }),
    pick: async (steps: BehaviorPickSteps): Promise<BehaviorPickedFile | null> => {
      const fsaPicker = steps.showOpenFilePicker
      const inputPick = steps.pickViaHiddenInput
      const picked = await pickDataFile({
        // The suite's capability/scope types are structural mirrors of the
        // package's own — no adaptation needed beyond the handle/file seams.
        capabilities: steps.capabilities,
        showOpenFilePicker: fsaPicker
          ? async (pickerOptions: ShowOpenFilePickerOptions) =>
              (await fsaPicker(pickerOptions)).map(asFileSystemHandle)
          : undefined,
        pickViaHiddenInput: inputPick
          ? async () => {
              const file = await inputPick()
              return file === null ? null : asFile(file)
            }
          : undefined,
      })
      return picked === null ? null : { via: picked.via, source: picked.source }
    },
    detectCapabilities: (scope?: BehaviorCapabilityScope) => detectFileSystemCapabilities(scope),
  }
}
