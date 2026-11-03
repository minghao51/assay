// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ux-a2: structural pins for the CONFIGURED-disclosure CI leg and the two
 * defects the audit found around it (implementation spec §6).
 *
 * The driven browser proof is `tests/visual/telemetry-disclosure-theme.spec.ts`
 * on a build with `ASSAY_TELEMETRY_ENDPOINT` baked in; the cheap, fast pins
 * here fail on the exact regression classes this row exists to prevent:
 *
 * 1. the dedicated `configured-telemetry` job disappearing, or a second lane
 *    quietly gaining the endpoint (the stock `verify`/`e2e`/`vscode-verify`
 *    lanes must stay endpoint-free, and root Playwright discovery must stay
 *    limited to `tests/e2e`);
 * 2. the job losing its isolation posture — least-privilege permissions, a
 *    timeout, frozen install, Chromium, and SHA-pinned `uses:` refs;
 * 3. the configured bundle being produced by the ROOT Turbo build (or the
 *    stock build not preceding it), i.e. the turbo 2.x strict-env-mode
 *    variable drop plus stock cache hit that leaves the disclosure absent;
 * 4. the endpoint-presence proof vanishing or moving AFTER the browser leg
 *    (losing a fail-fast build diagnostic; an endpoint-free build still fails
 *    the browser's disclosure-visibility assertions);
 * 5. the leg being invoked implicitly (retries on, or the stock `test:e2e`
 *    discovery) instead of by the explicit isolated config with zero retries;
 * 6. the spec's load-bearing privacy ordering regressing (collector route
 *    registered after navigation, or the abort/non-vacuity assertions dropped);
 * 7. the fixed 2.5 s flush sleep returning instead of the bounded
 *    `expect.poll` on the intercepted-attempt count;
 * 8. the visual config's guidance reverting to the broken "export the endpoint
 *    and run the root build" comment, or a preview server becoming reusable.
 *
 * These are source pins over files this row owns (the workflow is the
 * orchestrator-granted exception). Nothing here duplicates the browser
 * evidence; the browser leg stays the proof of the rendered disclosure.
 */

