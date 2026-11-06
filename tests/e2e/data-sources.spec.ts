import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './support/fixture'

// Task M1-3 proof (handoff §6 #3): picking a file → DataSource.open() works,
// for BOTH picker paths, in real Chromium. The harness
// (packages/data-sources/harness, served by the third webServer in
// playwright.config.ts) renders results strictly through the package's
// public API (DataHandle fields, metadata format/size) and never shows the
// picked file's name (ADR 0001/0025).
//
// - File System Access path without a native dialog: the page synthesizes a
//   real FileSystemFileHandle by staging the fixture in the OPFS sandbox and
//   injecting its handle into pickDataFile. (The DataTransfer → items.add →
//   getAsFileSystemHandle trick does not yield a handle for JS-constructed
//   Files — Chromium resolves undefined; see harness/main.ts.)
// - Fallback path: Playwright intercepts the hidden <input type="file"> the
//   package creates and sets files on it (chooser.setFiles — the dynamic-input
//   form of page.setInputFiles).
// Data-sources-harness port is env-overridable for parallel worktree batches
// (must match ASSAY_E2E_PORT_DS in playwright.config.ts; default 4180).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_DS'] ?? 4180}/`
const FIXTURE_PATH = fileURLToPath(
  new URL('../../packages/data-sources/harness/public/customers.csv', import.meta.url),
)
const EXPECTED_SIZE_BYTES = readFileSync(FIXTURE_PATH).byteLength

test('real Chromium reports the File System Access capabilities the package detects', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)

  // Capability detection against the live API surface (risk R5).
  await expect(page.getByTestId('caps-file-picker')).toHaveText('true')
  await expect(page.getByTestId('caps-data-transfer-handle')).toHaveText('true')
  await expect(page.getByTestId('source-status')).toHaveText('idle')
})

test('File System Access path: picking a synthesized handle → open() + metadata() work', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: /File System Access API/ }).click()

  await expect(page.getByTestId('source-status')).toHaveText('picked')
  await expect(page.getByTestId('picked-via')).toHaveText('file-system-access')

  // DataHandle is well-formed and the source id is stable across re-open()
  // (same handle object — the harness renders both ids and their identity).
  await expect(page.getByTestId('source-kind')).toHaveText('browser-file')
  await expect(page.getByTestId('handle-kind')).toHaveText('data-handle')
  const firstId = await page.getByTestId('source-id-1').textContent()
  expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  await expect(page.getByTestId('source-id-2')).toHaveText(firstId ?? '')
  await expect(page.getByTestId('ids-match')).toHaveText('true')

  // metadata(): format from the extension, exact size, no dataset bytes read.
  await expect(page.getByTestId('meta-format')).toHaveText('csv')
  await expect(page.getByTestId('meta-size')).toHaveText(String(EXPECTED_SIZE_BYTES))
})

test('input fallback path: picking through the hidden input → open() + metadata() work', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)

  // The package creates its input dynamically, so Playwright's file-chooser
  // interception is the setInputFiles mechanism that reaches it.
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /input fallback/ }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE_PATH)

  await expect(page.getByTestId('source-status')).toHaveText('picked')
  await expect(page.getByTestId('picked-via')).toHaveText('input-fallback')

  await expect(page.getByTestId('source-kind')).toHaveText('browser-file')
  await expect(page.getByTestId('handle-kind')).toHaveText('data-handle')
  const firstId = await page.getByTestId('source-id-1').textContent()
  expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  await expect(page.getByTestId('source-id-2')).toHaveText(firstId ?? '')
  await expect(page.getByTestId('ids-match')).toHaveText('true')

  await expect(page.getByTestId('meta-format')).toHaveText('csv')
  await expect(page.getByTestId('meta-size')).toHaveText(String(EXPECTED_SIZE_BYTES))
})
