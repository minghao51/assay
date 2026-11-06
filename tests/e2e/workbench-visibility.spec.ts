import path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  DEFERRED_A11Y,
  assertNoCriticalOrSerious,
  scanA11y,
  summarizeViolations,
} from './support/a11y'
import { activateTask, openFixture, openSection } from './support/fixtures'
import {
  bindContract,
  bindSourceDataset,
  openPipelineDocument,
  runPipelineToGate,
  writeGatePipelineFixture,
} from './support/pipeline-panel'
import { waitForReadyRow } from './support/grid'

/**
 * rd-3b — conditional task visibility in a real browser (the actual acceptance
 * for the slice).
 *
 * At ≥1024px only the active task's tool sections are EXPOSED; the others are
 * `display: none` but stay MOUNTED, so a task switch re-mounts nothing and
 * loses no draft, overlay cursor or scroll position. The section-link groups
 * follow the same rule (active task + Workspace). Below 1024px nothing is
 * filtered (ADR 0044 narrow contract). Grid and Record are workspace and are
 * never filtered.
 *
 * Everything here is a real-browser measurement (`getComputedStyle`,
 * `document.activeElement`, real gestures, real worker traffic) because the
 * unit suites cannot apply a stylesheet — `apps/web/src/shell-visibility.test.ts`
 * pins the rule SHAPES and the `data-task` wiring, and
 * `apps/web/src/App.shell.test.tsx` pins the per-task attributes; those are
 * structural pins, not exposure proof.
 *
 * Privacy (ADR 0025): no cell value, filename or path is asserted or logged.
 */

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

/** The ten tool sections and the task that owns each (the CSS rule's key). */
const SECTION_TASK: Readonly<Record<string, string>> = {
  schema: 'explore',
  filters: 'explore',
  sql: 'explore',
  profile: 'explore',
  validation: 'check',
  compare: 'check',
  editing: 'change',
  history: 'change',
  export: 'change',
  pipeline: 'prepare',
}

/** All twelve sections in DOM order (fixed; exposure never reorders or drops). */
const SECTION_IDS = [
  'schema',
  'editing',
  'history',
  'export',
  'validation',
  'compare',
  'filters',
  'sql',
  'profile',
  'pipeline',
  'grid',
  'record',
] as const

/** The desktop samples the exposure contract is defined on. */
const VIEWPORTS = [
  { label: '1024×700', width: 1024, height: 700 },
  { label: '1440×900', width: 1440, height: 900 },
] as const

/** The two colour schemes every visual/a11y pin runs in (q-2). */
const SCHEMES = ['light', 'dark'] as const

test.beforeEach(async ({ page }) => {
  // Hidden-`<input type="file">` fallback (the m1-5 pattern).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; fail loudly later.
    }
  })
})

interface SectionExposure {
  readonly id: string
  readonly display: string
  readonly attached: boolean
}

interface NavGroupExposure {
  readonly id: string | null
  readonly display: string
}

/** Read the computed exposure of all twelve sections and all five nav groups. */
async function readExposure(
  page: Page,
): Promise<{ sections: SectionExposure[]; groups: NavGroupExposure[] }> {
  return page.evaluate(() => ({
    sections: Array.from(document.querySelectorAll('.workbench-section')).map((section) => ({
      id: section.getAttribute('data-section') ?? '',
      display: getComputedStyle(section).display,
      attached: section.isConnected,
    })),
    groups: Array.from(document.querySelectorAll('.workbench-nav-group')).map((group) => ({
      id: group.getAttribute('data-testid'),
      display: getComputedStyle(group).display,
    })),
  }))
}

/** Ids whose computed `display` is not `none` (i.e. really exposed). */
function exposedIds(sections: readonly SectionExposure[]): string[] {
  return sections.filter((section) => section.display !== 'none').map((section) => section.id)
}

