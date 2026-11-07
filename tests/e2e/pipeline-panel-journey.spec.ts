import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Locator, Page } from '@playwright/test'
import {
  PIPELINE_DATASET_FIXTURE,
  bindContract,
  bindLoadedContractViaPrimary,
  bindOpenDatasetViaPrimary,
  bindSourceDataset,
  openNodePreview,
  openPipelineDocument,
  openPipelineOnOpenDataset,
  pipelineNode,
  runPipelineToCompletion,
  runPipelineToGate,
  watchFileChoosers,
  writeGatePipelineFixture,
} from './support/pipeline-panel'
import { activateTask, openFixture } from './support/fixtures'

// p-5/p2-6 journey: open a pipeline file → inspect the DAG → run it on the
// real engine → a node's output opens GRID-NATIVE (the p2-1 view-as-handle
// op; the same handle-based grid model a dataset open uses — no SQL-result
// detour). Every in-app activation is KEYBOARD-OPERABLE (focus + Enter on the
// same controls a mouse user clicks — the a11y-keyboard.spec discipline); the
// picker path is the hidden-`<input type="file">` fallback, so each pick
// arrives as a filechooser event. The engine is the real DuckDB-WASM client;
// the runner is the real p2-4 executePipeline bound to its postMessage ops.
//
// Pinned counts are the golden pipeline's (fixtures/pipeline/cli_run.yaml
// over the customers fixture): 5 source rows → 5 after the rename → 2 after
// the SG filter → 1 aggregate row.
//
// The Pipeline section is a tool-pane resident ordered last (after profile) in
// both layouts (q-15 ruling, 2026-10-02); the 900px test pins the ux-1
// scroll-never-clip discipline for the new section at the minimum supported
// width.

const NODE_IDS = ['customers', 'renamed', 'sg_only', 'by_country']

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; fail loudly at
      // the chooser rather than silently taking a different path.
    }
  })
})

/** All four node rows, resolved fresh on every call. */
function nodeRows(page: Page): Locator {
  return page.locator('[data-testid="pipeline-node"]')
}

/** Status text of one node row (resolved fresh). */
function statusText(page: Page, nodeId: string): Locator {
  return pipelineNode(page, nodeId).getByTestId('pipeline-node-status')
}

test('pipeline journey: open → inspect → run → preview output (keyboard-operable)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openPipelineDocument(page)

  // Inspect: the DAG renders as an ordered list in topological (execution)
  // order, every node pending, the source honestly unbound, the terminal
  // relation flagged as the output, and each node carries a materialization
  // badge.
  await expect(nodeRows(page)).toHaveCount(4)
  for (const [index, nodeId] of NODE_IDS.entries()) {
    await expect(nodeRows(page).nth(index)).toHaveAttribute('data-node-id', nodeId)
  }
  await expect(nodeRows(page).nth(0)).toHaveAttribute('data-node-kind', 'source')
  await expect(nodeRows(page).nth(3)).toHaveAttribute('data-node-kind', 'sql')
  await expect(nodeRows(page).nth(0).getByTestId('pipeline-node-materialization')).toHaveText(
    'source',
  )
  await expect(nodeRows(page).nth(3).getByTestId('pipeline-node-materialization')).toHaveText(
    'view',
  )
  for (const nodeId of NODE_IDS) {
    await expect(statusText(page, nodeId)).toHaveText('Pending')
  }
  await expect(page.getByTestId('pipeline-source-pending')).toBeVisible()
  await expect(page.getByTestId('pipeline-summary')).toContainText('1 output')
  // Lineage (arch §16) is an ordered list, not a graph.
  await expect(page.getByTestId('pipeline-lineage-datasets')).toContainText('customers')
  // Privacy (ADR 0025): the picked pipeline file's name never renders.
  await expect(page.getByTestId('pipeline-panel')).not.toContainText('cli_run.yaml')

  // Run: bind the source through the real picker path, then run on the real
  // engine. The Run control is the serialized entry point (p-3 carry-over).
  await bindSourceDataset(page)
  await runPipelineToCompletion(page)

  for (const [index, expected] of [
    'Done · 5 rows',
    'Done · 5 rows',
    'Done · 2 rows',
    'Done · 1 row',
  ].entries()) {
    await expect(statusText(page, NODE_IDS[index])).toHaveText(expected)
  }
  await expect(page.getByTestId('pipeline-cancel')).toBeDisabled()

  // Preview: the terminal relation opens grid-native through the p2-1
  // handle op — the EXISTING grid model/schema surfaces render it (no SQL
  // detour). The preview shows the sample rows, schema, and generated SQL.
  await openNodePreview(page, 'by_country')
  const preview = page.getByTestId('pipeline-preview')
  await expect(preview.getByTestId('pipeline-preview-meta')).toContainText('by_country')
  await expect(preview.getByTestId('pipeline-preview-columns')).toContainText('country')
  await expect(preview.getByTestId('pipeline-preview-sql')).toContainText('GROUP BY')
  const grid = preview.getByTestId('pipeline-preview-grid')
  await expect(grid.getByTestId('grid-header-name')).toHaveText(['country', 'customers'])
  await expect(grid.getByTestId('grid-cell')).toHaveText(['SG', '2'])

  // Close returns to the ordered list.
  await page.getByTestId('pipeline-preview-close').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-preview')).toHaveCount(0)
})

