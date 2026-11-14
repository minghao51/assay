import path from 'node:path'
import { expect, test } from './support/fixture'

// ug-14 / UG-5 — open-failure recovery, in a real browser.
//
// The open chain is unchanged: the picker hands the file to the SAME guarded
// `openDataFile` path, the engine refuses a corrupt Parquet file, and the
// `open-error` alert must present (a) a one-line human cause that is NOT the
// raw DuckDB diagnostic, (b) a `Choose a different file…` retry that
// re-triggers that same open path, and (c) the full multi-line engine text
// only behind a collapsed `<details>` disclosure. The retry leg then opens a
// readable fixture and reaches `ready`, proving recovery — not just the error
// state.
//
// The corrupt fixture is synthetic (`fixtures/invalid/README.md`); the copy is
// value- and filename-free (ADR 0025).

const CORRUPT_FIXTURE = path.join(process.cwd(), 'fixtures', 'invalid', 'corrupt.parquet')
const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

// Picker path (the m1-5 pattern every spec uses): Playwright's filechooser
// interception does not reach `window.showOpenFilePicker`, so remove the FSA
// global and let capability detection take the hidden-input fallback the
// chooser event carries.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable global would fail loudly at the chooser instead.
    }
  })
})

/**
 * The truthful cause for the corrupt fixture (UG-5, ADR 0048).
 *
 * With a wasm exception-handling-capable browser the engine selects its `eh`
 * DuckDB-WASM pair, so the reader's real refusal reaches the client:
 * `Invalid Input Error: No magic bytes found at end of file 't1'`. That is
 * file-read evidence, and the app's classifier turns it into the `unreadable`
 * cause below (the same copy the unit suite pins in
 * `apps/web/src/edit/session.test.ts`). Before ADR 0048 the `mvp` glue masked
 * the failure as `_setThrew is not defined`, which is not file evidence and
 * fell through to the cause-neutral "You can try another file." — that
 * fallback is now only the non-EH-browser safety net.
 */
const UNREADABLE_CAUSE =
  'The file could not be opened. The file could not be read. ' +
  'It may be corrupt, truncated, or not the format its name suggests.'

test('a corrupt file shows a one-line cause, retries through the same open path, and recovers', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })

  const firstChooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await firstChooser).setFiles(CORRUPT_FIXTURE)

  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'error', {
    timeout: 20_000,
  })

  // (a) One-line human cause — the raw engine diagnostic is not the cause; the
  // classified cause names what actually happened to this file.
  const alert = page.getByTestId('open-error')
  await expect(alert).toHaveAttribute('role', 'alert')
  const cause = page.getByTestId('open-error-cause')
  await expect(cause).toHaveText(UNREADABLE_CAUSE)
  // The raw engine detail never becomes the visible cause, and the cause is a
  // single line (UG-30).
  expect(await cause.innerText()).not.toMatch(/_setThrew|magic bytes|read_parquet/i)
  expect((await cause.innerText()).split('\n')).toHaveLength(1)

  // (b) Retry label is exactly the specified copy (single U+2026 ellipsis).
  await expect(page.getByTestId('open-error-retry')).toHaveText('Choose a different file…')

  // (c) The full engine text lives behind a COLLAPSED disclosure — and it is
  // the engine's REAL first line (ADR 0048): the corrupt Parquet reader refusing
  // the file, not the shipped `mvp` glue's opaque `ReferenceError`. The message
  // names the engine-generated table id, never the picked file (ADR 0025).
  const details = page.getByTestId('open-error-details')
  await expect(details).toHaveJSProperty('open', false)
  const detail = page.getByTestId('open-error-detail')
  await expect(detail).toContainText('Invalid Input Error: No magic bytes found at end of file')
  expect((await detail.textContent()) ?? '').not.toMatch(/_setThrew/)
  await details.locator('summary').click()
  await expect(details).toHaveJSProperty('open', true)
  await expect(detail).toBeVisible()

  // The failure stays local: the existing Open control is still usable.
  await expect(page.getByTestId('open-button')).toBeEnabled()

  // Retry re-triggers the SAME open path: a picker appears again, and a
  // readable file completes the open.
  const retryChooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-error-retry').click()
  await (await retryChooser).setFiles(CUSTOMERS_FIXTURE)

  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('open-error')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
})
