import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { activateTask, openCustomersFixture, openFixture } from './support/fixtures'
import { cell, editCell, renameColumn, waitForReadyRow } from './support/grid'
import { sha256File } from './support/hash'

/**
 * WF-06 — the session-preserving replacement lifecycle in real Chromium over
 * the real DuckDB-WASM engine (the reviewed v5 contract, C1–C16/G1–G6/
 * T0–T11).
 *
 * RTL-ONLY legs (labelled, never faked here): native chooser cancellation
 * (T6/C8) and picker refusal cannot be driven by Playwright — it can
 * `setFiles()` but not dismiss a chooser — and candidate supersession (N8) is
 * unreachable by design (no Cancel, one intent). Those live in
 * `apps/web/src/App.replace.test.tsx` and `replace/machine.test.ts`.
 *
 * Distinct-schema inputs (N6) and the boolean column (N13) are generated into
 * `os.tmpdir()` by this spec: no committed fixture is added, and the engine
 * detects the format from the extension.
 */

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const CUSTOMERS_V2 = path.join(process.cwd(), 'fixtures', 'csv', 'customers-v2.csv')
const CORRUPT = path.join(process.cwd(), 'fixtures', 'invalid', 'corrupt.parquet')

const GUARD_STAGED =
  'This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.'
const FAILURE_SUFFIX = ' Nothing in this session changed.'
/**
 * UG-5's cause-neutral sentence. The real corrupt fixture makes this WASM
 * build's reader throw its opaque emscripten glue error, which is not file
 * evidence, so the classified cause is `unknown` — the same copy the shipped
 * `open-recovery.spec` pins. C10 reuses that classification verbatim.
 */
const NEUTRAL_CAUSE = 'The file could not be opened. You can try another file.'
const DRAFT_NOTICE = 'Finish or cancel the cell you are editing first.'
const CAST_NOTICE =
  'A column type check is still running. Replacement stays unavailable until it finishes.'
const PROGRESS_TEXT = 'Opening the new file… The current session stays open until it is ready.'

interface EngineMessage {
  readonly type: string
  readonly tableId: string | null
}

type HarnessWindow = typeof window & {
  __assayEngineMessages?: EngineMessage[]
  __assayReplaceGate?: {
    hold: boolean
    held: boolean
    release: (() => void) | null
    /** Holds every `engine/overlay-cast-check` request (N14's deterministic gate). */
    holdCast: boolean
    heldCasts: Array<() => void>
  }
  __assayReadyAnnouncements?: string[]
}

/** Temp files this spec generates (never committed). */
const BOOLEAN_JSONL = path.join(tmpdir(), `wf06-boolean-${String(process.pid)}.jsonl`)
const CANDIDATE_JSONL = path.join(tmpdir(), `wf06-candidate-${String(process.pid)}.jsonl`)

test.beforeAll(() => {
  writeFileSync(BOOLEAN_JSONL, '{"id":1,"flag":true}\n{"id":2,"flag":false}\n')
  // Distinct schema: neither column exists in customers.parquet, so a
  // candidate that inherited the live overlay (rename country→nation) would
  // either fail to compose or return the live column names.
  writeFileSync(CANDIDATE_JSONL, '{"order_id":7,"region":"EU"}\n{"order_id":8,"region":"US"}\n')
})

test.beforeEach(async ({ page }) => {
  // The hidden-<input type="file"> fallback (the chooser path every spec drives)
  // plus two test-side instruments, no production hook:
  //  - record engine worker requests (op type + table id) for the overlay
  //    isolation/rebind negative assertions;
  //  - a hold/release gate for the candidate's `engine/open` (N12's
  //    `opening-candidate` window).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable global would fail loudly at the chooser instead.
    }
    const harness = window as HarnessWindow
    harness.__assayEngineMessages = []
    harness.__assayReplaceGate = {
      hold: false,
      held: false,
      release: null,
      holdCast: false,
      heldCasts: [],
    }
    const prototype = Worker.prototype as unknown as {
      postMessage: (message: unknown, transfer?: Transferable[]) => void
    }
    const original = prototype.postMessage
    prototype.postMessage = function (message: unknown, transfer?: Transferable[]): void {
      if (typeof message === 'object' && message !== null) {
        const type = (message as { type?: unknown }).type
        if (typeof type === 'string' && type.startsWith('engine/')) {
          const tableId = (message as { tableId?: unknown }).tableId
          harness.__assayEngineMessages?.push({
            type,
            tableId: typeof tableId === 'string' ? tableId : null,
          })
          const gate = harness.__assayReplaceGate
          if (type === 'engine/open' && gate !== undefined && gate.hold && gate.release === null) {
            gate.held = true
            gate.release = () => {
              original.call(this, message, transfer)
            }
            return
          }
          // N14: park the cast pre-check itself (not the whole FIFO), so the
          // pending-cast window is stable without any timing dependence.
          if (type === 'engine/overlay-cast-check' && gate !== undefined && gate.holdCast) {
            gate.heldCasts.push(() => {
              original.call(this, message, transfer)
            })
            return
          }
        }
      }
      original.call(this, message, transfer)
    }
  })
})

