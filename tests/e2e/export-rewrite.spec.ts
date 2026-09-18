import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'

// Task m4-5 proof (handoff §6): the export/rewrite UX over the m4-2 export op.
// The app under test is the real composition root served at '/' by the first
// webServer in playwright.config.ts, opened on the committed golden fixture
// customers.parquet (5 rows; income of customer 3 is NULL):
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Requested pins (done-when):
//   1. from an EDITED overlay (a bait cell + an inserted row), export CSV and
//      JSONL through the dialog;
//   2. the formula-injection bait `=SUM(A1:A2)` is apostrophe-prefixed in the
//      CSV file but raw in the JSONL file (m4-2's guard, observed end-to-end);
//   3. re-opening the exported JSONL through the normal open flow shows the
//      edited content (the bait cell and the inserted row);
//   4. the dialog copy never implies in-place modification (ADR 0012): it says
//      "new file" and "The opened file is not changed", never "overwrite"/"in
//      place"; and the result line reports the engine's honest format/rows/size.
//
// Picker path (m1-5 pattern): Playwright's filechooser interception does NOT
// reach window.showOpenFilePicker, so an init script removes the FSA globals.
// The SAME script removes `showSaveFilePicker`, forcing the dialog's
// anchor-download fallback, whose download this spec captures and re-opens
// through the filechooser flow. Privacy (ADR 0025): the picked file name is
// never rendered.
//
// Fix-round pins (m4-5 review): (1) a save picker aimed at the opened file is
// refused before any engine work or byte write (ADR 0012 data-loss guard);
// (2) with a grid filter active, the dialog shows the effective unfiltered
// count, says filters are not applied, and the copy really holds every row;
// (3) the arrow guidance names an interchange format for other tools instead
// of promising a re-open, and the bytes match the advertised IPC stream type.

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser/download rather than silently.
    }
  })
})

async function openFixture(page: Page, fixturePath: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixturePath)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
}

function row(page: Page, index: number): Locator {
  return page.locator(`[data-testid="grid-row"][data-row-index="${String(index)}"]`)
}

function cell(page: Page, rowIndex: number, columnIndex: number): Locator {
  return row(page, rowIndex).getByTestId('grid-cell').nth(columnIndex)
}

/** Double-click a ready cell, wait for its inline editor, commit `value`. */
async function editCell(page: Page, rowIndex: number, columnIndex: number, value: string) {
  await expect(row(page, rowIndex)).toHaveAttribute('data-status', 'ready')
  await cell(page, rowIndex, columnIndex).dblclick()
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toBeVisible()
  await editor.fill(value)
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

/** Export through the dialog, capturing the download the fallback triggers. */
async function exportFormat(page: Page, format: string): Promise<Download> {
  await page.getByTestId(`export-format-${format}`).check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-confirm').click()
  return downloadPromise
}

/** Apply one column predicate through the filter bar (m2-3 pattern). */
async function filterBy(page: Page, column: string, predicate: string): Promise<void> {
  await page.locator(`[data-testid="filter-input"][data-col-name="${column}"]`).fill(predicate)
  await page.locator(`[data-testid="filter-apply"][data-col-name="${column}"]`).click()
}

/**
 * Playwright's `download.path()` is a generated temp name without the
 * suggested extension; the engine detects a file's format from the extension,
 * so persist the download under its suggested name (in a temp dir) before
 * reading or re-opening it.
 */
async function saveDownload(download: Download): Promise<string> {
  const target = path.join(
    tmpdir(),
    `assay-m4-5-${String(Date.now())}-${download.suggestedFilename()}`,
  )
  await download.saveAs(target)
  return target
}

test('export a copy from an edited overlay: CSV sanitized, JSONL raw, and the export re-opens', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, FIXTURE)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // --- Edit the overlay: a formula-injection bait cell + an inserted row. ---
  await editCell(page, 0, 1, '=SUM(A1:A2)') // country (VARCHAR) of customer 1
  await page.getByTestId('edit-insert-row').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  await editCell(page, 5, 1, 'INSERTED_ROW') // country of the appended row
  await expect(cell(page, 0, 1)).toHaveText('=SUM(A1:A2)')

  // --- The dialog: copy, never rewrite (ADR 0012). ---
  await page.getByTestId('export-open').click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  const notice = page.getByTestId('export-copy-notice')
  await expect(notice).toContainText('new file')
  await expect(notice).toContainText('The opened file is not changed')
  await expect(dialog).not.toContainText(/overwrit|in place|in-place/i)
  // The current edited view's row count is engine-backed, and the dialog is
  // honest that the engine exposes no user-adjustable format options.
  await expect(page.getByTestId('export-view-rows')).toHaveText('6 rows')
  await expect(page.getByTestId('export-options-note')).toContainText('no user-adjustable options')

  // --- CSV: the bait is apostrophe-prefixed, and the inserted row is present. ---
  const csvDownload = await exportFormat(page, 'csv')
  const csvResult = page.getByTestId('export-result')
  await expect(csvResult).toContainText('Exported 6 rows as CSV')
  await expect(csvResult).toContainText('new file')
  await expect(csvResult).toContainText('The opened file is unchanged')
  const csvPath = await saveDownload(csvDownload)
  const csvText = readFileSync(csvPath, 'utf8')
  expect(csvText.split('\n')[0]).toBe('customer_id,country,income,signup_date')
  // Sanitized: a leading apostrophe marks the cell as text (m4-2 guard).
  expect(csvText).toContain("'=SUM(A1:A2)")
  expect(csvText).not.toContain(',=SUM(A1:A2)')
  expect(csvText).toContain('INSERTED_ROW')

  // --- JSONL: the same cell is raw (JSONL/JSON are deliberately unguarded). ---
  const jsonlDownload = await exportFormat(page, 'jsonl')
  await expect(page.getByTestId('export-result')).toContainText('Exported 6 rows as JSON Lines')
  const jsonlPath = await saveDownload(jsonlDownload)
  expect(path.extname(jsonlPath)).toBe('.jsonl')
  const jsonlText = readFileSync(jsonlPath, 'utf8')
  expect(jsonlText).toContain('"country":"=SUM(A1:A2)"')
  expect(jsonlText).not.toContain("'=SUM(A1:A2)")
  expect(jsonlText).toContain('"country":"INSERTED_ROW"')
  // One JSON object per line — 6 exported rows.
  expect(jsonlText.trimEnd().split('\n')).toHaveLength(6)

  await page.getByTestId('export-close').click()
  await expect(dialog).toHaveCount(0)

  // --- Re-open the exported file through the normal open flow. ---
  await openFixture(page, jsonlPath)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  await expect(row(page, 0)).toHaveAttribute('data-status', 'ready')
  // The edited bait cell comes back exactly as written (raw JSONL, no guard).
  await expect(cell(page, 0, 1)).toHaveText('=SUM(A1:A2)')
  // The inserted row survived the round-trip too.
  await expect(cell(page, 5, 1)).toHaveText('INSERTED_ROW')
  await expect(row(page, 5)).toHaveAttribute('data-status', 'ready')
})