test('pipeline section at 900px: reachable by nav, controls never clipped', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openPipelineDocument(page)
  await bindSourceDataset(page)

  // The keyboard journey completes at 900px (ux-1: scroll, never clip).
  await runPipelineToCompletion(page)
  await openNodePreview(page, 'by_country')

  // The run controls, the node list, the preview button, and the preview grid
  // sit fully inside the viewport box after the anchor navigation (no
  // clipping at the minimum width).
  const viewportBox = { width: 900, height: 900 }
  for (const testId of [
    'pipeline-run',
    'pipeline-cancel',
    'pipeline-nodes',
    'pipeline-preview-grid',
  ]) {
    const box = await page.getByTestId(testId).boundingBox()
    if (box === null) throw new Error(`missing bounding box for ${testId}`)
    expect(box.x, testId).toBeGreaterThanOrEqual(0)
    expect(box.y, testId).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, testId).toBeLessThanOrEqual(viewportBox.width + 1)
    // Below the fold is fine (scroll, never clip): only horizontal
    // overflow would clip. Assert the page itself never overflows.
  }
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})

/**
 * ug-9 / R-15 (c): the DCR purpose sentence, verbatim from the implementation
 * spec §2. Written out here so a copy regression cannot agree with itself.
 */
const DCR_PURPOSE_SENTENCE =
  'A Dataset Change Request packages a proposed dataset change for review — like a pull request for data.'

/** The DCR expansion (the first mention in the pipeline panel). */
const DCR_EXPANSION = 'Dataset Change Request (DCR)'

/** One validation rule row, resolved fresh. */
function validationRule(page: Page, ruleId: string): Locator {
  return page.locator(`[data-testid="validation-rule"][data-rule-id="${ruleId}"]`)
}

/**
 * R-15 (a): the pipeline continues the journey. With the dataset open AND a
 * contract already loaded in Validation, both bindings — the source node's
 * "Use the open dataset" and the validate node's "Use the loaded contract" —
 * complete from App-held state. The file-chooser spy is armed BEFORE either
 * primary, so ANY OS dialog opened by a binding (or by the subsequent run)
 * fails the test instead of being silently absorbed by a picker fallback.
 */
test('R-15 (a): source + validate nodes bind from App-held state with no file chooser', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const fixture = writeGatePipelineFixture()

  // Open the dataset, then load the passing contract in Validation (the two
  // legitimate setup picks — both happen before the spy is armed). rd-3b:
  // Validation is a Check section, so that leg activates Check; the pipeline
  // document leg then activates Prepare (inside `openPipelineOnOpenDataset`).
  await openFixture(page, PIPELINE_DATASET_FIXTURE)
  await activateTask(page, 'check')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(fixture.passingContractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-pass')

  // Open the pipeline document on the SAME session (no dataset re-open).
  await openPipelineOnOpenDataset(page, fixture.pipelinePath)

  // Both primaries carry the exact R-15 copy.
  await expect(page.getByTestId('pipeline-bind-open-dataset')).toHaveText('Use the open dataset')
  await expect(page.getByTestId('pipeline-bind-loaded-contract')).toHaveText(
    'Use the loaded contract',
  )

  const choosers = watchFileChoosers(page)
  await bindOpenDatasetViaPrimary(page)
  await bindLoadedContractViaPrimary(page)
  // Bindings landed without a picker.
  await expect(page.getByTestId('pipeline-source-bound')).toBeVisible()
  await expect(page.getByTestId('pipeline-contract-bound')).toBeVisible()
  choosers.expectNone()

  // Run to a settled verdict on the real engine (validate passes over the SG
  // subset, so the publish gate is satisfied).
  await runPipelineToCompletion(page)
  choosers.expectNone()

  // R-15 (c) text pin on the panel's rendered text: the FIRST "DCR" token is
  // inside the expansion, and the purpose sentence is present verbatim.
  const panelText = await page.getByTestId('pipeline-panel').innerText()
  const expansionIndex = panelText.indexOf(DCR_EXPANSION)
  expect(expansionIndex).toBeGreaterThanOrEqual(0)
  expect(panelText.indexOf('DCR')).toBe(expansionIndex + 'Dataset Change Request ('.length)
  expect(panelText).toContain(DCR_PURPOSE_SENTENCE)
  await expect(page.getByTestId('pipeline-dcr-export').locator('legend')).toHaveText(
    'Export the Dataset Change Request (DCR)',
  )
})

