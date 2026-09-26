import { expect, test } from '@playwright/test'
import type { CDPSession, Page } from '@playwright/test'
import { bigFixturePath, BIG_ROW_COUNT, ensureBigFixture } from './support/big-fixture'
import { median, percentile } from './support/stats'
import os from 'node:os'

// Task M1-7 benchmark (handoff §6 #7, roadmap G1 evidence): time-to-first-row
// and memory for the engine path on a ~1 GiB Parquet file.
//
// GATED: this spec is SKIPPED unless ASSAY_E2E_BIG_BENCH=1 — it generates a
// ~1.1 GiB fixture into the OS temp dir and runs a multi-minute in-browser
// benchmark, which must never burden the default e2e/CI runtime. Run it with:
//
//   ASSAY_E2E_BIG_BENCH=1 ASSAY_E2E_PORT_ENGINE=4179 DUCKDB=/path/to/duckdb \
//     pnpm test:e2e tests/e2e/bench-ttfr.spec.ts
//
// (pnpm passes positional args through verbatim — do NOT add `--`, which
// pnpm 11 swallows and the whole suite runs; harmless but slow.)
// (the full suite honors the same env; see docs/engineering/05-m1-benchmarks.md
// for methodology, results, and reproduction).
//
// Fixture size is env-tunable via ASSAY_E2E_BIG_ROWS (default 16M rows ≈
// 1.1 GiB; the G1-R round used 150M rows ≈ 10 GiB).
//
// Path under test (orchestrator scope ruling): the engine-duckdb browser
// harness — file "pick" (input fallback, same seam as the app) → open() →
// schema()/rowCount() → first fetchRange window (TTFR) → projected query →
// filtered query → N sequential windows. Grid responsiveness is NOT
// re-measured here: the m1-5 e2e (tests/e2e/grid-virtualization.spec.ts)
// already proves the 1M-row virtualized grid with frame timing; this spec
// covers the engine half of G1. Each repeat uses a fresh page (fresh engine
// worker) so measurements are cold; timing is taken in-page with
// performance.now() inside the harness (packages/engine-duckdb/harness).
//
// Memory methodology: CDP `Performance.getMetrics` on the page session
// (JSHeapUsedSize / JSHeapSizeLimit) at checkpoints. The DuckDB-WASM heap
// lives in dedicated worker threads; CDP sessions routed to worker targets
// do not answer commands on Chromium ~150 (verified by probe: attachToTarget
// succeeds, Performance.enable/Runtime.evaluate never reply) and Playwright
// exposes page-scoped sessions only — worker heaps are therefore out of
// scope here and recorded as an open question in the benchmark note.

const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

/** Measurement repeats; median is reported per metric. */
const REPEATS = 3
/** Rows per fetchRange window (the engine cap; matches grid viewport fetches). */
const WINDOW_ROWS = 1000
/** Sequential windows spread across the file (grid-like access pattern). */
const WINDOW_COUNT = 12

/** Generous, CI-safe sanity bounds — real but never tight (see the note). */
const BOUNDS = {
  bootMs: 20_000, // DuckDB-WASM startup (R4)
  openMs: 10_000, // lazy file registration (metadata only)
  schemaMs: 5_000,
  rowCountMs: 5_000,
  ttfrMs: 10_000, // first 1000-row window incl. IPC + reconstitution
  projectedMs: 10_000,
  filteredMs: 60_000, // near-full scan in single-threaded WASM
  winMedianMs: 15_000, // deep OFFSET windows scan a prefix of the file
  winMaxMs: 60_000,
} as const

/** Heap must stay below this fraction of JSHeapSizeLimit (R1 headroom). */
const HEAP_LIMIT_FRACTION = 0.5

type Checkpoint = 'preBoot' | 'postBoot' | 'postOpen' | 'postFirstRow' | 'postWindows'

interface HeapSample {
  readonly usedBytes: number
  readonly limitBytes: number
}

/** The JSON blob the harness bench steps accumulate (harness main.ts). */
interface BenchTimings {
  bootMs?: number
  openMs?: number
  schemaMs?: number
  schemaColumns?: number
  rowCountMs?: number
  rowCount?: number
  ttfrMs?: number
  ttfrRows?: number
  ttfrFirstId?: string
  projectedMs?: number
  projectedRows?: number
  filteredMs?: number
  filteredRows?: number
  filteredMatchingRows?: number
  windowsTotalMs?: number
  windows?: { offset: number; ms: number; rows: number }[]
}

