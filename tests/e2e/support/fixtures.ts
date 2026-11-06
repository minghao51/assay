import path from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Shared picker-path fixture opens (q-5, AR-F4). Every surface opens the
 * committed golden fixtures through the hidden-`<input type="file">` fallback
 * the specs arm in `beforeEach`; the open flow itself is identical, so it has
 * one definition here. The optional ready-frame extras (schema panel visible,
 * picked name hidden) are options so each call keeps its exact assertions.
 */

/** The committed customers fixture (5 rows) opened by three grid specs. */
const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const NESTED_FIXTURE = path.join(process.cwd(), 'fixtures', 'jsonl', 'nested.jsonl')

/** Ready-frame assertions some surfaces add on top of the shared open flow. */
export interface OpenFixtureOptions {
  /** Run after the idle frame and immediately before the picker gesture. */
  readonly beforeOpen?: (page: Page) => Promise<void>
  /** Also assert the schema panel rendered (schema-panel's ready bar). */
  readonly requireSchemaPanel?: boolean
  /** Also assert the picked name never renders in `table-info` (ADR 0025). */
  readonly assertFileNameHidden?: boolean
  /**
   * q-15: expand every shell-managed tool section after open (default true).
   * The two-pane pane starts with only Schema expanded, so legacy journeys
   * that interact with a collapsed panel opt in through this shared step (the
   * slice-1 precedent: specs gain open-section steps via shared helpers). The
   * shell journey (`shell.spec.ts`) passes `false` to pin the real default.
   */
  readonly expandSections?: boolean
  /**
   * rd-3b: the task the open flow ends on (default `'explore'`, the shell
   * default). Sections outside the active task are `display: none` at
   * ≥1024px, so a spec that drives another task states it here instead of
   * clicking a hidden control. Forwarded to `expandAllSections` as `endTask`,
   * so it only applies while `expandSections` is not `false`: a spec that pins
   * the collapsed first paint calls `activateTask` itself.
   */
  readonly task?: WorkbenchTask
}

/**
 * rd-3b: the four workbench tasks, in reading order. A task is a navigation
 * grouping only — never a session, a dataset or an execution scope.
 */
export type WorkbenchTask = 'explore' | 'check' | 'change' | 'prepare'

/** Task reading order, used by `expandAllSections`. */
const WORKBENCH_TASK_ORDER: readonly WorkbenchTask[] = ['explore', 'check', 'change', 'prepare']

/**
 * rd-3b: which task owns each tool section (`workbench/tasks.ts` is the runtime
 * authority; this is the spec-side mirror). Grid and Record are the workspace
 * and have no task, so they are absent here and are never filtered.
 */