function engineMessages(page: Page): Promise<EngineMessage[]> {
  return page.evaluate(() => (window as HarnessWindow).__assayEngineMessages ?? [])
}

function holdCandidateOpen(page: Page, hold: boolean): Promise<void> {
  return page.evaluate((next) => {
    const gate = (window as HarnessWindow).__assayReplaceGate
    if (gate !== undefined) gate.hold = next
  }, hold)
}

function holdCastChecks(page: Page, hold: boolean): Promise<void> {
  return page.evaluate((next) => {
    const gate = (window as HarnessWindow).__assayReplaceGate
    if (gate !== undefined) gate.holdCast = next
  }, hold)
}

function heldCastCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as HarnessWindow).__assayReplaceGate?.heldCasts.length ?? 0)
}

/** Forward every parked cast check (and stop holding the rest). */
function releaseHeldCasts(page: Page): Promise<number> {
  return page.evaluate(() => {
    const gate = (window as HarnessWindow).__assayReplaceGate
    if (gate === undefined) return 0
    gate.holdCast = false
    const held = gate.heldCasts.splice(0)
    for (const release of held) release()
    return held.length
  })
}

function releaseCandidateOpen(page: Page): Promise<void> {
  return page.evaluate(() => {
    ;(window as HarnessWindow).__assayReplaceGate?.release?.()
  })
}

async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement ? active.getAttribute('data-testid') : null
  })
}

/**
 * Apply one SETTLED edit so the live session is dirty (history 1 pending).
 *
 * The history summary is published at `activateHistory`, i.e. BEFORE the
 * commit's refresh settles, so a gesture fired at that instant would be refused
 * by gate row G4 (C15) — correct behaviour, but it would make this helper race
 * under load. The polite edit region announces the settled commit, so waiting
 * for it is the honest synchronisation point.
 */
async function makeDirty(page: Page): Promise<void> {
  await editCell(page, 0, 2, '99000')
  await expect(page.getByTestId('section-summary-history')).toHaveText('History · 1 pending')
  await expect(page.getByTestId('edit-live-region')).toContainText('Edit committed.')
}

/** Click Open on a clean session and hand the chooser the given file. */
async function chooseReplacement(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooser).setFiles(file)
}

/** Click Open on a dirty session, then choose from the guard (T5). */
async function chooseFromGuard(page: Page, file: string): Promise<void> {
  await page.getByTestId('open-button').click()
  await expect(page.getByTestId('replace-guard')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('replace-choose').click()
  await (await chooser).setFiles(file)
}

test('dirty session: the guard shows the exact copy and Stay preserves everything', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  await makeDirty(page)
  const sourceHashBefore = sha256File(CUSTOMERS)
  // An adoption-disposable draft on the REAL SQL surface (K14/§3.4): Stay must
  // preserve it byte-for-byte (only an adoption discards it).
  await page.getByTestId('sql-input').fill('SELECT 8675309 AS prior_session_marker')

  await page.getByTestId('open-button').click()
  const guard = page.getByTestId('replace-guard')
  await expect(guard).toBeVisible()
  await expect(guard).toHaveAttribute('aria-labelledby', 'replace-guard-title')
  await expect(page.getByTestId('replace-guard-staged')).toHaveText(GUARD_STAGED)
  await expect(page.getByTestId('replace-guard-export')).toHaveText(
    'Session changes are not saved automatically. Export a copy to keep them.',
  )
  await expect(page.getByTestId('replace-guard-stays')).toHaveText(
    'If you cancel the file chooser, or the file cannot be opened, this session stays as it is.',
  )
  await expect(page.getByTestId('replace-stay')).toHaveText('Stay')
  await expect(page.getByTestId('replace-export')).toHaveText('Export a copy…')
  await expect(page.getByTestId('replace-choose')).toHaveText('Choose a replacement file…')
  // The guard never prints a pending-change count (one staged edit is present).
  await expect(guard).not.toContainText('1 pending')
  await expect(guard).not.toContainText('customers.parquet')

  await page.getByTestId('replace-stay').click()
  await expect(guard).toHaveCount(0)
  // T3: byte-identical live session — the edit, the history entry, the table.
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(cell(page, 0, 2)).toHaveText('99000')
  await expect(page.getByTestId('section-summary-history')).toHaveText('History · 1 pending')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('sql-input')).toHaveValue('SELECT 8675309 AS prior_session_marker')
  expect(sha256File(CUSTOMERS)).toBe(sourceHashBefore)
})

