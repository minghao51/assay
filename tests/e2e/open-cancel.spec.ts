import path from 'node:path'
import { expect, test } from '@playwright/test'
import { cell, waitForReadyRow } from './support/grid'

// ug-21 — opening progress + cancel, in real Chromium.
//
// The slow open is produced by the TEST, not by a production hook or a sleep:
// `addInitScript` wraps the page's engine `Worker.postMessage` and holds the
// first `engine/open` request until this spec releases it. That makes the
// opening phase stable while the Cancel control is exercised, and then
// releases the real engine operation AFTER the cancel so the late result has
// to be dropped by the existing session-token guard.
//
// The fixture is the committed customers Parquet file; the follow-up open
// proves the normal open chain still reaches ready with real rows.

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const OPEN_PROGRESS_LABEL = 'Opening progress'
const OPEN_CANCEL_LABEL = 'Cancel opening'

interface OpenGate {
  held: boolean
  forwarded: boolean
  release: (() => void) | null
}

type GateWindow = typeof window & { __assayOpenCancelGate?: OpenGate }

test.beforeEach(async ({ page }) => {
  // Use the hidden-input fallback (the chooser path every other spec drives),
  // and hold the first engine/open request until the spec releases it.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable global would fail loudly at the chooser instead.
    }

    const gate: OpenGate = { held: false, forwarded: false, release: null }
    ;(window as GateWindow).__assayOpenCancelGate = gate

    const prototype = Worker.prototype as unknown as {
      postMessage: (message: unknown, transfer?: Transferable[]) => void
    }
    const originalPostMessage = prototype.postMessage
    prototype.postMessage = function (message: unknown, transfer?: Transferable[]): void {
      if (
        gate.release === null &&
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'engine/open'
      ) {
        gate.held = true
        gate.release = () => {
          gate.forwarded = true
          originalPostMessage.call(this, message, transfer)
        }
        return
      }
      originalPostMessage.call(this, message, transfer)
    }
  })
})

function gateState(page: import('@playwright/test').Page, key: keyof OpenGate): Promise<boolean> {
  return page.evaluate(
    ([stateKey]) =>
      (window as GateWindow).__assayOpenCancelGate?.[stateKey as keyof OpenGate] === true,
    [key] as const,
  )
}

test('Cancel mid-open returns to idle and a follow-up open reaches ready', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })

  // The normal idle frame has neither opening-only affordance.
  await expect(page.getByTestId('open-progress')).toHaveCount(0)
  await expect(page.getByTestId('open-cancel')).toHaveCount(0)

  const firstChooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await firstChooser).setFiles(CUSTOMERS_FIXTURE)

  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'opening')
  // Deterministic mid-open point: the app has already posted the real
  // engine/open request and the test is holding it.
  await expect.poll(() => gateState(page, 'held')).toBe(true)

  const progress = page.getByRole('progressbar', { name: OPEN_PROGRESS_LABEL })
  await expect(progress).toBeVisible()
  await expect(progress).toHaveJSProperty('tagName', 'PROGRESS')
  expect(await progress.getAttribute('value')).toBeNull()
  expect(await progress.getAttribute('max')).toBeNull()
  expect(await progress.getAttribute('aria-valuenow')).toBeNull()

  const cancel = page.getByRole('button', { name: OPEN_CANCEL_LABEL })
  await expect(cancel).toBeVisible()
  await cancel.click()

  // Cancel restores the ordinary idle frame — no error and no failure copy.
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle')
  await expect(page.getByTestId('open-button')).toBeEnabled()
  await expect(page.getByTestId('example-data-button')).toBeVisible()
  await expect(page.getByTestId('idle-drop-hint')).toBeVisible()
  await expect(page.getByTestId('open-error')).toHaveCount(0)
  await expect(page.getByTestId('open-progress')).toHaveCount(0)
  await expect(page.getByTestId('open-cancel')).toHaveCount(0)

  // Release the held engine/open operation. Its late result must be discarded
  // by the bumped session token rather than flipping the shell to ready.
  await page.evaluate(() => {
    ;(window as GateWindow).__assayOpenCancelGate?.release?.()
  })
  await expect.poll(() => gateState(page, 'forwarded')).toBe(true)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle')
  await expect(page.getByTestId('open-error')).toHaveCount(0)
  await expect(page.getByTestId('grid')).toHaveCount(0)

  // A subsequent open from idle behaves exactly as today: same picker path,
  // real engine, real fixture rows.
  const secondChooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await secondChooser).setFiles(CUSTOMERS_FIXTURE)

  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')
  await waitForReadyRow(page, 0)
  await expect(cell(page, 0, 0)).toHaveText('1')
  await expect(cell(page, 0, 1)).toHaveText('SG')
  await expect(page.getByTestId('open-progress')).toHaveCount(0)
  await expect(page.getByTestId('open-cancel')).toHaveCount(0)
})