/** The exposed TOOL sections (the center column is asserted separately). */
function exposedToolIds(sections: readonly SectionExposure[]): string[] {
  return exposedIds(sections).filter((id) => SECTION_TASK[id] !== undefined)
}

/**
 * Assert one task's exposure at the current viewport: the owning task's tool
 * sections plus the Grid/Record workspace, every other section attached and
 * computed-hidden, and the nav exposing exactly the task's group + Workspace.
 */
async function expectTaskExposure(page: Page, task: string): Promise<void> {
  const expectedTools = Object.entries(SECTION_TASK)
    .filter(([, owner]) => owner === task)
    .map(([id]) => id)

  const { sections, groups } = await readExposure(page)

  // All twelve sections are still in the DOM, in the shipped order.
  expect(sections.map((section) => section.id)).toEqual([...SECTION_IDS])
  expect(sections.every((section) => section.attached)).toBe(true)

  // Exactly the active task's tool sections are exposed …
  expect(exposedToolIds(sections)).toEqual(expectedTools)
  // … the workspace is never filtered (no `data-task`, so no rule can catch it).
  expect(exposedIds(sections).filter((id) => SECTION_TASK[id] === undefined)).toEqual([
    'grid',
    'record',
  ])
  // Every other tool section is attached but has NO layout box (`display: none`).
  for (const [id, owner] of Object.entries(SECTION_TASK)) {
    if (owner === task) continue
    await expect(page.locator(`#section-${id}`)).toBeAttached()
    const box = await page.locator(`#section-${id}`).boundingBox()
    expect(box, `#section-${id} must be display:none while ${task} is active`).toBeNull()
  }

  // Nav: the active task's group + Workspace; the other four groups hidden.
  expect(groups.filter((group) => group.display !== 'none').map((group) => group.id)).toEqual([
    `section-nav-group-${task}`,
    'section-nav-group-workspace',
  ])
  // The four hidden group links are still in the DOM (CSS, not rendering).
  expect(await page.locator('.workbench-nav-group a').count()).toBe(12)
}

test('Explore exposes its four sections + the workspace at both desktop widths', async ({
  page,
}) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openFixture(page, CUSTOMERS, {
      assertFileNameHidden: true,
      expandSections: false,
    })
    await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')

    await expectTaskExposure(page, 'explore')

    // The contract's exact expected set (§6.1).
    const { sections } = await readExposure(page)
    expect(exposedToolIds(sections)).toEqual(['schema', 'filters', 'sql', 'profile'])
    // Hidden sections keep their headings and bodies in the DOM.
    await expect(page.locator('#section-validation h2')).toHaveCount(1)
    await expect(page.locator('#section-pipeline')).toBeAttached()
  }
})

test('Check, Change and Prepare expose exactly their own sections at both widths', async ({
  page,
}) => {
  const expected: Readonly<Record<string, readonly string[]>> = {
    check: ['validation', 'compare'],
    change: ['editing', 'history', 'export'],
    prepare: ['pipeline'],
  }

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openFixture(page, CUSTOMERS, {
      assertFileNameHidden: true,
      expandSections: false,
    })

    for (const [task, ids] of Object.entries(expected)) {
      await activateTask(page, task as 'check' | 'change' | 'prepare')
      await expect(page.getByTestId(`task-${task}`)).toHaveAttribute('aria-checked', 'true')
      await expectTaskExposure(page, task)
      const { sections } = await readExposure(page)
      expect(exposedToolIds(sections), `${task} at ${viewport.label}`).toEqual([...ids])
    }
  }
})

