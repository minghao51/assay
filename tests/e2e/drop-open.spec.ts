import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './support/fixture'
import { cell, waitForReadyRow } from './support/grid'

// ug-15 / UG-6 — drag-and-drop open, in real Chromium.
//
// The done-when is a Playwright `DataTransfer` drop of a committed fixture:
// the drop must enter the SAME `openDataFile` chain as the picker (no file
// chooser), reach `data-phase="ready"`, and render the fixture's rows. A drop
// carrying no `File` must be rejected with readable inline copy and leave the
// shell idle.
//
// The fixture bytes are read in Node and reconstructed as a `File` inside the
// page; nothing is fetched by the app. Assertions read stable testids and the
// fixture's published sample values only (ADR 0025: no telemetry/log content).

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const CUSTOMERS_BASE64 = readFileSync(CUSTOMERS_FIXTURE).toString('base64')

const IDLE_DROP_HINT = 'Or drop a data file anywhere on this page'
const DROP_WITHOUT_FILE =
  'That drop did not include a file. Drop a .parquet, .csv, .jsonl or .json file to open it.'

test.beforeEach(async ({ page }) => {
  // Remove the File System Access global so any attempted picker would take
  // the hidden-input fallback and surface as a `filechooser` event — that is
  // what proves the drop path never invoked it.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable global would fail loudly at the chooser instead.
    }
  })
})

test('dropping the customers fixture on the idle shell opens it with no chooser', async ({
  page,
}) => {
  const choosers: string[] = []
  page.on('filechooser', () => {
    choosers.push('filechooser')
  })

  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('idle-drop-hint')).toHaveText(IDLE_DROP_HINT)

  const prevented = await page.evaluate((base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    const file = new File([bytes], 'customers.parquet', { type: 'application/octet-stream' })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    const dragOver = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    })
    window.dispatchEvent(dragOver)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
    window.dispatchEvent(drop)
    return { dragOver: dragOver.defaultPrevented, drop: drop.defaultPrevented }
  }, CUSTOMERS_BASE64)

  // The browser default (navigate to the file) is cancelled in both handlers.
  expect(prevented).toEqual({ dragOver: true, drop: true })

  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')
  await waitForReadyRow(page, 0)
  await expect(cell(page, 0, 0)).toHaveText('1')
  await expect(cell(page, 0, 1)).toHaveText('SG')

  // The drop went through the normal open chain; the picker never ran.
  expect(choosers).toEqual([])
  // The idle-only affordance is gone once the shell is ready.
  await expect(page.getByTestId('idle-drop-hint')).toHaveCount(0)
})

test('dropping a non-file payload shows readable copy and keeps the shell idle', async ({
  page,
}) => {
  const choosers: string[] = []
  page.on('filechooser', () => {
    choosers.push('filechooser')
  })

  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })

  const result = await page.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', 'just some dragged text')
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
    window.dispatchEvent(drop)
    return { prevented: drop.defaultPrevented, files: dataTransfer.files.length }
  })

  expect(result.files).toBe(0)
  expect(result.prevented).toBe(true)
  await expect(page.getByTestId('drop-notice')).toHaveText(DROP_WITHOUT_FILE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle')
  await expect(page.getByTestId('idle-drop-hint')).toBeVisible()
  expect(choosers).toEqual([])
})