test('dirty session: Escape is Stay and leaves the session untouched', async ({ page }) => {
  await openCustomersFixture(page, CUSTOMERS)
  await makeDirty(page)

  await page.getByTestId('open-button').click()
  await expect(page.getByTestId('replace-guard')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(cell(page, 0, 2)).toHaveText('99000')
  await expect(page.getByTestId('section-summary-history')).toHaveText('History · 1 pending')
})

test('dirty session: export-first opens the existing exporter and ends the intent', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  await makeDirty(page)

  await page.getByTestId('open-button').click()
  await page.getByTestId('replace-export').click()
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
  // The existing Export dialog is the one that opens (T4): no stacking, no
  // second dialog and no auto-replacement.
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(cell(page, 0, 2)).toHaveText('99000')
  await expect(page.getByTestId('section-summary-history')).toHaveText('History · 1 pending')
  await page.getByTestId('export-close').click()
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  // Nothing advanced on close either: a fresh gesture is required.
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
})

test('dirty session: choosing a valid replacement adopts it once and resets the session', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  await makeDirty(page)
  // The same draft, discarded by the adoption (T8/§3.4).
  await page.getByTestId('sql-input').fill('SELECT 8675309 AS prior_session_marker')

  // Count the ready announcements the adoption produces (N11): the live region
  // is observed from here on, so only the adoption's announcement is recorded.
  await page.evaluate(() => {
    const harness = window as HarnessWindow
    const region = document.querySelector('[data-testid="open-live-region"]')
    harness.__assayReadyAnnouncements = []
    if (region === null) return
    new MutationObserver(() => {
      const text = region.textContent ?? ''
      if (text === '') return
      const seen = harness.__assayReadyAnnouncements ?? []
      if (seen.at(-1) === text) return
      seen.push(text)
      harness.__assayReadyAnnouncements = seen
    }).observe(region, { childList: true, subtree: true, characterData: true })
  })

  await chooseFromGuard(page, CUSTOMERS_V2)

  // Adopted: customers-v2.csv is the live dataset now (its fifth row is
  // customer 6; the replaced customers.parquet ended at customer 5), and the
  // previous session's staged edit/history is gone.
  await waitForReadyRow(page, 4)
  await expect(cell(page, 4, 0)).toHaveText('6')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('section-summary-history')).toHaveCount(0)
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
  await waitForReadyRow(page, 0)
  // The previous session's SQL statement is gone: adoption remounted the tool
  // panels under the new dataset identity.
  await expect(page.getByTestId('sql-input')).toHaveValue('')

  const announcements = await page.evaluate(
    () => (window as HarnessWindow).__assayReadyAnnouncements ?? [],
  )
  expect(announcements).toHaveLength(1)
  expect(announcements[0]).toContain('Dataset opened')
})

test('a corrupt candidate reports C10, keeps the raw text in a closed detail, and preserves the session', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  await makeDirty(page)

  await chooseFromGuard(page, CORRUPT)

  const failure = page.getByTestId('replace-error')
  await expect(failure).toBeVisible()
  await expect(page.getByTestId('replace-error-text')).toHaveText(NEUTRAL_CAUSE + FAILURE_SUFFIX)
  await expect(page.getByTestId('replace-error-text')).not.toContainText('magic bytes')

  // IC-04: the technical detail is a CLOSED disclosure outside the alert text.
  const details = page.getByTestId('replace-error-details')
  await expect(details).not.toHaveAttribute('open', '')
  await expect(details.locator('summary')).toHaveText('Technical detail')
  await expect(details.locator('pre')).toHaveCount(1)
  // The user's own copy of the visible text is not suppressed (W-C).
  const selectable = await details.locator('pre').evaluate((element) => {
    const style = window.getComputedStyle(element)
    return style.userSelect !== 'none'
  })
  expect(selectable).toBe(true)

  // T9/T9b: the live session is intact — same rows, same edit, same history.
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(cell(page, 0, 2)).toHaveText('99000')
  await expect(page.getByTestId('section-summary-history')).toHaveText('History · 1 pending')

  // C11 retry re-enters choosing (here: it is dismissed by the chooser's own
  // cancel path, which Playwright cannot drive — asserted only as "the notice
  // survives a refused gesture", never as an OS cancellation).
  await expect(page.getByTestId('replace-retry')).toHaveText('Choose a different file…')
})