test('switching tasks keeps the SQL draft and performs no extra engine work', async ({ page }) => {
  // Count every worker message the page posts, BEFORE any app script runs: a
  // task switch must not open, re-describe, re-count or re-fetch anything.
  await page.addInitScript(() => {
    const holder = window as unknown as { __assayWorkerMessages: number }
    holder.__assayWorkerMessages = 0
    const original = Worker.prototype.postMessage as unknown as (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions,
    ) => void
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions,
    ): void {
      holder.__assayWorkerMessages += 1
      original.call(this, message, options)
    } as typeof Worker.prototype.postMessage
  })

  await openFixture(page, CUSTOMERS, { assertFileNameHidden: true, expandSections: false })
  await openSection(page, 'sql')
  await waitForReadyRow(page, 0)

  const DRAFT = 'SELECT country FROM __TABLE__ WHERE income > 50000 -- rd-3b draft'
  const input = page.getByTestId('sql-input')
  await input.fill(DRAFT)
  await expect(input).toHaveValue(DRAFT)

  // Mark the node identity in the DOM: if the panel were re-mounted, React
  // would have replaced the element and the marker would be gone.
  await input.evaluate((element) => {
    ;(element as HTMLElement & { __rd3bDraftNode?: string }).__rd3bDraftNode = 'same-node'
  })
  const before = await page.evaluate(
    () => (window as unknown as { __assayWorkerMessages: number }).__assayWorkerMessages,
  )

  // Explore → Check → Change → Prepare → Explore.
  for (const task of ['check', 'change', 'prepare', 'explore'] as const) {
    await activateTask(page, task)
  }

  await expect(input).toHaveValue(DRAFT)
  expect(await input.evaluate((element) => element.value), 'draft text is byte-identical').toBe(
    DRAFT,
  )
  expect(
    await input.evaluate(
      (element) => (element as HTMLElement & { __rd3bDraftNode?: string }).__rd3bDraftNode,
    ),
    'the SQL editor must be the SAME element (no remount on any task switch)',
  ).toBe('same-node')
  const after = await page.evaluate(
    () => (window as unknown as { __assayWorkerMessages: number }).__assayWorkerMessages,
  )
  expect(after, 'zero extra engine/work requests across four task switches').toBe(before)
})

test('F-2: focus never lands on <body> or inside a hidden section after a task change', async ({
  page,
}) => {
  await openFixture(page, CUSTOMERS, { assertFileNameHidden: true, expandSections: false })
  await openSection(page, 'sql')
  await waitForReadyRow(page, 0)

  /** Where focus is now, and whether that node sits in a non-rendered section. */
  const focusedInfo = async (): Promise<{ testId: string | null; inHidden: boolean }> =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      const section = active === null ? null : active.closest('.workbench-section')
      return {
        testId: active === null ? null : active.getAttribute('data-testid'),
        inHidden: section !== null && !section.checkVisibility(),
      }
    })

  // 1. Mouse: the click leaves focus on the radio the user just chose.
  await page.getByTestId('sql-input').focus()
  await expect(page.getByTestId('sql-input')).toBeFocused()
  await page.getByTestId('task-change').click()
  await expect(page.getByTestId('task-change')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-change')).toBeFocused()
  expect((await focusedInfo()).inHidden).toBe(false)
  // The panel that held focus is now hidden, and focus is NOT in it.
  const hiddenNow = await page.evaluate(() => {
    const sql = document.querySelector('#section-sql') as HTMLElement
    const active = document.activeElement as HTMLElement | null
    return {
      sqlHidden: !sql.checkVisibility(),
      focusedInsideSql: active?.closest('#section-sql') !== null,
    }
  })
  expect(hiddenNow).toEqual({ sqlHidden: true, focusedInsideSql: false })

  // 2. Keyboard: arrows move the selection AND the focus onto the new radio.
  await page.getByTestId('task-change').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('task-prepare')).toBeFocused()
  await expect(page.getByTestId('task-prepare')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Home')
  await expect(page.getByTestId('task-explore')).toBeFocused()
  expect((await focusedInfo()).inHidden).toBe(false)

  // 3. A PROGRAMMATIC cross-task change (the context bar's reveal seam) while
  //    focus sits inside an Explore panel: the seam moves focus into the
  //    revealed, exposed panel, so focus is never left in a hidden subtree and
  //    never dropped to <body>.
  await page.getByTestId('sql-input').focus()
  await expect(page.getByTestId('sql-input')).toBeFocused()
  await expect(page.getByTestId('context-state')).toHaveText('No contract loaded')
  await page.getByTestId('context-action').click()
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('validation-open-contract')).toBeFocused()
  await expect(page.locator('body')).not.toBeFocused()
  expect((await focusedInfo()).inHidden, 'never focused inside a hidden section').toBe(false)
})