export const SECTION_TASK: Readonly<Record<string, WorkbenchTask>> = {
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

/** Managed sections the shell owns a `section-toggle-<id>` for. */
const MANAGED_SECTION_IDS = [
  'grid',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'sql',
  'pipeline',
] as const

/**
 * ug-13 / R-14: verbatim purpose subtitle per tool section (implementation
 * spec §2). Held here with the other open-flow copy so specs assert one
 * authority instead of re-typing strings.
 */
export const SECTION_PURPOSES = {
  schema: 'Fields and types',
  grid: 'Browse the rows',
  filters: 'Show only matching rows',
  validation: 'Check data against rules',
  compare: 'Diff two datasets by key',
  sql: 'Query with DuckDB SQL',
  editing: 'Stage edits in this session',
  history: 'Review and undo staged edits',
  export: 'Write a reviewed copy',
  record: 'Inspect one row in full',
  profile: 'Column statistics summary',
  pipeline: 'Chained contract checks',
} as const

/** ug-13 / R-14: the Record dock's closed-state hint (value-free, ADR 0025). */
export const RECORD_CLOSED_HINT =
  'Select a row to inspect it here — press Enter or double-click a row.'

/** Expand one shell-managed section (idempotent, task-aware). */
export async function openSection(page: Page, id: string, task?: WorkbenchTask): Promise<void> {
  // rd-3b: only the active task's sections are exposed at ≥1024px, so the
  // owning task is activated FIRST — a hidden toggle is not clickable, and
  // activating never reloads or remounts the panel it reveals.
  const owner = task ?? SECTION_TASK[id]
  if (owner !== undefined) await activateTask(page, owner)
  if (id === 'profile') {
    // Profile is an inner-disclosure panel (no shell toggle); its own control
    // is the disclosure, in Explore as before.
    const profileToggle = page.getByTestId('profile-toggle')
    if ((await profileToggle.getAttribute('aria-expanded')) !== 'true') {
      await profileToggle.click()
    }
    await expect(profileToggle).toHaveAttribute('aria-expanded', 'true')
    return
  }
  const toggle = page.getByTestId(`section-toggle-${id}`)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/**
 * rd-3b: select a workbench task. Idempotent — it only clicks the radio when
 * that task is not already checked — so a spec can state the task it needs at
 * the boundary it needs it instead of tracking the shell's current selection.
 */
export async function activateTask(page: Page, task: WorkbenchTask): Promise<void> {
  const radio = page.getByTestId(`task-${task}`)
  if ((await radio.getAttribute('aria-checked')) !== 'true') {
    await radio.click()
  }
  await expect(radio).toHaveAttribute('aria-checked', 'true')
}

/**
 * q-15: expand every shell-managed tool section plus the Profile inner
 * disclosure, so a legacy journey sees the same panel set it saw before the
 * two-pane default (all managed sections open). Safe to call repeatedly.
 *
 * rd-3b: exposure is per task at ≥1024px, so the expansion walks the tasks in
 * reading order and opens each task's own sections while that task is active;
 * it ends on `endTask` (default Explore, the shell default) so the LAST
 * activation is the one the calling spec needs. Every section is still opened
 * — a spec never silently loses its "everything expanded" starting state —
 * and no visibility is asserted for a section after switching away from it.
 * Grid (workspace, no `data-task`) is opened once, from any task.
 */
export async function expandAllSections(
  page: Page,
  options: { readonly endTask?: WorkbenchTask } = {},
): Promise<void> {
  const endTask = options.endTask ?? 'explore'
  await openSection(page, 'grid')
  for (const task of WORKBENCH_TASK_ORDER) {
    await activateTask(page, task)
    for (const id of MANAGED_SECTION_IDS) {
      if (SECTION_TASK[id] === task) await openSection(page, id, task)
    }
    // Profile's inner disclosure belongs to Explore (it is an Explore section).
    if (task === 'explore') await openSection(page, 'profile', task)
  }
  await activateTask(page, endTask)
}

/** Open a fixture through the app's real picker path and wait until ready. */
export async function openFixture(
  page: Page,
  fixturePath: string,
  options: OpenFixtureOptions = {},
): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  if (options.beforeOpen !== undefined) await options.beforeOpen(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixturePath)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  if (options.expandSections !== false) {
    await expandAllSections(page, { endTask: options.task ?? 'explore' })
  }
  if (options.requireSchemaPanel === true) {
    await expect(page.getByTestId('schema-panel')).toBeVisible()
  }
  if (options.assertFileNameHidden === true) {
    await expect(page.getByTestId('table-info')).not.toContainText(path.basename(fixturePath))
  }
}

/**
 * Open customers.parquet and pin the ready-frame facts shared by the
 * column-ops / grid-editing / grid-filter-sort specs: 5 total rows and a
 * privacy-safe `table-info` (never the picked file's name, ADR 0025).
 */
export async function openCustomersFixture(
  page: Page,
  fixturePath: string = CUSTOMERS_FIXTURE,
): Promise<void> {
  await openFixture(page, fixturePath, { assertFileNameHidden: true })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
}

/**
 * Open a fixture and return the engine-generated table id (SQL pane). Pins
 * the pane's privacy contract too (ADR 0025): the SQL pane never renders the
 * picked file's path. The id is read from the SQL pane hint (`sql-table-id`)
 * because the ux-2 info line no longer exposes the engine handle; the pane
 * keeps rendering the `assay_t…` view name that SQL specs need.
 */
export async function openFixtureAndGetTableId(
  page: Page,
  fixturePath: string,
  options: OpenFixtureOptions = {},
): Promise<string> {
  await openFixture(page, fixturePath, options)
  await expect(page.getByTestId('sql-panel')).not.toContainText(fixturePath)
  return page.getByTestId('sql-table-id').innerText()
}

/**
 * Open the shared nested JSONL fixture and pin its rows, columns, and privacy.
 * `expandSections: false` keeps the real collapsed shell defaults (ug-1's
 * reveal acceptance starts there); every other option passes through to
 * `openFixture`.
 */
export async function openNestedFixture(
  page: Page,
  options: OpenFixtureOptions = {},
): Promise<{ tableId: string; viewName: string }> {
  const tableId = await openFixtureAndGetTableId(page, NESTED_FIXTURE, options)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')
  await expect(page.getByTestId('grid-column-count')).toHaveText('10')
  await expect(page.getByTestId('table-info')).not.toContainText(path.basename(NESTED_FIXTURE))
  return { tableId, viewName: `assay_${tableId}` }
}

/** Open the flat engine-harness fixture and wait until it reports opened. */
export async function openFlatFixture(
  page: Page,
  harnessUrl: string = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`,
): Promise<void> {
  await page.goto(harnessUrl)
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page.getByRole('button', { name: 'Open flat fixture via engine' }).click()
  await expect(page.getByTestId('open-status-flat')).toHaveText('opened', { timeout: 20_000 })
  await expect(page.getByTestId('open-table-id-flat')).toHaveText('t1')
}

/** Click a harness action and parse its JSON evidence once the result is ready. */
export async function clickAndGetJson<T>(
  page: Page,
  buttonLabel: string | RegExp,
  testId: string,
): Promise<T> {
  await page.getByRole('button', { name: buttonLabel }).click()
  const element = page.getByTestId(testId)
  await expect(element).not.toHaveText('not run')
  return JSON.parse((await element.textContent())!) as T
}

/**
 * Open the collapsible filter bar (ux-4; collapsed by default). Idempotent:
 * a programmatic `setFilters` (e.g. the validation panel's "Show only failing
 * rows" bridge) auto-opens it, so a spec that only needs the SQL-fragment
 * escape hatch or a built filter can call this unconditionally.
 */
export async function openFilterBar(page: Page): Promise<void> {
  const toggle = page.getByTestId('filter-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  await expect(page.getByTestId('filter-body')).toBeVisible()
}