test('the source fixture is never written by an export (ADR 0012)', async ({ page }) => {
  test.setTimeout(180_000)
  const before = readFileSync(FIXTURE)
  await openFixture(page, FIXTURE)
  await editCell(page, 0, 1, 'ZZZ')
  await page.getByTestId('export-open').click()
  const download = await exportFormat(page, 'csv')
  await download.path()
  await expect(page.getByTestId('export-result')).toContainText('Exported 5 rows as CSV')
  // Byte-identical source: the export wrote a new file, never the source.
  expect(readFileSync(FIXTURE).equals(before)).toBe(true)
})

test('a dismissed save picker reports cancellation and writes nothing', async ({ page }) => {
  test.setTimeout(180_000)
  // Re-add a save picker that behaves like a user dismiss (AbortError) — the
  // File System Access path is not reachable through a native dialog in tests,
  // so this seam exercises the dialog's cancel handling end-to-end.
  await page.addInitScript(() => {
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = () =>
      Promise.reject(Object.assign(new Error('dismissed'), { name: 'AbortError' }))
  })
  await openFixture(page, FIXTURE)
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-confirm').click()
  await expect(page.getByTestId('export-cancelled')).toContainText('no new file was written')
  await expect(page.getByTestId('export-result')).toHaveCount(0)
  await expect(page.getByTestId('export-error')).toHaveCount(0)
})

