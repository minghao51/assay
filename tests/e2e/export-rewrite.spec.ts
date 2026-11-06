import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Download, Page } from '@playwright/test'
import { activateTask, openFixture, openFilterBar, expandAllSections } from './support/fixtures'
import { cell, editCell, row } from './support/grid'

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
//
// Fix-round-2 pins (m4-5 review, round 2): (4) an input-fallback session is
// NEVER offered the direct-write save picker — same-entry identity cannot be
// proven without a retained FSA handle (round 1's name+size+lastModified
// probe missed a source externally touched after opening), so delivery rides
// the anchor download even though the browser has a picker, and that picker
// is never invoked; (5) an FSA-opened session still gets the picker, and a
// picked destination that IS the opened entry is still refused before any
// write — proven end-to-end by opening through a FAKE FSA handle (the native
// open picker is not automatable) whose `isSameEntry` the app consumes; (6)
// the view note tracks filtering and sorting separately: a filter-only view
// says "filtered subset", a sort-only view says the sorting is not applied
// and never mentions filters, both → "filtered/sorted subset".

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

/** Export through the dialog, capturing the download the fallback triggers. */
async function exportFormat(page: Page, format: string): Promise<Download> {
  await page.getByTestId(`export-format-${format}`).check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-confirm').click()
  return downloadPromise
}

/** Open the collapsed `SQL predicates` escape hatch (ug-18). */
async function openSqlPredicates(page: Page): Promise<void> {
  const disclosure = page.getByTestId('filter-sql-disclosure')
  if ((await disclosure.getAttribute('open')) === null) {
    await disclosure.locator('summary').click()
  }
}

/** Apply one column predicate through the filter bar (m2-3 pattern). */
async function filterBy(page: Page, column: string, predicate: string): Promise<void> {
  await openFilterBar(page)
  await openSqlPredicates(page)
  await page.locator(`[data-testid="filter-input"][data-col-name="${column}"]`).fill(predicate)
  await page.locator(`[data-testid="filter-apply"][data-col-name="${column}"]`).click()
}

/** Click a column header's sort toggle once (m2-3 pattern: first click = asc). */
async function sortBy(page: Page, column: string): Promise<void> {
  await page.locator(`[data-testid="grid-sort-toggle"][data-col-name="${column}"]`).click()
}

/** Cast a column to a custom engine type through the schema panel (AR-E1). */
async function castColumnCustom(page: Page, column: string, target: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-cast-open"][data-col-name="${column}"]`).click()
  await panel.locator('[data-testid="column-cast-select"]').selectOption('__custom__')
  await panel.locator('[data-testid="column-cast-custom"]').fill(target)
  await panel.locator('[data-testid="column-cast-commit"]').click()
}

/**
 * Open the fixture through a FAKE File System Access open (the native open
 * picker is not automatable through Playwright's filechooser): an init
 * script installs `showOpenFilePicker`, returning a handle over the real
 * fixture bytes. This is the identity-provable open — the only session shape
 * still offered the direct-write save picker (m4-5 fix round 2).
 *
 * `savePicker` installs the save-side stub in the same document:
 * - 'same-entry': resolves with the SAME handle the open flow retained, so
 *   the platform-shaped `isSameEntry` verdict is `true` — the app must
 *   refuse before any write (the fake writable records any acquisition).
 * - 'abort': rejects like a dismissed native picker (AbortError).
 */
