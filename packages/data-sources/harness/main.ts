/**
 * Browser harness for the M1-3 e2e proof (tests/e2e/data-sources.spec.ts):
 * exercises both `pickDataFile` paths against a real Chromium.
 *
 * - File System Access path: the page synthesizes a *real*
 *   `FileSystemFileHandle` without any native dialog and injects it as the
 *   picker into `pickDataFile`, which then takes the same FSA branch a real
 *   `showOpenFilePicker` click would. Synthesis mechanism: staging the
 *   fixture bytes in the origin's private OPFS sandbox and taking its
 *   handle. (The DataTransfer → items.add(file) → getAsFileSystemHandle()
 *   trick suggested for this does NOT yield a handle for JS-constructed
 *   Files — Chromium resolves `undefined` because such a File has no
 *   file-system entry; an OPFS handle is a genuine FileSystemFileHandle
 *   whose getFile() works. OPFS use here is a disposable e2e cache,
 *   within ADR 0017's allowance.)
 * - Fallback path: runs `pickDataFile` with injected capabilities that report
 *   no FSA picker, so the package's hidden-`<input type="file">`
 *   implementation is used; Playwright intercepts the file chooser.
 *
 * Not a shipped surface — it exists only in this package's `vite build`
 * output. The fixture is a copy of fixtures/csv/customers.csv (checksum
 * 202ea367…) served from harness/public/.
 */
import { detectFileSystemCapabilities, pickDataFile } from '../src/browser'
import type { PickedDataFile } from '../src/browser'
import { createBrowserFileSourceBehaviorSubject } from '../src/behavior-subject'
import { dataSourceBehaviorScenarioNames, runDataSourceBehaviorScenarios } from '@assay/testing'
import type { DataSourceBehaviorScenarioName } from '@assay/testing'

const openFsaButton = requiredElement<HTMLButtonElement>('#open-via-fsa')
const openFallbackButton = requiredElement<HTMLButtonElement>('#open-via-input-fallback')

openFsaButton.addEventListener('click', () => {
  void openViaFileSystemAccess()
})
openFallbackButton.addEventListener('click', () => {
  void openViaInputFallback()
})

const caps = detectFileSystemCapabilities()
setText('caps-file-picker', String(caps.filePicker))
setText('caps-data-transfer-handle', String(caps.dataTransferHandle))

// ── T3 data-source behavior suite (tests/e2e/data-source-behavior.spec.ts) ──
//
// Each button runs ONE scenario from the shared suite in @assay/testing
// against the REAL BrowserFileSource in this browser context: genuine
// OPFS-staged FileSystemFileHandles (ADR 0017 disposable-cache framing — same
// trick as the m1-3 sections above) and the real browser capability globals.
// Results render as JSON (`DataSourceBehaviorScenarioResult`); the spec
// asserts each scenario's `passed` and evidence facts. The suite — not this
// harness — owns the scenario logic; this wiring only hosts the subject
// adapter. Privacy (ADR 0001/0025): file names here are synthetic suite
// fixtures; reports contain ids, counts, and flags only.
const behaviorSubject = createBrowserFileSourceBehaviorSubject({
  stageHandle: async (file) => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(file.name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(await file.arrayBuffer())
    await writable.close()
    return handle
  },
})

async function runBehaviorScenario(name: DataSourceBehaviorScenarioName): Promise<void> {
  const report = await runDataSourceBehaviorScenarios(behaviorSubject, [name])
  const result = report.results[0]
  if (result !== undefined) {
    setText(`behavior-result-${name}`, JSON.stringify(result, null, 2))
  }
}

async function runAllBehaviorScenarios(): Promise<void> {
  const report = await runDataSourceBehaviorScenarios(behaviorSubject)
  setText('behavior-run-all', JSON.stringify(report, null, 2))
}

for (const name of dataSourceBehaviorScenarioNames) {
  requiredElement<HTMLButtonElement>(`#behavior-${name}`).addEventListener('click', () => {
    void runBehaviorScenario(name)
  })
}
requiredElement<HTMLButtonElement>('#behavior-run-all').addEventListener('click', () => {
  void runAllBehaviorScenarios()
})

async function openViaFileSystemAccess(): Promise<void> {
  try {
    const fileHandle = await stageFixtureInOpfs()
    // No native dialog: inject the synthesized handle as the FSA picker. The
    // real Chromium capabilities route this through the FSA branch, exactly
    // as a genuine showOpenFilePicker call would.
    const picked = await pickDataFile({
      showOpenFilePicker: async () => [fileHandle],
    })
    await renderPicked(picked)
  } catch (error) {
    renderError(error)
  }
}

/**
 * Build a real FileSystemFileHandle for the fixture without any dialog:
 * copy the fetched bytes into the OPFS sandbox (disposable cache, ADR 0017)
 * and return its handle. Recreating on every click keeps this idempotent.
 */
async function stageFixtureInOpfs(): Promise<FileSystemFileHandle> {
  const file = await fetchCustomerFixture()
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(file.name, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(file)
  await writable.close()
  return fileHandle
}

async function openViaInputFallback(): Promise<void> {
  try {
    // Force the fallback branch even in Chromium (which has the FSA picker):
    // this is what a Firefox-class browser looks like to the package.
    const picked = await pickDataFile({
      capabilities: { filePicker: false, dataTransferHandle: false },
    })
    await renderPicked(picked)
  } catch (error) {
    renderError(error)
  }
}

async function fetchCustomerFixture(): Promise<File> {
  const response = await fetch('/customers.csv')
  if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${response.status}`)
  const blob = await response.blob()
  return new File([blob], 'customers.csv', { type: 'text/csv' })
}

/** Open the picked source twice and render the contract surfaces under test. */
async function renderPicked(picked: PickedDataFile | null): Promise<void> {
  if (picked === null) {
    setText('source-status', 'cancelled')
    return
  }
  const { source } = picked
  const first = await source.open()
  const second = await source.open()
  const metadata = await source.metadata()

  setText('source-status', 'picked')
  setText('picked-via', picked.via)
  setText('source-kind', source.kind)
  setText('handle-kind', first.kind)
  setText('source-id-1', first.sourceId)
  setText('source-id-2', second.sourceId)
  setText('ids-match', String(first === second))
  setText('meta-format', metadata.format)
  setText('meta-size', String(metadata.sizeBytes))
}

function renderError(error: unknown): void {
  setText('source-status', 'error')
  setText('picked-via', `error: ${error instanceof Error ? error.message : String(error)}`)
}

function setText(testId: string, value: string): void {
  requiredElement<HTMLElement>(`[data-testid="${testId}"]`).textContent = value
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) {
    throw new Error(`harness is missing element ${selector}`)
  }
  return element
}