interface RepeatResult {
  readonly bootMs: number
  readonly openMs: number
  readonly schemaMs: number
  readonly rowCountMs: number
  readonly ttfrMs: number
  readonly projectedMs: number
  readonly filteredMs: number
  readonly windowsTotalMs: number
  readonly winMinMs: number
  readonly winMedianMs: number
  readonly winP95Ms: number
  readonly winMaxMs: number
  /** boot + open + schema + rowCount + ttfr: pick → first visible row. */
  readonly pickerToFirstRowMs: number
  readonly rowCount: number
  readonly ttfrRows: number
  readonly ttfrFirstId: string
  readonly projectedRows: number
  readonly filteredRows: number
  readonly filteredMatchingRows: number
  readonly windowsDetail: readonly { offset: number; ms: number; rows: number }[]
  readonly heap: Record<Checkpoint, HeapSample>
}

test.skip(
  process.env['ASSAY_E2E_BIG_BENCH'] !== '1',
  'gated: set ASSAY_E2E_BIG_BENCH=1 to run the ~1 GiB m1-7 benchmark',
)

test.beforeAll(() => {
  // Fixture generation runs here (reused only after a full sha256
  // re-verification). At multi-GB sizes this takes minutes (G1-R: 150M rows
  // ≈ 10 GiB, generation + verification ≈ 5–6 min), far beyond the default
  // 30 s hook timeout (playwright.config.ts sets none). A hook raises its
  // own timeout by calling test.setTimeout() inside it (Playwright 1.63).
  test.setTimeout(900_000) // 15 min: generation + sha256 verification headroom
  ensureBigFixture()
})

async function heapSnapshot(cdp: CDPSession, page: Page): Promise<HeapSample> {
  const [{ metrics }, limitBytes] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    page.evaluate((): number => {
      // Chromium-only, non-standard API (see the methodology comment above).
      interface ChromePerformanceMemory {
        readonly jsHeapSizeLimit: number
      }
      const memory = (performance as { memory?: ChromePerformanceMemory }).memory
      if (memory === undefined || memory.jsHeapSizeLimit <= 0) {
        throw new Error('performance.memory.jsHeapSizeLimit unavailable')
      }
      return memory.jsHeapSizeLimit
    }),
  ])
  const read = (name: string): number => {
    const found = metrics.find((metric) => metric.name === name)
    if (found === undefined) throw new Error(`CDP metric ${name} missing`)
    return found.value
  }
  return { usedBytes: read('JSHeapUsedSize'), limitBytes }
}

/** Wait for a bench step to finish; surface harness-side errors with context. */
async function expectBenchPhase(page: Page, phase: string, timeoutMs: number): Promise<void> {
  const phaseEl = page.getByTestId('bench-phase')
  await expect
    .poll(async () => (await phaseEl.textContent()) ?? '', {
      timeout: timeoutMs,
      intervals: [250, 500, 1000],
    })
    .toMatch(new RegExp(`^(${phase}|error)$`))
  const actual = (await phaseEl.textContent()) ?? ''
  if (actual === 'error') {
    const message = (await page.getByTestId('bench-error').textContent()) ?? '(no message)'
    throw new Error(`bench step "${phase}" failed in the harness: ${message}`)
  }
  expect(actual, `bench step ${phase} should complete`).toBe(phase)
}

async function clickBenchStep(
  page: Page,
  step: string,
  phase: string,
  timeoutMs: number,
): Promise<void> {
  await page.getByRole('button', { name: step }).click()
  await expectBenchPhase(page, phase, timeoutMs)
}

function heapMb(sample: HeapSample): number {
  return Math.round(sample.usedBytes / 1048576)
}