test('a clean session replaces without a guard, and its cancelled chooser is covered RTL', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  // The picker really is invoked (no guard) — the chooser event proves it.
  await chooseReplacement(page, CUSTOMERS_V2)
  await waitForReadyRow(page, 4)
  await expect(cell(page, 4, 0)).toHaveText('6')
  await expect(page.getByTestId('section-summary-history')).toHaveCount(0)
  // The native-cancel leg (C8) is RTL-only; this spec never claims it.
  await expect(page.getByTestId('replace-notice')).toHaveCount(0)
})

test('undo-to-zero and a no-op-only history are CLEAN (no guard)', async ({ page }) => {
  await openCustomersFixture(page, CUSTOMERS)
  // One edit, then undo back to zero: the history buffer still has the entry,
  // but the active prefix has no applied outcome.
  await editCell(page, 0, 2, '99000')
  // History is a Change-task section; activate that task to reach its Undo
  // control (exposure is per task at ≥1024px, the existing shell rule).
  await activateTask(page, 'change')
  await page.getByTestId('history-undo').click()
  await expect(page.getByTestId('section-summary-history')).toHaveCount(0)
  await activateTask(page, 'explore')

  // A no-op rename (same name) is a LOGGED no-op: still clean.
  const panel = page.getByTestId('schema-panel')
  await panel.locator('[data-testid="column-rename-open"][data-col-name="country"]').click()
  const input = panel.locator('[data-testid="column-rename-input"]')
  await input.fill('country')
  await input.press('Enter')
  await expect(page.getByTestId('edit-error')).toBeVisible()

  // No guard: the chooser opens directly (and the flow is completed so the
  // page is left in a ready state).
  await chooseReplacement(page, CUSTOMERS_V2)
  await waitForReadyRow(page, 4)
  await expect(cell(page, 4, 0)).toHaveText('6')
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
})

test('G3: a boolean editor (no blur handler) refuses Open by real pointer and focuses itself', async ({
  page,
}) => {
  await openFixture(page, BOOLEAN_JSONL, { expandSections: true })
  await waitForReadyRow(page, 0)

  // Open the BOOLEAN editor and leave the placeholder selected (no commit).
  await cell(page, 0, 1).dblclick()
  await expect(page.getByTestId('grid-editor-boolean')).toBeVisible()

  let choosers = 0
  page.on('filechooser', () => {
    choosers += 1
  })
  await page.getByTestId('open-button').click()

  await expect(page.getByTestId('replace-draft-notice')).toHaveText(DRAFT_NOTICE)
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
  await expect(page.getByTestId('grid-editor-boolean')).toBeVisible()
  // The per-kind focus chain lands on the BOOLEAN testid (never `<body>` and
  // never the text input, which does not exist here).
  expect(await activeTestId(page)).toBe('grid-editor-boolean')

  // A dismissed gesture really opened no chooser (the absence is observable).
  await page.waitForTimeout(300)
  expect(choosers).toBe(0)

  // IC-01: Escape closes the editor and clears C13 with no second Open click.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('grid-editor-boolean')).toHaveCount(0)
  await expect(page.getByTestId('replace-draft-notice')).toHaveCount(0)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
})