// m4-5 fix round (reviewer finding 1): the save picker can return the opened
// source's own entry, and a direct handle write then replaces the source (a
// real FSA probe turned a 682-byte Parquet file into 144 bytes of CSV while
// the UI claimed the source was unchanged). This pin drives the app through
// the input-fallback open (the identity-probe path: name+size+lastModified)
// against a fake picker whose handle's file MATCHES the opened source. The
// app must refuse before any engine work or byte write; the fake writable
// records instead of writing, so a missing guard fails on the refusal
// assertions — never by corrupting the golden fixture.
test('a save picker aimed at the opened file is refused before any write', async ({ page }) => {
  test.setTimeout(180_000)
  const before = readFileSync(FIXTURE)
  const { size, mtimeMs } = statSync(FIXTURE)
  await page.addInitScript(
    ({ sourceName, sourceSize, sourceLastModified }) => {
      ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => {
        const probe = { wrote: false }
        ;(window as { __assaySameSourceProbe?: { wrote: boolean } }).__assaySameSourceProbe = probe
        return Promise.resolve({
          getFile: async () =>
            new File([new Uint8Array(sourceSize)], sourceName, {
              lastModified: sourceLastModified,
            }),
          createWritable: async () => ({
            write: async () => {
              probe.wrote = true
            },
            close: async () => undefined,
          }),
        })
      }
    },
    {
      sourceName: path.basename(FIXTURE),
      sourceSize: size,
      // Playwright wires stat.mtimeMs (float) into the input File's
      // lastModified, and the browser coerces it to an integer by truncation
      // (WebIDL long long) — mirror exactly that, or the probe mismatches by
      // a millisecond and the guard legitimately finds "different file".
      sourceLastModified: Math.trunc(mtimeMs),
    },
  )
  await openFixture(page, FIXTURE)
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-format-csv').check()
  await page.getByTestId('export-confirm').click()
  const refused = page.getByTestId('export-refused')
  await expect(refused).toBeVisible()
  await expect(refused).toContainText('That is the opened file')
  await expect(refused).toContainText('different name or location')
  // Refusal precedes engine work: no result line, no error, and the fake
  // writable was never acquired — no bytes anywhere, the source included.
  await expect(page.getByTestId('export-result')).toHaveCount(0)
  await expect(page.getByTestId('export-error')).toHaveCount(0)
  const probe = await page.evaluate(
    () => (window as { __assaySameSourceProbe?: { wrote: boolean } }).__assaySameSourceProbe,
  )
  expect(probe?.wrote ?? false).toBe(false)
  // The opened file is byte-identical.
  expect(readFileSync(FIXTURE).equals(before)).toBe(true)
})

// m4-5 fix round (reviewer finding 2): the dialog used to echo the grid's
// FILTERED count while `exportView` exported the unfiltered, naturally
// ordered dataset — the copy and the count must describe the export
// honestly. Filter income > 50000 leaves 3 of the 5 fixture rows in the
// grid; the dialog must show 5 (effective), say filters are not applied,
// and the written copy must actually hold all 5 rows.
test('with a grid filter active, the dialog shows the effective count and the copy holds every row', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, FIXTURE)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await filterBy(page, 'income', '> 50000')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')

  await page.getByTestId('export-open').click()
  // NOT the grid's filtered 3: the effective (unfiltered) edited count.
  await expect(page.getByTestId('export-view-rows')).toHaveText('5 rows')
  await expect(page.getByTestId('export-view-note')).toContainText('complete edited dataset')
  await expect(page.getByTestId('export-view-note')).toContainText('natural order')
  await expect(page.getByTestId('export-view-note')).toContainText('not applied')
  await expect(page.getByTestId('export-filtered-note')).toBeVisible()
  await expect(page.getByTestId('export-filtered-note')).toContainText('filtered/sorted subset')

  // The engine result agrees with the copy: all 5 rows, filter ignored.
  const download = await exportFormat(page, 'jsonl')
  await expect(page.getByTestId('export-result')).toContainText('Exported 5 rows as JSON Lines')
  const jsonlPath = await saveDownload(download)
  const lines = readFileSync(jsonlPath, 'utf8').trimEnd().split('\n')
  expect(lines).toHaveLength(5)
  // Rows the grid view filtered out are all present in the copy.
  expect(lines.some((line) => line.includes('"income":48000'))).toBe(true) // customer 4
  expect(lines.some((line) => line.includes('"income":null'))).toBe(true) // customer 3

  // The grid view itself is untouched by the export.
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
})

// m4-5 fix round (reviewer finding 3): the success guidance used to tell
// users to re-open EVERY format, but the engine rejects .arrow on open — and
// the advertised arrow MIME claimed the IPC file container while the bytes
// are an IPC stream. The arrow copy must be honest on both counts.
test('the arrow copy is honest: interchange for other tools, no re-open promise, stream bytes', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, FIXTURE)
  await page.getByTestId('export-open').click()
  const download = await exportFormat(page, 'arrow')
  await expect(page.getByTestId('export-result')).toContainText('Exported 5 rows as Arrow IPC')
  await expect(page.getByTestId('export-result')).toContainText('The opened file is unchanged')
  const hint = page.getByTestId('export-reopen-hint')
  await expect(hint).toContainText('interchange format for other tools')
  await expect(hint).not.toContainText('Open a data file')
  await expect(hint).not.toContainText('choose the file you wrote')
  // The advertised type follows the bytes: an IPC stream starts with the
  // 0xFFFFFFFF continuation marker, never the ARROW1 file magic.
  const arrowPath = await saveDownload(download)
  const head = readFileSync(arrowPath).subarray(0, 6)
  expect([...head.subarray(0, 4)]).toEqual([0xff, 0xff, 0xff, 0xff])
  expect(head.subarray(0, 6).toString('latin1')).not.toBe('ARROW1\u0000\u0000')
})