/**
 * R-15 (b): a validate-gate failure is no longer a dead end. The gate detail
 * offers "Inspect this contract in Validation"; activating it reveals +
 * expands the Validation section, loads the RUN's bound contract (no picker)
 * and focuses the section, so the user's next Validate names the failing
 * ruleIds. Loading is NOT validating — the cross-link itself runs nothing.
 *
 * Setup uses the existing gated fixture/helper posture: the pipeline's strict
 * contract is bound through the real contract picker BEFORE the spy is armed;
 * the cross-link and the subsequent explicit Validate must not pick anything.
 * Review round: the validate node is RE-BOUND to the passing contract after
 * the failed run, so this journey also pins that the cross-link loads the
 * run's start-of-run contract (the snapshot), never the new binding.
 */
test('R-15 (b): gate-failure cross-link loads the run contract into Validation, no picker', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const fixture = writeGatePipelineFixture()

  await openFixture(page, PIPELINE_DATASET_FIXTURE)
  // A DIFFERENT contract is loaded in Validation first, so the cross-link's
  // load is observable (the session visibly replaces it with the run's).
  // rd-3b: Validation is a Check section — that leg activates Check.
  await activateTask(page, 'check')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(fixture.passingContractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-pass')

  await openPipelineOnOpenDataset(page, fixture.pipelinePath)
  await bindOpenDatasetViaPrimary(page)
  // The gate's failing contract is bound through the existing picker helper.
  await bindContract(page, fixture.failingContractPath)
  await runPipelineToGate(page)

  const gated = page.getByTestId('pipeline-run-gated')
  await expect(gated).toBeVisible()
  await expect(page.getByTestId('pipeline-run-gated-detail')).toContainText('failed 1 rule')

  // The section is collapsed before the cross-link, so reveal + expand is a
  // real state change rather than a vacuous "already open". rd-3b: the toggle
  // belongs to the Check frame, so Check is activated for the collapse and the
  // Prepare frame (the gated run below) is restored afterwards — the cross-link
  // itself must do the reveal from a filtered state.
  await activateTask(page, 'check')
  await page.getByTestId('section-toggle-validation').click()
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await activateTask(page, 'prepare')

  // Review-round pin: RE-BIND the validate node to a DIFFERENT (passing)
  // contract AFTER the failed run. The gated detail still belongs to the old
  // run, so the cross-link must load the contract THAT RUN failed — not this
  // new binding (which would make the next Validate pass and misattribute
  // the failure).
  await bindContract(page, fixture.passingContractPath)

  const choosers = watchFileChoosers(page)
  await page.getByTestId('pipeline-inspect-contract').click()

  // Revealed + expanded + focused, and the RUN's contract is loaded — the
  // re-bind above did NOT replace it.
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('validation-panel')).toBeVisible()
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-strict')
  await expect(page.getByTestId('validation-panel')).toBeFocused()
  // Loading is not validating: no verdict exists yet.
  await expect(page.getByTestId('validation-verdict')).toHaveCount(0)
  choosers.expectNone()

  // The explicit Validate now names the failing ruleIds (the strict contract's
  // required-income rule over the base dataset).
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toContainText('rules fail', {
    timeout: 60_000,
  })
  await expect(validationRule(page, 'columns[2].required')).toHaveAttribute('data-failing', 'true')
  await expect(
    validationRule(page, 'columns[2].required').getByTestId('validation-rule-id'),
  ).toHaveText('columns[2].required')
  choosers.expectNone()
})