const WORKFLOW = readFileSync(resolve(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8')
const ROOT_PLAYWRIGHT_CONFIG = readFileSync(resolve(process.cwd(), 'playwright.config.ts'), 'utf8')
const VISUAL_CONFIG = readFileSync(
  resolve(process.cwd(), 'tests', 'visual', 'playwright.telemetry.config.ts'),
  'utf8',
)
const VISUAL_SPEC = readFileSync(
  resolve(process.cwd(), 'tests', 'visual', 'telemetry-disclosure-theme.spec.ts'),
  'utf8',
)

/** The one job allowed to configure the collector endpoint. */
const CONFIGURED_JOB = 'configured-telemetry'
/** Lanes that must never see a configured endpoint. */
const STOCK_JOBS = ['verify', 'e2e', 'vscode-verify'] as const
/** The synthetic collector origin (classroom-invalid TLD; never a real host). */
const ENDPOINT = 'https://collector.example.invalid/ingest'
/** The explicit isolated config the configured leg must use. */
const VISUAL_CONFIG_PATH = 'tests/visual/playwright.telemetry.config.ts'

/**
 * Split the workflow into `jobId → body`. Only the `jobs:` map is inspected;
 * headers are the two-space `id:` lines, so `on:`/`permissions:`/`concurrency:`
 * above it can never be mistaken for a job.
 */
function splitJobs(yaml: string): Map<string, string> {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  if (start < 0) throw new Error('workflow has no `jobs:` block')
  const jobs = new Map<string, string>()
  let current: { readonly id: string; readonly body: string[] } | null = null
  for (const line of lines.slice(start + 1)) {
    // A new zero-indented line ends the jobs map (there is none today, but a
    // later top-level key must not be swallowed into the last job).
    if (/^[^\s#]/.test(line)) break
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header !== null) {
      if (current !== null) jobs.set(current.id, current.body.join('\n'))
      current = { id: header[1] ?? '', body: [] }
      continue
    }
    if (current !== null) current.body.push(line)
  }
  if (current !== null) jobs.set(current.id, current.body.join('\n'))
  return jobs
}

/** The job body, or a hard failure naming the missing job. */
function jobBody(yaml: string, id: string): string {
  const body = splitJobs(yaml).get(id)
  if (body === undefined) throw new Error(`missing CI job: ${id}`)
  return body
}

/**
 * Split a job body into steps (each `      - ` item). Job-level keys such as
 * `env:` never start a step, so a job-level value can never satisfy a pin that
 * is about a step's own content.
 */
function splitSteps(job: string): string[] {
  const steps: string[][] = []
  for (const line of job.split('\n')) {
    if (/^ {6}- /.test(line)) {
      steps.push([line])
      continue
    }
    const last = steps.at(-1)
    if (last !== undefined) last.push(line)
  }
  return steps.map((lines) => lines.join('\n'))
}

/** A step's text with YAML comment lines removed (prose cannot satisfy a pin). */
function codeOnly(step: string): string {
  return step
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

/** Index of the single step matching `predicate`, failing loudly otherwise. */
function stepIndex(steps: readonly string[], predicate: (step: string) => boolean): number {
  return steps.findIndex(predicate)
}

const JOBS = splitJobs(WORKFLOW)

describe('ux-a2 dedicated configured-telemetry CI job', () => {
  it('defines exactly one isolated job that configures the collector endpoint', () => {
    expect(JOBS.has(CONFIGURED_JOB), `expected a \`${CONFIGURED_JOB}\` job`).toBe(true)

    const withEndpoint = [...JOBS.entries()]
      .filter(([, body]) => body.includes('ASSAY_TELEMETRY_ENDPOINT'))
      .map(([id]) => id)
    // Deleting the job, or configuring any other lane, fails here: the endpoint
    // may be baked into exactly one disposable job.
    expect(withEndpoint).toEqual([CONFIGURED_JOB])
  })

  it('keeps least-privilege, timeout, frozen install, Chromium and SHA-pinned actions', () => {
    const job = jobBody(WORKFLOW, CONFIGURED_JOB)

    expect(job).toMatch(/permissions:\n {6}contents: read\n/)
    expect(job).toMatch(/timeout-minutes: \d+/)
    expect(job).toMatch(/pnpm install --frozen-lockfile/)
    expect(job).toMatch(/playwright install --with-deps chromium/)
    // The leg is retry-free by contract, so CI must be set for `forbidOnly`
    // and for the leg's own zero-retry invocation to mean anything.
    expect(job).toMatch(/CI: '1'/)

    const usesRefs = [...job.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1] ?? '')
    expect(usesRefs.length).toBeGreaterThanOrEqual(4)
    for (const ref of usesRefs) {
      expect(ref, `uses ref must be a full commit SHA: ${ref}`).toMatch(/@[0-9a-f]{40}$/)
    }
    for (const action of ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node']) {
      // Present AND SHA-pinned — an action bump may change the SHA, but never
      // to a tag or branch ref.
      expect(
        usesRefs.find((ref) => ref.startsWith(`${action}@`)),
        `${action} must be used by this job`,
      ).toMatch(/^[@\w./-]+@[0-9a-f]{40}$/)
    }
  })

  it('builds stock first, then the web package DIRECTLY (never a configured Turbo build)', () => {
    const steps = splitSteps(jobBody(WORKFLOW, CONFIGURED_JOB))

    const stockIndex = stepIndex(steps, (step) => /^ {6}- run: pnpm build$/m.test(step))
    const configuredIndex = stepIndex(steps, (step) => step.includes('ASSAY_TELEMETRY_ENDPOINT='))
    expect(stockIndex, 'a stock `pnpm build` step must exist').toBeGreaterThanOrEqual(0)
    expect(configuredIndex, 'a configured build step must exist').toBeGreaterThanOrEqual(0)
    // The engine/data-sources preview harnesses need the stock build first.
    expect(stockIndex).toBeLessThan(configuredIndex)

    const configured = steps[configuredIndex] ?? ''
    const configuredCode = codeOnly(configured)
    expect(configuredCode).toContain('env -u ASSAY_NO_TELEMETRY')
    expect(configuredCode).toContain('-u ASSAY_TELEMETRY_TOKEN')
    expect(configuredCode).toContain(`ASSAY_TELEMETRY_ENDPOINT=${ENDPOINT}`)
    expect(configuredCode).toContain('pnpm --filter @assay/web build')
    // Mutant killer for the audit's defect: a root `pnpm build` in this step
    // is a strict-env variable drop plus a stock turbo cache hit. `pnpm build`
    // must not appear here at all (only the `--filter @assay/web` form).
    expect(configuredCode).not.toMatch(/pnpm build\b/)
  })

  it('proves the endpoint is in the emitted bundle BEFORE running the leg', () => {
    const steps = splitSteps(jobBody(WORKFLOW, CONFIGURED_JOB))

    const proofIndex = stepIndex(
      steps,
      (step) =>
        step.includes('grep') &&
        step.includes('apps/web/dist') &&
        step.includes('collector.example.invalid'),
    )
    const legIndex = stepIndex(
      steps,
      (step) => step.includes('playwright test') && step.includes(VISUAL_CONFIG_PATH),
    )
    expect(proofIndex, 'an endpoint-presence proof step must exist').toBeGreaterThanOrEqual(0)
    expect(legIndex, 'the configured leg must be invoked').toBeGreaterThanOrEqual(0)
    // Fail early with a build diagnostic rather than waiting for the
    // disclosure-visibility assertion to time out on an endpoint-free build.
    expect(proofIndex).toBeLessThan(legIndex)

    const proof = steps[proofIndex] ?? ''
    expect(proof).toContain('apps/web/dist')
    // The proof must FAIL the job, not merely warn.
    expect(proof).toMatch(/exit 1/)
  })

  it('runs the leg through its isolated config with zero retries', () => {
    const steps = splitSteps(jobBody(WORKFLOW, CONFIGURED_JOB))
    const legIndex = stepIndex(
      steps,
      (step) => step.includes('playwright test') && step.includes(VISUAL_CONFIG_PATH),
    )
    expect(legIndex).toBeGreaterThanOrEqual(0)

    const leg = steps[legIndex] ?? ''
    expect(leg).toContain(`--config ${VISUAL_CONFIG_PATH}`)
    expect(leg).toContain('--retries=0')
    // The stock discovery/script must never stand in for the configured leg.
    expect(leg).not.toContain('test:e2e')
    expect(leg).not.toContain('--config playwright.config.ts')
  })

  it('leaves the stock lanes and root Playwright discovery endpoint-free', () => {
    for (const id of STOCK_JOBS) {
      const job = jobBody(WORKFLOW, id)
      for (const name of [
        'ASSAY_TELEMETRY_ENDPOINT',
        'ASSAY_TELEMETRY_TOKEN',
        'ASSAY_NO_TELEMETRY',
        'collector.example.invalid',
      ]) {
        expect(job, `${id} must stay endpoint-free (found ${name})`).not.toContain(name)
      }
    }

    // The stock runner keeps discovering only tests/e2e: the configured leg
    // lives outside that directory and is never part of the default run.
    expect(ROOT_PLAYWRIGHT_CONFIG).toMatch(/testDir: '\.\/tests\/e2e'/)
    expect(ROOT_PLAYWRIGHT_CONFIG).not.toContain('tests/visual')
  })
})

describe('ux-a2 configured-disclosure leg source', () => {
  it('registers the aborting collector route BEFORE navigating, with fresh storage', () => {
    expect(VISUAL_SPEC).toContain('page.route(`${COLLECTOR_ORIGIN}/**`')
    expect(VISUAL_SPEC).toContain("route.abort('blockedbyclient')")
    expect(VISUAL_SPEC).toContain('window.localStorage.clear()')

    const routeAt = VISUAL_SPEC.indexOf('blockCollector(page, intercepted)')
    const gotoAt = VISUAL_SPEC.indexOf("await page.goto('/')")
    expect(
      routeAt,
      'the collector route must be registered in the test body',
    ).toBeGreaterThanOrEqual(0)
    expect(gotoAt, 'the leg must navigate to the app').toBeGreaterThanOrEqual(0)
    // Registered after navigation = a real request could escape first.
    expect(routeAt).toBeLessThan(gotoAt)
  })

  it('keeps the non-vacuity and all-aborted assertions', () => {
    expect(VISUAL_SPEC).toMatch(/intercepted\.length,[\s\S]{0,400}toBeGreaterThan\(0\)/)
    expect(VISUAL_SPEC).toContain('intercepted.every((request) => request.aborted)')
    expect(VISUAL_SPEC).toContain(
      'intercepted.every((request) => request.url.startsWith(COLLECTOR_ORIGIN))',
    )
  })

  it('waits for the first attempt with bounded polling, never a fixed sleep', () => {
    // A fixed sleep always costs its full duration and does not synchronize
    // with the observed attempt. Polling waits for that condition with a bound.
    expect(VISUAL_SPEC).not.toContain('waitForTimeout')
    expect(VISUAL_SPEC).toMatch(/expect\s*\.poll\(/)
    expect(VISUAL_SPEC).toMatch(/\.poll\(\(\) => intercepted\.length,[\s\S]{0,200}?timeout: 15_000/)
  })

  it('keeps the config isolated, fresh-served and correctly documented', () => {
    // Discovery isolation: this config is the only home of the leg.
    expect(VISUAL_CONFIG).toMatch(/testDir: '\.'/)
    expect(VISUAL_CONFIG).toContain("testMatch: '**/telemetry-disclosure-theme.spec.ts'")
    expect(VISUAL_CONFIG).toMatch(/serviceWorkers: 'block'/)
    // Every preview server must be fresh-built output, never a stale one.
    expect(VISUAL_CONFIG.match(/reuseExistingServer: false/g) ?? []).toHaveLength(3)
    // Assigned configured ports, distinct from the stock set.
    expect(VISUAL_CONFIG).toContain('?? 4473')
    expect(VISUAL_CONFIG).toContain('?? 4479')
    expect(VISUAL_CONFIG).toContain('?? 4480')

    // The corrected build guidance (audit finding): package-direct build plus
    // the endpoint proof, referencing the spec section it comes from.
    expect(VISUAL_CONFIG).toContain('pnpm --filter @assay/web build')
    expect(VISUAL_CONFIG).toContain('grep -r collector.example.invalid apps/web/dist')
    expect(VISUAL_CONFIG).toContain('§6')
    // The broken recipe (export the endpoint, run the root build) must never
    // come back as guidance.
    expect(VISUAL_CONFIG).not.toMatch(/ASSAY_TELEMETRY_ENDPOINT[^\n]*pnpm build/)
  })
})