test('A1/N6/N7: a candidate reads its OWN empty overlay, then rebinds at adoption', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  // A dirty live session whose overlay renames `country` → `nation`. The
  // candidate has neither column, so an inherited overlay would fail or
  // return the live names.
  await renameColumn(page, 'country', 'nation')
  await expect(
    page.locator('[data-testid="grid-header-cell"][data-col-name="nation"]'),
  ).toBeVisible()

  await chooseFromGuard(page, CANDIDATE_JSONL)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await waitForReadyRow(page, 0)

  const adoptedId = (await page.getByTestId('sql-table-id').textContent()) ?? ''
  expect(adoptedId).not.toBe('')
  const messages = await engineMessages(page)
  const forAdopted = messages.filter((message) => message.tableId === adoptedId)

  // Base path only: the candidate was read through `engine/schema`/`range`,
  // never through a composed overlay (which would have resolved the live
  // overlay over the candidate's base).
  expect(forAdopted.some((message) => message.type === 'engine/schema')).toBe(true)
  expect(forAdopted.filter((message) => message.type.startsWith('engine/overlay-'))).toEqual([])
  // The adopted schema is the candidate's own, not the live one.
  await expect(
    page.locator('[data-testid="grid-header-cell"][data-col-name="order_id"]'),
  ).toBeVisible()
  await expect(
    page.locator('[data-testid="grid-header-cell"][data-col-name="region"]'),
  ).toBeVisible()
  await expect(
    page.locator('[data-testid="grid-header-cell"][data-col-name="nation"]'),
  ).toHaveCount(0)

  // N7: the first post-adoption edit applies through the rebound overlay.
  await editCell(page, 0, 1, 'APAC')
  const afterEdit = (await engineMessages(page)).filter(
    (message) => message.tableId === adoptedId && message.type.startsWith('engine/overlay-'),
  )
  expect(afterEdit.length).toBeGreaterThan(0)
  await expect(cell(page, 0, 1)).toHaveText('APAC')
})

test('N12: preparing a candidate sets aria-busy/inert, focuses the progress line, then adopts', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)
  await makeDirty(page)

  // Hold the candidate's engine/open so the `opening-candidate` window is
  // stable (test-side worker gate, the open-cancel precedent).
  await holdCandidateOpen(page, true)
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await page.getByTestId('replace-choose').click()
  await (await chooser).setFiles(CUSTOMERS_V2)

  const progress = page.getByTestId('replace-progress')
  await expect(progress).toBeVisible()
  await expect(progress).toHaveText(PROGRESS_TEXT)
  await expect(progress.getByRole('progressbar', { name: 'Opening progress' })).toBeVisible()
  // The live session is still the old one and the ready region is inert+busy.
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('.workbench-layout')).toHaveAttribute('inert', '')
  await expect(page.locator('.workbench-layout')).toHaveAttribute('aria-busy', 'true')
  // Focus was moved EXPLICITLY to the progress line (never left on `<body>`).
  expect(await activeTestId(page)).toBe('replace-progress')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  await releaseCandidateOpen(page)
  await waitForReadyRow(page, 4)
  await expect(cell(page, 4, 0)).toHaveText('6')
  await expect(progress).toHaveCount(0)
  await expect(page.locator('.workbench-layout')).not.toHaveAttribute('inert', '')
})

test('N14: a pending cast pre-check refuses Open with C16 until the LAST check clears', async ({
  page,
}) => {
  await openCustomersFixture(page, CUSTOMERS)

  // Deterministic window: the test-side worker gate parks the cast pre-check
  // request itself, so the check is provably in flight when Open is clicked —
  // no slow-query FIFO probe, no timer, no timeout widening.
  await holdCastChecks(page, true)
  const panel = page.getByTestId('schema-panel')
  await panel.locator('[data-testid="column-cast-open"][data-col-name="income"]').click()
  await panel.locator('[data-testid="column-cast-select"]').selectOption('VARCHAR')
  await panel.locator('[data-testid="column-cast-commit"]').click()
  await expect(panel.locator('[data-testid="column-cast-pending"]')).toBeVisible()
  await expect.poll(() => heldCastCount(page)).toBeGreaterThan(0)

  await page.getByTestId('open-button').click()
  await expect(page.getByTestId('replace-cast-notice')).toHaveText(CAST_NOTICE)
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  // No chooser was opened by the refused gesture.
  await expect(page.getByTestId('replace-progress')).toHaveCount(0)

  // Release the parked check: it settles, the cast commits, and C16 clears on
  // its own — with no guard/picker auto-opening (the user must gesture again).
  expect(await releaseHeldCasts(page)).toBeGreaterThan(0)
  await expect(page.getByTestId('replace-cast-notice')).toHaveCount(0)
  await expect(page.getByTestId('replace-guard')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  // The released cast really applied: the session now has one staged op.
  await expect(page.getByTestId('section-summary-history')).toHaveText('History · 1 pending')
  await expect(
    page.locator('[data-testid="grid-header-cell"][data-col-name="income"]'),
  ).toBeVisible()
})