/**
 * ---------------------------------------------------------------------------
 * rd-6 — the Prepare journey (evidence/continuity slice; decision D-01 = A).
 * ---------------------------------------------------------------------------
 * rd-6 adds NO surface and NO copy: it binds the shipped ordered runner, gate
 * refusal, preview/lineage and DCR-delivery surfaces to the TASK strip and
 * pins, in one real-browser journey, that (a) the plan is an ordered list in
 * the file's execution order, (b) each node reports its real status/evidence,
 * (c) a gate refusal stops the downstream node with a readable refusal, (d)
 * the gate → Validation cross-link is a real Prepare → Check transition that
 * exposes + focuses Validation, and (e) Prepare → Check → Prepare preserves the
 * run state (no re-run, no re-mount).
 *
 * Two recorded D-01 limitations are pinned as FACTS, never fixed here (both
 * would need a new approved string, which D-01 forbids): the Pipeline section
 * renders no collapsed-state summary, and the context bar carries no pipeline
 * awareness. Pinning them means an unapproved string shows up as a failing
 * journey instead of shipping silently.
 *
 * The plan is `source(customers) → filter(SG)(sg) → validate(strict)(gate) →
 * publish(blocked by gate)(publish_out) → rename(tail)` over the customers
 * fixture: 5 rows, 2 after the SG filter (one with a NULL income), so the
 * strict contract fails 1 rule and the publish is blocked. `tail` sits
 * DOWNSTREAM of the refusal and is therefore never executed — the shared
 * `writeGatePipelineFixture` plan is terminal at its publish (`out` is itself
 * the gate the run stops at), so it cannot show that a refusal protects a
 * later node.
 */

/** The ten tool sections and the task that owns each (`workbench/tasks.ts`). */
const OWNING_TASK: Readonly<Record<string, string>> = {
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

/**
 * The rd-6 plan's EXECUTION order (dependencies first). The YAML below authors
 * the nodes in the opposite spirit (dependents first: `tail` … `customers`),
 * and the runner orders by the DAG with a smallest-id tie-break, so this array
 * cannot pass by echoing the file's text order.
 */
const RD6_PLAN_ORDER = ['customers', 'sg', 'gate', 'publish_out', 'tail']

/** The rd-6 gate plan (same failing contract as the shared gate fixture). */
const RD6_PIPELINE_YAML = `version: 1
pipeline: gate_downstream
nodes:
  tail:
    type: transform
    inputs: [ sg ]
    operation:
      rename:
        columns:
          country: country_code
  publish_out:
    type: publish
    input: sg
    requires: [ gate ]
  gate:
    type: validate
    input: sg
    contract: contracts/strict.yaml
  sg:
    type: transform
    inputs: [ customers ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
  customers:
    type: source
    source:
      kind: file
      path: ./customers.parquet
`

/**
 * Stage the rd-6 plan beside the shared gate fixture's contracts (one
 * authority for the strict contract's bytes — a local copy could drift from
 * the plan the other gate journeys pin).
 */
function writeRd6Fixture(): { pipelinePath: string; failingContractPath: string } {
  const shared = writeGatePipelineFixture()
  const pipelinePath = path.join(path.dirname(shared.pipelinePath), 'rd6-downstream.yaml')
  writeFileSync(pipelinePath, RD6_PIPELINE_YAML)
  return { pipelinePath, failingContractPath: shared.failingContractPath }
}

/** One plan row, read from the live document. */
interface PlanNode {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly statusText: string
  readonly relation: string
}

/**
 * The plan in DOCUMENT order — `<ol data-testid="pipeline-nodes">` children in
 * the order the DOM actually renders them — with each node's live status
 * attribute, status line and relation evidence. One read pins order AND status
 * together, so a reordered list cannot pass on presence alone.
 */
async function readPlan(page: Page): Promise<PlanNode[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="pipeline-node"]')).map((node) => {
      const text = (testId: string): string =>
        (node.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      return {
        id: node.getAttribute('data-node-id') ?? '',
        kind: node.getAttribute('data-node-kind') ?? '',
        status: node.getAttribute('data-node-status') ?? '',
        statusText: text('pipeline-node-status'),
        relation: text('pipeline-node-relation'),
      }
    }),
  )
}

/** The task frame the layout is really rendering (measured, never inferred). */
interface TaskFrame {
  readonly paneTask: string | null
  readonly checked: readonly string[]
  readonly exposed: readonly string[]
}