test('reveal from a filtered state: pipeline gate → Validation loads the contract and focuses it', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const fixture = writeGatePipelineFixture()

  // Prepare frame: open the gated pipeline, bind, run to the gate.
  await openPipelineDocument(page, fixture.pipelinePath)
  await bindSourceDataset(page)
  await bindContract(page, fixture.failingContractPath)
  await runPipelineToGate(page)
  await expect(page.getByTestId('task-prepare')).toHaveAttribute('aria-checked', 'true')
  // Validation is filtered out of the Prepare frame (that is the point).
  const before = await readExposure(page)
  expect(exposedToolIds(before.sections)).toEqual(['pipeline'])

  // The App-level reveal seam: task switches, section exposed + expanded,
  // panel focused, run contract loaded, nothing picked and nothing run.
  await page.getByTestId('pipeline-inspect-contract').click()
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  const after = await readExposure(page)
  expect(exposedToolIds(after.sections)).toEqual(['validation', 'compare'])
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('validation-panel')).toBeVisible()
  await expect(page.getByTestId('validation-panel')).toBeFocused()
  await expect(page.getByTestId('validation-contract-name')).toContainText('gate-strict')

  // R-07: the close-focus target is EXPOSED whenever it can be the target —
  // revealing a section activates its task first, so `section-nav-validation`
  // is never a hidden link. (The move itself is the recovery path's
  // `closeSection`; the browser pin here is that the target is real and
  // focusable, never filtered out from under the focus.)
  const navLink = page.getByTestId('section-nav-validation')
  await expect(navLink).toBeVisible()
  await navLink.focus()
  await expect(navLink).toBeFocused()

  // R-04: a section link is only clicked after its task is active — the Check
  // group is exposed because Check is the active task, so the link is a real
  // target and never a hidden one. The reveal opens the section if needed.
  await page.getByTestId('section-nav-compare').click()
  await expect(page.getByTestId('section-toggle-compare')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#section-compare')).toBeInViewport()

  // A workspace anchor is always exposed and never changes the task.
  await page.getByTestId('section-nav-grid').click()
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#section-grid')).toBeVisible()
})

test('context bar actions cross tasks: Review findings → Check, Export a copy… → Change', async ({
  page,
}) => {
  test.setTimeout(180_000)
  // A dataset-level-only contract validates cleanly over customers.parquet, so
  // the bar can reach both the stale-verdict state and the delivery state.
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-rd3b-context-'))
  const contractPath = path.join(dir, 'rd3b-pass.yaml')
  writeFileSync(contractPath, 'format: v1\nname: rd3b-pass\nversion: 1\ndataset:\n  min-rows: 1\n')

  await openFixture(page, CUSTOMERS, { assertFileNameHidden: true, task: 'check' })
  await waitForReadyRow(page, 0)

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(contractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('rd3b-pass')
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toContainText('0 violations', {
    timeout: 60_000,
  })

  // 1. A clean verdict offers delivery: `Export a copy…` lands in Change with
  //    the dialog open and focus inside it.
  await expect(page.getByTestId('context-state')).toHaveText('Verdict is current — no violations')
  await activateTask(page, 'explore')
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('context-action').click()
  await expect(page.getByTestId('task-change')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('section-toggle-export')).toHaveAttribute('aria-expanded', 'true')
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()
  const focusInDialog = await page.evaluate(() => {
    const active = document.activeElement
    return active !== null && active.closest('[data-testid="export-dialog"]') !== null
  })
  expect(focusInDialog, 'focus must be inside the export dialog').toBe(true)
  await page.getByTestId('export-close').click()
  await expect(dialog).toHaveCount(0)

  // 2. Stage an edit → the verdict is stale → the bar offers `Recheck` plus the
  //    review link; `Review findings` returns to Check and focuses the panel.
  await page.getByTestId('edit-insert-row').click()
  await expect(page.getByTestId('context-state')).toContainText('Verdict stale')
  await page.getByTestId('context-review').click()
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('validation-panel')).toBeFocused()
  const { sections } = await readExposure(page)
  expect(exposedToolIds(sections)).toEqual(['validation', 'compare'])
})