async function openFixtureViaFakeFsa(
  page: Page,
  fixturePath: string,
  savePicker: 'same-entry' | 'abort',
): Promise<void> {
  await page.addInitScript(
    ({ bytesBase64, fileName }) => {
      const bytes = Uint8Array.from(atob(bytesBase64), (c) => c.charCodeAt(0))
      const win = window as {
        showOpenFilePicker?: unknown
        showSaveFilePicker?: unknown
        __assayFsaHandle?: unknown
        __assayWritableAcquired?: boolean
        __assayWrote?: boolean
      }
      const handle = {
        kind: 'file' as const,
        name: fileName,
        isSameEntry: async (other: unknown) => other === handle,
        getFile: async () => new File([bytes], fileName, { lastModified: 1_700_000_000_000 }),
        createWritable: async () => {
          win.__assayWritableAcquired = true
          return {
            write: async () => {
              win.__assayWrote = true
            },
            close: async () => undefined,
          }
        },
      }
      win.showOpenFilePicker = async () => [handle]
      win.__assayFsaHandle = handle
    },
    {
      bytesBase64: readFileSync(fixturePath).toString('base64'),
      fileName: path.basename(fixturePath),
    },
  )
  if (savePicker === 'same-entry') {
    await page.addInitScript(() => {
      ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async () =>
        (window as { __assayFsaHandle?: unknown }).__assayFsaHandle
    })
  } else {
    await page.addInitScript(() => {
      ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = () =>
        Promise.reject(Object.assign(new Error('dismissed'), { name: 'AbortError' }))
    })
  }
  // No filechooser here: the fake `showOpenFilePicker` resolves directly, so
  // the app goes idle → ready without Playwright's file-chooser flow.
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  await page.getByTestId('open-button').click()
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  // q-15: expand the two-pane tool sections (Export/Editing) this spec drives.
  // rd-3b: Export and Editing are Change sections, so the flow ends on Change.
  await expandAllSections(page, { endTask: 'change' })
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
  // rd-3b: this test drives the editing toolbar and the Export dialog — the
  // Change task — so the open flow ends on Change.
  await openFixture(page, FIXTURE, { task: 'change' })
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
  await openFixture(page, jsonlPath, { task: 'change' })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  await expect(row(page, 0)).toHaveAttribute('data-status', 'ready')
  // The edited bait cell comes back exactly as written (raw JSONL, no guard).
  await expect(cell(page, 0, 1)).toHaveText('=SUM(A1:A2)')
  // The inserted row survived the round-trip too.
  await expect(cell(page, 5, 1)).toHaveText('INSERTED_ROW')
  await expect(row(page, 5)).toHaveAttribute('data-status', 'ready')
})

test('a cast-to-BLOB column exports CSV hex-encoded, never a raw formula (AR-E1)', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, FIXTURE)
  // Bait the country cell, then cast the column to BLOB (a real DuckDB BLOB
  // effective column). The raw BLOB would reach the CSV writer verbatim and
  // be a live formula; the exporter must hex-encode it instead.
  await editCell(page, 0, 1, '=cmd|@SUM(1+1)')
  await castColumnCustom(page, 'country', 'BLOB')
  await expect(
    page.locator('[data-testid="grid-header-cell"][data-col-name="country"]'),
  ).toHaveAttribute('data-col-type', /BLOB/i)
  // rd-3b: the cast lives in Schema (Explore); the Export dialog is Change.
  await activateTask(page, 'change')
  await page.getByTestId('export-open').click()
  const download = await exportFormat(page, 'csv')
  const csvPath = await saveDownload(download)
  const csvText = readFileSync(csvPath, 'utf8')
  // `hex('=cmd|@SUM(1+1)')` (CLI 1.5.5, uppercase) — and never the raw bait.
  expect(csvText).toContain('3D636D647C4053554D28312B3129')
  expect(csvText).not.toContain('=cmd|@SUM(1+1)')
})

test('the source fixture is never written by an export (ADR 0012)', async ({ page }) => {
  test.setTimeout(180_000)
  const before = readFileSync(FIXTURE)
  await openFixture(page, FIXTURE, { task: 'change' })
  await editCell(page, 0, 1, 'ZZZ')
  await page.getByTestId('export-open').click()
  const download = await exportFormat(page, 'csv')
  await download.path()
  await expect(page.getByTestId('export-result')).toContainText('Exported 5 rows as CSV')
  // Byte-identical source: the export wrote a new file, never the source.
  expect(readFileSync(FIXTURE).equals(before)).toBe(true)
})

// m4-5 fix round 2: the dismissed-picker cancellation path now only exists
// for FSA-opened sessions — an input-fallback session is never offered the
// picker at all (see the download-only pin below), so the round-1 harness
// (input-fallback open + AbortError picker) can no longer reach it. This pin
// drives the SAME cancellation through a fake FSA open: the picker path is
// genuinely offered, dismissal is reported as a cancellation, nothing runs,
// nothing is written.
test('an FSA-opened session: a dismissed save picker reports cancellation and writes nothing', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const before = readFileSync(FIXTURE)
  await openFixtureViaFakeFsa(page, FIXTURE, 'abort')
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-format-csv').check()
  await page.getByTestId('export-confirm').click()
  await expect(page.getByTestId('export-cancelled')).toContainText('no new file was written')
  await expect(page.getByTestId('export-result')).toHaveCount(0)
  await expect(page.getByTestId('export-error')).toHaveCount(0)
  // No writable was ever acquired and the source is byte-identical.
  expect(
    await page.evaluate(
      () => (window as { __assayWritableAcquired?: boolean }).__assayWritableAcquired ?? false,
    ),
  ).toBe(false)
  expect(readFileSync(FIXTURE).equals(before)).toBe(true)
})