async function readTaskFrame(page: Page): Promise<TaskFrame> {
  return page.evaluate(() => ({
    paneTask: document.querySelector('.workbench-tools')?.getAttribute('data-task') ?? null,
    checked: Array.from(document.querySelectorAll('[role="radio"][aria-checked="true"]')).map(
      (radio) => radio.getAttribute('data-task-choice') ?? '',
    ),
    exposed: Array.from(document.querySelectorAll('.workbench-section'))
      .filter((section) => getComputedStyle(section).display !== 'none')
      .map((section) => section.getAttribute('data-section') ?? ''),
  }))
}

/** Count the pipeline-run start messages the page has posted so far. */
async function countRunStarts(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __rd6PipelineRunStarts: number }).__rd6PipelineRunStarts,
  )
}

test('rd-6 Prepare journey: ordered plan, real statuses, gate refusal, cross-link, preserved run state', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const fixture = writeRd6Fixture()

  // A re-run is engine-visible: `runPipeline` registers the source relation
  // exactly once per run (`engine/pipeline-source`), so counting that message
  // from before the app boots proves a task switch re-ran nothing. The patch
  // only observes and forwards — it rewrites no message and holds no state the
  // app reads.
  await page.addInitScript(() => {
    const holder = window as unknown as { __rd6PipelineRunStarts: number }
    holder.__rd6PipelineRunStarts = 0
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
      const type = (message as { type?: unknown } | null)?.type
      if (type === 'engine/pipeline-source') holder.__rd6PipelineRunStarts += 1
      original.call(this, message, options)
    } as typeof Worker.prototype.postMessage
  })

  // ---- 1. The Explore default, before any task is chosen. -----------------
  await openFixture(page, PIPELINE_DATASET_FIXTURE, { expandSections: false })
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
  expect(await readTaskFrame(page)).toEqual({
    paneTask: 'explore',
    checked: ['explore'],
    exposed: ['schema', 'filters', 'sql', 'profile', 'grid', 'record'],
  })
  await expect(page.locator('#section-pipeline')).toBeHidden()

  // ---- 2. Choose Prepare through the real radio. --------------------------
  await page.getByTestId('task-prepare').click()
  await expect(page.getByTestId('task-prepare')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.workbench-tools')).toHaveAttribute('data-task', 'prepare')
  expect(await readTaskFrame(page)).toEqual({
    paneTask: 'prepare',
    checked: ['prepare'],
    exposed: ['pipeline', 'grid', 'record'],
  })
  // Choosing Prepare opens the Pipeline section (its only manageable section)
  // and shows the panel's honest zero state — Prepare IS the pipeline's task.
  await expect(page.getByTestId('section-toggle-pipeline')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('pipeline-zero-state')).toBeVisible()
  // Every OTHER task's sections are `display: none` (still mounted, so no
  // remount and no lost panel state): the CSS exposure rule, measured.
  for (const [id, task] of Object.entries(OWNING_TASK)) {
    if (task === 'prepare') continue
    await expect(page.locator(`#section-${id}`)).toBeAttached()
    await expect(page.locator(`#section-${id}`)).toBeHidden()
  }
  // The workspace is never filtered.
  await expect(page.locator('#section-grid')).toBeVisible()

  // ---- 3. Open the pipeline file and bind both artifacts. ----------------
  await openPipelineOnOpenDataset(page, fixture.pipelinePath)
  await expect(page.getByTestId('pipeline-summary')).toContainText('5 nodes in execution order')
  await expect(page.getByTestId('pipeline-summary')).toContainText('1 source awaiting a dataset')
  await expect(page.getByTestId('pipeline-summary')).toContainText(
    '1 validate node awaiting a contract',
  )
  // NOT asserted: the summary's "N outputs". Its `isOutput` derivation counts
  // every node no transform consumes (a gate and a publish included), which is
  // a pre-existing panel derivation outside this slice's scope — pinning the
  // number here would endorse it and pinning the "correct" one would need a
  // runtime change no decision authorizes (recorded in the rd-6 report).

  // The plan is a semantic <ol> whose DOM order is the file's execution order.
  expect(
    await page.getByTestId('pipeline-nodes').evaluate((list) => ({
      tag: list.tagName,
      label: list.getAttribute('aria-label'),
      items: Array.from(list.children).map((item) => item.tagName),
    })),
  ).toEqual({
    tag: 'OL',
    label: 'Pipeline nodes in execution order',
    items: ['LI', 'LI', 'LI', 'LI', 'LI'],
  })
  expect((await readPlan(page)).map((node) => node.id)).toEqual(RD6_PLAN_ORDER)
  // Nothing has run: every node is honestly pending, with its kind + relation.
  expect(await readPlan(page)).toEqual([
    {
      id: 'customers',
      kind: 'source',
      status: 'pending',
      statusText: 'Pending',
      relation: 'relation customers',
    },
    {
      id: 'sg',
      kind: 'transform',
      status: 'pending',
      statusText: 'Pending',
      relation: 'relation sg',
    },
    {
      id: 'gate',
      kind: 'validate',
      status: 'pending',
      statusText: 'Pending',
      relation: 'relation gate',
    },
    {
      id: 'publish_out',
      kind: 'publish',
      status: 'pending',
      statusText: 'Pending',
      relation: 'relation publish_out',
    },
    {
      id: 'tail',
      kind: 'transform',
      status: 'pending',
      statusText: 'Pending',
      relation: 'relation tail',
    },
  ])
  await expect(
    pipelineNode(page, 'customers').getByTestId('pipeline-node-materialization'),
  ).toHaveText('source')
  await expect(pipelineNode(page, 'gate').getByTestId('pipeline-node-materialization')).toHaveText(
    'gate',
  )
  await expect(pipelineNode(page, 'publish_out').getByTestId('pipeline-node-output')).toHaveText(
    'output',
  )
  await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-state', 'idle')
  await expect(page.getByTestId('pipeline-run-status')).toHaveText('Not run yet.')

  await bindSourceDataset(page)
  await bindContract(page, fixture.failingContractPath)
  await expect(page.getByTestId('pipeline-source-bound')).toBeVisible()
  await expect(page.getByTestId('pipeline-contract-bound')).toBeVisible()
  await expect(page.getByTestId('pipeline-summary')).not.toContainText('awaiting')

  // ---- 4. Run to the gate refusal. ---------------------------------------
  await runPipelineToGate(page)
  expect(await readPlan(page)).toEqual([
    {
      id: 'customers',
      kind: 'source',
      status: 'done',
      statusText: 'Done · 5 rows',
      relation: 'relation customers',
    },
    {
      id: 'sg',
      kind: 'transform',
      status: 'done',
      statusText: 'Done · 2 rows',
      relation: 'relation sg',
    },
    { id: 'gate', kind: 'validate', status: 'done', statusText: 'Done', relation: 'relation gate' },
    {
      id: 'publish_out',
      kind: 'publish',
      status: 'gated',
      statusText: 'Stopped at gate',
      relation: 'relation publish_out',
    },
    {
      id: 'tail',
      kind: 'transform',
      status: 'pending',
      statusText: 'Pending',
      relation: 'relation tail',
    },
  ])
  // Per-node evidence beyond the status line: the gate verdict and the publish
  // refusal are value-free and readable in place.
  await expect(pipelineNode(page, 'gate').getByTestId('pipeline-node-gate')).toHaveText(
    'Validate: failed — 1 rule violated',
  )
  await expect(pipelineNode(page, 'publish_out').getByTestId('pipeline-node-gate')).toHaveText(
    'Publish: blocked by gate',
  )

  // The refusal leaves the DOWNSTREAM node unexecuted, stated in three
  // independent places: its plan row is still `Pending`, it has no gate
  // verdict and no preview handle (nothing was materialized to preview), and
  // the run's own report names it as the node that did not run.
  await expect(statusText(page, 'tail')).toHaveText('Pending')
  await expect(pipelineNode(page, 'tail').getByTestId('pipeline-node-gate')).toHaveCount(0)
  await expect(pipelineNode(page, 'tail').getByTestId('pipeline-preview-open')).toHaveCount(0)
  await expect(pipelineNode(page, 'sg').getByTestId('pipeline-preview-open')).toHaveCount(1)

  await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-state', 'gated')
  await expect(page.getByTestId('pipeline-run-status')).toHaveText(
    'Stopped at gate publish_out — nothing downstream was executed.',
  )
  await expect(page.getByTestId('pipeline-run-gated')).toContainText('a publish gate is blocked')
  await expect(page.getByTestId('pipeline-run-gated')).toContainText(
    'The next node tail was not executed.',
  )
  // The run's RECORDED OUTCOMES must not reach the downstream node.
  //
  // RECORDED DEFECT, not fixed here (fixing it needs new copy and/or a new
  // derivation, which D-01 forbids): the panel prints this set under
  // "Completed before the stop" even though its last entry is the
  // gate-blocked publish — the runner records that publish's own outcome
  // before returning `gated`
  // (packages/engine-duckdb/src/pipeline-runner/runner.ts:503-505), and the
  // panel labels every recorded outcome as completed
  // (apps/web/src/pipeline/PipelinePanel.tsx:777-787). So neither the set's
  // contents nor its label is asserted as a true "completed prefix" here: the
  // node-level facts above carry the meaning (the blocked publish is `gated`,
  // `tail` is `Pending` with no verdict and no preview handle), and the set is
  // checked only for the absence of the node the refusal protected.
  const recordedOutcomes = await page
    .getByTestId('pipeline-run-gated-completed')
    .locator('code')
    .allInnerTexts()
  expect(recordedOutcomes).not.toContain('tail')
  // The refusal is real: the nodes it depends on did execute and are recorded.
  expect(recordedOutcomes).toEqual(expect.arrayContaining(['customers', 'sg', 'gate']))
  await expect(page.getByTestId('pipeline-run-gated-detail')).toContainText('Blocked gates')
  await expect(page.getByTestId('pipeline-run-gated-detail').locator('code')).toHaveText(['gate'])
  await expect(page.getByTestId('pipeline-run-gated-detail')).toContainText('failed 1 rule')
  await expect(page.getByTestId('pipeline-cancel')).toBeDisabled()

  // ---- 5. Preview, lineage and delivery evidence, INSIDE Prepare. --------
  await openNodePreview(page, 'sg')
  const preview = page.getByTestId('pipeline-preview')
  await expect(preview).toBeVisible()
  await expect(preview.getByTestId('pipeline-preview-meta')).toContainText('sg · 2 rows')
  await expect(preview.getByTestId('pipeline-preview-sql')).toContainText('WHERE')
  await expect(preview.getByTestId('pipeline-preview-delta-empty')).toBeVisible()
  await expect(preview.getByTestId('pipeline-preview-grid').getByTestId('grid-row')).toHaveCount(2)
  await page.getByTestId('pipeline-preview-close').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-preview')).toHaveCount(0)

  await expect(page.getByTestId('pipeline-lineage-datasets')).toContainText(
    'customers → sg, gate, publish_out, tail',
  )
  await expect(page.getByTestId('pipeline-lineage-nodes')).toContainText('requires gate')
  const delivery = page.getByTestId('pipeline-dcr-export')
  await expect(delivery).toBeVisible()
  await expect(delivery.locator('legend')).toHaveText('Export the Dataset Change Request (DCR)')
  // Only an EXECUTED data node is offered as a side: `publish_out` is a gate
  // and `tail` never ran, so neither can be guessed as a version.
  await expect(page.getByTestId('pipeline-dcr-base-node').locator('option')).toHaveText([
    'choose the base node…',
    'sg',
  ])
  await expect(page.getByTestId('pipeline-dcr-export-run')).toBeDisabled()

  // D-01 count discipline: the panel summary is the ONE count authority (the
  // bar never copies it). "nodes in execution order" is the <ol>'s aria-label
  // (an attribute) plus the summary (rendered text) — exactly one rendered hit.
  const bodyText = await page.locator('body').innerText()
  expect(bodyText.split('nodes in execution order')).toHaveLength(2)
  // The bar renders the approved §2 facts and one validation-era action; it
  // carries NO pipeline or gate state (D-01 limitation 2, pinned as a fact).
  const bar = page.getByTestId('dataset-context')
  // The approved §2 facts, verbatim (the rendered text is not
  // whitespace-separated, so each fact is pinned on its own).
  for (const fact of [
    'Current dataset view',
    '5 rows × 4 columns',
    'No staged operations',
    'No contract loaded',
    'Open a contract…',
  ]) {
    await expect(bar).toContainText(fact)
  }
  await expect(bar).not.toContainText('gate')
  await expect(bar).not.toContainText('pipeline')
  await expect(bar).not.toContainText('5 nodes')
  await expect(bar).not.toContainText('Stopped at')
  // Recorded D-01 limitation 1, pinned as a fact (no new copy is authorized):
  // the Pipeline section still renders no collapsed-state summary.
  await expect(page.getByTestId('section-summary-pipeline')).toHaveCount(0)
  await expect(page.getByTestId('section-purpose-pipeline')).toHaveCount(1)

  // ---- 6. The gate → Validation cross-link is a real task transition. ----
  const runStartsAfterRun = await countRunStarts(page)
  const planInPrepare = await readPlan(page)
  // Mark the MOUNTED panel: a re-mount would replace the element and lose it.
  await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="pipeline-panel"]')
    if (panel === null) throw new Error('the pipeline panel is not mounted')
    ;(panel as HTMLElement & { __rd6MountNode?: string }).__rd6MountNode = 'prepare-run-1'
  })
  expect(runStartsAfterRun).toBeGreaterThan(0)

  await page.getByTestId('pipeline-inspect-contract').click()

  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-prepare')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.workbench-tools')).toHaveAttribute('data-task', 'check')
  expect(await readTaskFrame(page)).toEqual({
    paneTask: 'check',
    checked: ['check'],
    exposed: ['validation', 'compare', 'grid', 'record'],
  })
  await expect(page.locator('#section-pipeline')).toBeHidden()
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('validation-panel')).toBeVisible()
  await expect(page.getByTestId('validation-panel')).toBeFocused()
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-strict')
  // Loading is not validating.
  await expect(page.getByTestId('validation-verdict')).toHaveCount(0)
  // The cross-link is a reveal + load, not a run: no new run start reached the
  // engine (the counter is unchanged from the Prepare run above).
  expect(await countRunStarts(page)).toBe(runStartsAfterRun)

  // R-07's close-focus target is EXPOSED and focusable while Check is the
  // active task (the reveal activates the task first, so the link is never a
  // hidden focus target). The panel's own "Close section" action only exists on
  // the recovery fallback (`App.panel-boundary.test.tsx` pins that move), so
  // the user-visible close here is the section's disclosure: collapsing it
  // keeps the panel mounted and does not strand focus on <body>, and
  // re-opening it through the real section link returns to the SAME panel
  // still holding the run's contract.
  const navLink = page.getByTestId('section-nav-validation')
  await expect(navLink).toBeVisible()
  await expect(navLink).toBeInViewport()
  await navLink.focus()
  await expect(navLink).toBeFocused()
  await expect(page.locator('#section-validation')).toBeInViewport()

  const validationToggle = page.getByTestId('section-toggle-validation')
  await validationToggle.focus()
  await page.keyboard.press('Enter')
  await expect(validationToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('validation-panel')).toBeHidden()
  // Focus stayed on the control that closed the section — it was not dropped
  // into <body> by the collapse.
  await expect(validationToggle).toBeFocused()

  await navLink.click()
  await expect(validationToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-strict')
  await expect(page.getByTestId('validation-verdict')).toHaveCount(0)

  // ---- 7. Back to Prepare: the run state survived the round trip. --------
  await page.getByTestId('task-prepare').click()
  await expect(page.getByTestId('task-prepare')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.workbench-tools')).toHaveAttribute('data-task', 'prepare')
  expect(await readTaskFrame(page)).toEqual({
    paneTask: 'prepare',
    checked: ['prepare'],
    exposed: ['pipeline', 'grid', 'record'],
  })
  await expect(page.locator('#section-validation')).toBeHidden()
  await expect(page.getByTestId('pipeline-panel')).toBeVisible()
  // No re-mount: the marked element is the same node.
  expect(
    await page.evaluate(
      () =>
        (
          document.querySelector('[data-testid="pipeline-panel"]') as
            (HTMLElement & { __rd6MountNode?: string }) | null
        )?.__rd6MountNode ?? null,
    ),
  ).toBe('prepare-run-1')
  // No re-run: the same statuses, the same gated outcome, and no new run start
  // was posted to the engine.
  expect(await readPlan(page)).toEqual(planInPrepare)
  await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-state', 'gated')
  // The same recorded outcome set, still without the downstream node — the
  // round trip re-ran nothing (the label caveat in step 4 applies: the set's
  // "completed" wording is the recorded defect, deliberately not pinned).
  expect(
    await page.getByTestId('pipeline-run-gated-completed').locator('code').allInnerTexts(),
  ).not.toContain('tail')
  await expect(page.getByTestId('pipeline-dcr-export')).toBeVisible()
  expect(await countRunStarts(page)).toBe(runStartsAfterRun)
})