/* ---- <1024px: nothing is filtered, in both schemes (ADR 0044) ---- */

for (const scheme of SCHEMES) {
  test.describe(`900px unfiltered — ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('all twelve sections and all five nav groups stay exposed with no clip', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 900, height: 900 })
      await openFixture(page, CUSTOMERS, { assertFileNameHidden: true })
      await waitForReadyRow(page, 0)

      const { sections, groups } = await readExposure(page)
      expect(sections.map((section) => section.id)).toEqual([...SECTION_IDS])
      expect(exposedIds(sections), 'no section may be filtered below 1024px').toEqual([
        ...SECTION_IDS,
      ])
      expect(groups.filter((group) => group.display !== 'none')).toHaveLength(5)

      // The narrow contract: schema → grid (promoted) → the tool sections.
      const yOf = async (id: string): Promise<number> => {
        const box = await page.locator(`#section-${id}`).boundingBox()
        if (box === null) throw new Error(`missing bounding box for ${id}`)
        return box.y
      }
      expect(await yOf('schema')).toBeLessThan(await yOf('grid'))
      expect(await yOf('grid')).toBeLessThan(await yOf('editing'))
      expect(await yOf('pipeline')).toBeGreaterThan(await yOf('profile'))

      // Sticky jump strip: the section nav stays pinned in the stack.
      const nav = page.getByTestId('section-nav')
      await expect(nav).toBeVisible()
      expect(await nav.evaluate((element) => getComputedStyle(element).position)).toBe('sticky')

      // Scroll, never clip (ux-1).
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
    })
  })
}

/* ---- axe per task, both schemes, both desktop widths ---- */

for (const scheme of SCHEMES) {
  test.describe(`axe per task — ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('zero unallowlisted critical/serious violations in every task frame', async ({ page }) => {
      test.setTimeout(240_000)
      await page.goto('/')
      // Non-vacuity for the dark pass: prove the emulated scheme reached the
      // page, so a dark scan cannot silently re-run the light one.
      const prefersDark = await page.evaluate(
        () => window.matchMedia('(prefers-color-scheme: dark)').matches,
      )
      expect(prefersDark, `emulated colour scheme must be ${scheme}`).toBe(scheme === 'dark')

      await openFixture(page, CUSTOMERS, { assertFileNameHidden: true, expandSections: false })

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        for (const task of ['explore', 'check', 'change', 'prepare'] as const) {
          await activateTask(page, task)
          // Non-vacuity: the frame really switched (its radio is checked and
          // its sections are the exposed ones).
          await expect(page.getByTestId(`task-${task}`)).toHaveAttribute('aria-checked', 'true')
          const { sections } = await readExposure(page)
          expect(exposedToolIds(sections).length).toBeGreaterThan(0)

          const results = await scanA11y(page)
          const critical = results.violations.filter(
            (violation) => violation.impact === 'critical' || violation.impact === 'serious',
          )
          assertNoCriticalOrSerious(critical, DEFERRED_A11Y)
          expect(
            summarizeViolations(critical),
            `${task} @ ${viewport.label} (${scheme}) must stay on the empty allowlist`,
          ).toBe('no violations')
        }
      }
    })
  })
}
