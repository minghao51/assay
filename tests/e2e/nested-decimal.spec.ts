import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Task m4-5 close-out of the m4-4 carry-over: decimals nested inside a struct
// rendered `<16 bytes>` because the decoder keyed off the top-level column type
// only. The parsed type tree is now threaded through the nested preview, so the
// DECIMAL(21,1) leaves inside nested.parquet's `payload.geo` render exactly.
//
// The committed golden fixture's payload STRUCT is:
//   STRUCT("name" VARCHAR, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)),
//          tags VARCHAR[], scores STRUCT(q1 DOUBLE, q2 INTEGER))
// Row 0 (CLI v1.5.5): {'name': n0, 'geo': {'lat': 1.0, 'lon': 2.0}, 'tags': [x],
//                      'scores': {'q1': 0.0, 'q2': NULL}}
//
// Picker path: as in the other web specs, the FSA global is removed so the
// hidden-input fallback drives Playwright's filechooser.

const NESTED_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'nested.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global: the chooser assertion fails loudly instead.
    }
  })
})

async function openNested(page: Page): Promise<void> {
  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(NESTED_FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('50')
}

test('a decimal nested in a struct renders its exact value, not <16 bytes>', async ({ page }) => {
  await openNested(page)
  const row0 = page.locator('[data-testid="grid-row"][data-row-index="0"]')
  await expect(row0).toHaveAttribute('data-status', 'ready')
  const payload = row0.getByTestId('grid-cell').nth(1)

  // Exact decimal leaves (scale 1), and the neighbouring non-decimal fields
  // keep their normal rendering (DOUBLE 0 → 0, NULL stays `null`).
  await expect(payload).toContainText('"lat":1.0')
  await expect(payload).toContainText('"lon":2.0')
  await expect(payload).toContainText('"q1":0')
  await expect(payload).not.toContainText('<16 bytes>')
  // A later row proves the decoder is not pinned to row 0.
  const row1 = page.locator('[data-testid="grid-row"][data-row-index="1"]')
  await expect(row1).toHaveAttribute('data-status', 'ready')
  await expect(row1.getByTestId('grid-cell').nth(1)).toContainText('"lat":2.0')
})