test('time-to-first-row and memory over a ~1 GiB Parquet (engine path)', async ({ browser }) => {
  // 25 min: 3 cold repeats at multi-GB size — in the G1-R round each repeat's
  // near-full-scan filter alone took ~20–30 s and the 12 sequential windows
  // (deep offsets) several more; generous by design, like BOUNDS below.
  test.setTimeout(1_500_000)
  const fixturePath = bigFixturePath()
  const repeats: RepeatResult[] = []
  const browserVersion = browser.version()

  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    // Fresh page = fresh engine worker = cold DuckDB state per repeat.
    const page = await browser.newPage()
    try {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')
      await page.goto(HARNESS_URL)
      // Laziness contract still holds: no boot before a bench step asks.
      await expect(page.getByTestId('engine-status')).toHaveText('idle')

      const heap: Record<Checkpoint, HeapSample> = {
        preBoot: await heapSnapshot(cdp, page),
        postBoot: { usedBytes: 0, limitBytes: 0 },
        postOpen: { usedBytes: 0, limitBytes: 0 },
        postFirstRow: { usedBytes: 0, limitBytes: 0 },
        postWindows: { usedBytes: 0, limitBytes: 0 },
      }

      await page.setInputFiles('[data-testid="bench-file-input"]', fixturePath)
      await clickBenchStep(page, 'bench: boot engine', 'boot-done', BOUNDS.bootMs + 40_000)
      heap.postBoot = await heapSnapshot(cdp, page)
      await clickBenchStep(page, 'bench: open selected file', 'open-done', BOUNDS.openMs + 40_000)
      heap.postOpen = await heapSnapshot(cdp, page)
      await clickBenchStep(
        page,
        'bench: schema + rowCount',
        'schema-done',
        BOUNDS.schemaMs + BOUNDS.rowCountMs + 40_000,
      )
      await clickBenchStep(page, 'bench: first window (TTFR)', 'ttfr-done', BOUNDS.ttfrMs + 40_000)
      heap.postFirstRow = await heapSnapshot(cdp, page)
      await clickBenchStep(
        page,
        'bench: projected query',
        'projected-done',
        BOUNDS.projectedMs + 40_000,
      )
      await clickBenchStep(
        page,
        'bench: filtered query',
        'filtered-done',
        BOUNDS.filteredMs + 60_000,
      )
      await clickBenchStep(
        page,
        'bench: sequential windows',
        'windows-done',
        BOUNDS.winMaxMs * WINDOW_COUNT,
      )
      heap.postWindows = await heapSnapshot(cdp, page)

      const timings = JSON.parse(
        (await page.getByTestId('bench-result').textContent()) ?? '{}',
      ) as BenchTimings
      const required = (value: number | undefined, field: string): number => {
        if (value === undefined)
          throw new Error(`harness timings missing "${field}": ${JSON.stringify(timings)}`)
        return value
      }
      const windows = timings.windows ?? []
      expect(windows).toHaveLength(WINDOW_COUNT)
      const windowLatencies = windows.map((sample) => sample.ms)

      const record: RepeatResult = {
        bootMs: required(timings.bootMs, 'bootMs'),
        openMs: required(timings.openMs, 'openMs'),
        schemaMs: required(timings.schemaMs, 'schemaMs'),
        rowCountMs: required(timings.rowCountMs, 'rowCountMs'),
        ttfrMs: required(timings.ttfrMs, 'ttfrMs'),
        projectedMs: required(timings.projectedMs, 'projectedMs'),
        filteredMs: required(timings.filteredMs, 'filteredMs'),
        windowsTotalMs: required(timings.windowsTotalMs, 'windowsTotalMs'),
        winMinMs: Math.min(...windowLatencies),
        winMedianMs: median(windowLatencies),
        winP95Ms: percentile(windowLatencies, 95),
        winMaxMs: Math.max(...windowLatencies),
        pickerToFirstRowMs:
          required(timings.bootMs, 'bootMs') +
          required(timings.openMs, 'openMs') +
          required(timings.schemaMs, 'schemaMs') +
          required(timings.rowCountMs, 'rowCountMs') +
          required(timings.ttfrMs, 'ttfrMs'),
        rowCount: required(timings.rowCount, 'rowCount'),
        ttfrRows: required(timings.ttfrRows, 'ttfrRows'),
        ttfrFirstId: timings.ttfrFirstId ?? '',
        projectedRows: required(timings.projectedRows, 'projectedRows'),
        filteredRows: required(timings.filteredRows, 'filteredRows'),
        filteredMatchingRows: required(timings.filteredMatchingRows, 'filteredMatchingRows'),
        windowsDetail: timings.windows ?? [],
        heap,
      }
      repeats.push(record)
    } finally {
      await page.close()
    }
  }

  expect(repeats).toHaveLength(REPEATS)

  // Correctness anchors (deterministic fixture: id == row index).
  for (const rec of repeats) {
    expect(rec.rowCount, 'rowCount reports the fixture size').toBe(BIG_ROW_COUNT)
    expect(rec.ttfrRows, 'TTFR window is full').toBe(WINDOW_ROWS)
    expect(rec.ttfrFirstId, 'TTFR window starts at row 0').toBe('0')
    expect(rec.projectedRows, 'projected query window is full').toBe(WINDOW_ROWS)
    expect(rec.filteredRows, 'filtered aggregate returns a 1-row batch').toBe(1)
    expect(rec.filteredMatchingRows, 'filter matches a plausible share').toBeGreaterThan(0)
    expect(rec.filteredMatchingRows, 'filter is selective (not most of the file)').toBeLessThan(
      rec.rowCount / 50,
    )
  }

  // Timing sanity bounds (generous; see BOUNDS).
  for (const rec of repeats) {
    expect(rec.bootMs, `boot ${rec.bootMs}ms`).toBeLessThan(BOUNDS.bootMs)
    expect(rec.openMs, `open ${rec.openMs}ms`).toBeLessThan(BOUNDS.openMs)
    expect(rec.schemaMs, `schema ${rec.schemaMs}ms`).toBeLessThan(BOUNDS.schemaMs)
    expect(rec.rowCountMs, `rowCount ${rec.rowCountMs}ms`).toBeLessThan(BOUNDS.rowCountMs)
    expect(rec.ttfrMs, `TTFR ${rec.ttfrMs}ms`).toBeLessThan(BOUNDS.ttfrMs)
    expect(rec.projectedMs, `projected ${rec.projectedMs}ms`).toBeLessThan(BOUNDS.projectedMs)
    expect(rec.filteredMs, `filtered ${rec.filteredMs}ms`).toBeLessThan(BOUNDS.filteredMs)
    expect(rec.winMedianMs, `window median ${rec.winMedianMs}ms`).toBeLessThan(BOUNDS.winMedianMs)
    expect(rec.winMaxMs, `window max ${rec.winMaxMs}ms`).toBeLessThan(BOUNDS.winMaxMs)
    // Memory sanity: main-thread heap stays well under the JS heap limit (R1).
    for (const checkpoint of ['postFirstRow', 'postWindows'] as const) {
      const { usedBytes, limitBytes } = rec.heap[checkpoint]
      expect(usedBytes, `${checkpoint} heap`).toBeGreaterThan(0)
      expect(
        usedBytes,
        `${checkpoint} heap ${(usedBytes / 1048576).toFixed(0)}MB must stay below ${HEAP_LIMIT_FRACTION * 100}% of limit ${(limitBytes / 1048576).toFixed(0)}MB`,
      ).toBeLessThan(limitBytes * HEAP_LIMIT_FRACTION)
    }
  }

  // Machine-readable summary: per repeat, then the median across repeats.
  for (const [index, rec] of repeats.entries()) {
    console.log(
      `[m1-7 bench windows] repeat=${index + 1}/${REPEATS} offsetMs=` +
        (rec.windowsDetail ?? []).map((sample) => `${sample.offset}:${sample.ms}`).join(' '),
    )
  }
  for (const rec of repeats) {
    console.log(
      `[m1-7 bench] browser=${browserVersion} heapLimitMB=${(rec.heap.postFirstRow.limitBytes / 1048576).toFixed(0)} ` +
        `rows=${rec.rowCount} bootMs=${rec.bootMs.toFixed(1)} openMs=${rec.openMs.toFixed(1)} ` +
        `schemaMs=${rec.schemaMs.toFixed(1)} rowCountMs=${rec.rowCountMs.toFixed(1)} ttfrMs=${rec.ttfrMs.toFixed(1)} ` +
        `projectedMs=${rec.projectedMs.toFixed(1)} filteredMs=${rec.filteredMs.toFixed(1)} ` +
        `winMinMs=${rec.winMinMs.toFixed(1)} winMedianMs=${rec.winMedianMs.toFixed(1)} winP95Ms=${rec.winP95Ms.toFixed(1)} winMaxMs=${rec.winMaxMs.toFixed(1)} ` +
        `pickerToFirstRowMs=${rec.pickerToFirstRowMs.toFixed(1)} ` +
        `heapPreBootMB=${heapMb(rec.heap.preBoot)} heapPostBootMB=${heapMb(rec.heap.postBoot)} ` +
        `heapPostOpenMB=${heapMb(rec.heap.postOpen)} heapPostFirstRowMB=${heapMb(rec.heap.postFirstRow)} heapPostWindowsMB=${heapMb(rec.heap.postWindows)}`,
    )
  }
  const med = (pick: (rec: RepeatResult) => number): number => median(repeats.map(pick))
  console.log(
    `[m1-7 bench median] repeats=${REPEATS} browser=${browserVersion} ` +
      `bootMs=${med((r) => r.bootMs).toFixed(1)} openMs=${med((r) => r.openMs).toFixed(1)} ` +
      `schemaMs=${med((r) => r.schemaMs).toFixed(1)} rowCountMs=${med((r) => r.rowCountMs).toFixed(1)} ` +
      `ttfrMs=${med((r) => r.ttfrMs).toFixed(1)} projectedMs=${med((r) => r.projectedMs).toFixed(1)} ` +
      `filteredMs=${med((r) => r.filteredMs).toFixed(1)} winMedianMs=${med((r) => r.winMedianMs).toFixed(1)} ` +
      `winP95Ms=${med((r) => r.winP95Ms).toFixed(1)} pickerToFirstRowMs=${med((r) => r.pickerToFirstRowMs).toFixed(1)} ` +
      `heapPostWindowsMB=${med((r) => heapMb(r.heap.postWindows))}`,
  )
  console.log(
    `[m1-7 bench env] platform=${os.platform()} ${os.arch()} cpus=${os.cpus().length} ` +
      `cpuModel=${os.cpus()[0]?.model.trim() ?? 'unknown'} totalMemGB=${(os.totalmem() / 1024 ** 3).toFixed(1)} ` +
      `node=${process.version}`,
  )
})