// m4-5 fix round 2 (reviewer finding 1): an input-fallback open retains no
// FSA handle, so same-entry identity can never be proven — round 1's
// name+size+lastModified probe let a source externally touched after opening
// straight through to a direct write (the reviewer reproduced the data
// loss). Fail-closed by construction now: even though this browser HAS a
// save picker, the session is never offered it (the stub below throws and
// records if it is ever invoked), and the copy is delivered as a browser
// download whose destination our code cannot point at the source.
test('an input-fallback session exports via download; the present save picker is never invoked', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const before = readFileSync(FIXTURE)
  await page.addInitScript(() => {
    ;(window as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => {
      ;(window as { __assayPickerInvoked?: boolean }).__assayPickerInvoked = true
      throw new Error(
        'the direct-write save picker must never be offered to an input-fallback session',
      )
    }
  })
  await openFixture(page, FIXTURE, { task: 'change' })
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-format-csv').check()
  const download = await exportFormat(page, 'csv')
  const result = page.getByTestId('export-result')
  await expect(result).toContainText('Exported 5 rows as CSV')
  // Honest delivery copy: the browser downloaded it; no destination was
  // chosen through a picker.
  await expect(result).toContainText('your browser is downloading it as a new file')
  await expect(result).toContainText('The opened file is unchanged')
  // The picker was never invoked.
  expect(
    await page.evaluate(
      () => (window as { __assayPickerInvoked?: boolean }).__assayPickerInvoked ?? false,
    ),
  ).toBe(false)
  // The download really holds the whole dataset (header + 5 rows).
  const csvPath = await saveDownload(download)
  expect(readFileSync(csvPath, 'utf8').trimEnd().split('\n')).toHaveLength(6)
  // The opened file is byte-identical.
  expect(readFileSync(FIXTURE).equals(before)).toBe(true)
})

// m4-5 fix round 2: the FSA-opened session still gets the picker, and the
// same-entry refusal still holds — now against a genuinely FSA-shaped open
// (a fake handle whose `isSameEntry` the app consumes). The picker resolves
// with the SAME handle the open flow retained; the app must refuse before
// any engine work or byte write (ADR 0012 data-loss guard, round-1 finding).
test('an FSA-opened session: a save picker aimed at the opened file is refused before any write', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const before = readFileSync(FIXTURE)
  await openFixtureViaFakeFsa(page, FIXTURE, 'same-entry')
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
  expect(
    await page.evaluate(
      () => (window as { __assayWritableAcquired?: boolean }).__assayWritableAcquired ?? false,
    ),
  ).toBe(false)
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

  // rd-3b: the filter bar is Explore, the Export dialog is Change.
  await activateTask(page, 'change')
  await page.getByTestId('export-open').click()
  // NOT the grid's filtered 3: the effective (unfiltered) edited count.
  await expect(page.getByTestId('export-view-rows')).toHaveText('5 rows')
  await expect(page.getByTestId('export-view-note')).toContainText('complete edited dataset')
  await expect(page.getByTestId('export-view-note')).toContainText('natural order')
  await expect(page.getByTestId('export-view-note')).toContainText('not applied')
  // Filter-only view (m4-5 fix round 2): the note names the filtered subset
  // and says nothing about sorting.
  await expect(page.getByTestId('export-filtered-note')).toBeVisible()
  await expect(page.getByTestId('export-filtered-note')).toContainText('filtered subset')
  await expect(page.getByTestId('export-filtered-note')).not.toContainText('sorted')

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

// m4-5 fix round 2 (reviewer finding 2): filtering and sorting are tracked
// separately. A sort-only view used to set the same flag as a filter, so the
// dialog claimed a "filtered/sorted subset" and referred to filters that do
// not exist. The sort-only wording must describe only the sorting.
test('a sort-only view: the dialog says the sorting is not applied and never mentions filters', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, FIXTURE, { task: 'change' })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await sortBy(page, 'income')
  await expect(
    page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]'),
  ).toHaveAttribute('data-sort', 'asc')

  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-view-rows')).toHaveText('5 rows')
  const note = page.getByTestId('export-filtered-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('currently sorted')
  await expect(note).toContainText('not applied to the copy')
  await expect(note).toContainText('contains every row')
  // Sort-only: no filter language anywhere in the note.
  await expect(note).not.toContainText('filter')
  // And the base line still tells the truth about the export's ordering.
  await expect(page.getByTestId('export-view-note')).toContainText('natural order')
})

// m4-5 fix round (reviewer finding 3): the success guidance used to tell
// users to re-open EVERY format, but the engine rejects .arrow on open — and
// the advertised arrow MIME claimed the IPC file container while the bytes
// are an IPC stream. The arrow copy must be honest on both counts.
test('the arrow copy is honest: interchange for other tools, no re-open promise, stream bytes', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, FIXTURE, { task: 'change' })
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
