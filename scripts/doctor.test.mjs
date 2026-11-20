// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for `scripts/doctor.mjs` (A04). Every case injects the
 * environment/fs/command seams — no test touches the real host, installs
 * anything, spawns a real probe or opens a real port.
 *
 * Covered seams: missing executable, wrong version, command timeout, spaces in
 * paths, unavailable port, invalid port override, --strict promotion, the
 * stable JSON field set, usage errors (exit 2) and output privacy.
 */
import { describe, expect, it } from 'vitest'
import { main, runChecks, exitCodeFor, parseDoctorArgs } from './doctor.mjs'

const REPO = '/repo'
const HOME = '/home/tester'

function makeDeps({
  nodeVersion = '24.13.0',
  manifest = { engines: { node: '^24.0.0' }, packageManager: 'pnpm@11.26.0' },
  env = {},
  existing = [
    `${REPO}/node_modules`,
    ...['apps/cli', 'apps/vscode', 'apps/web', 'packages/domain', 'packages/engine-duckdb'].map(
      (dir) => `${REPO}/${dir}/package.json`,
    ),
    '/tmp/duckdb',
  ],
  listings = {
    [`${HOME}/.cache/ms-playwright`]: ['chromium-1243', 'ffmpeg-1011'],
    [`${HOME}/.vscode-test`]: ['vscode-linux-x64-1.130.0'],
  },
  probes = {
    'pnpm --version': { ok: true, code: 'ok', stdout: '11.26.0\n', stderr: '' },
    '/tmp/duckdb --version': { ok: true, code: 'ok', stdout: 'v1.5.5 (Variegata)\n', stderr: '' },
    'code --version': { ok: true, code: 'ok', stdout: '1.141.0\nabc\nx64\n', stderr: '' },
  },
  ports = {},
} = {}) {
  const calls = []
  const deps = {
    repoRoot: REPO,
    nodeVersion,
    homeDir: HOME,
    getEnv: (name) => env[name],
    readText: (relPath) => (relPath === 'package.json' ? JSON.stringify(manifest) : null),
    fileExists: (absPath) => existing.includes(absPath),
    listDir: (absPath) => listings[absPath] ?? null,
    run: (command, args) => {
      calls.push([command, ...args])
      const key = `${command} ${args.join(' ')}`
      return probes[key] ?? { ok: false, code: 'missing', stdout: '', stderr: '' }
    },
    checkPort: async (port) => ports[port] ?? 'free',
  }
  return { deps, calls }
}

function capture() {
  const chunks = []
  return {
    stream: {
      write(chunk) {
        chunks.push(chunk)
      },
    },
    text: () => chunks.join(''),
  }
}

function byCheck(report, name) {
  const found = report.checks.find((check) => check.check === name)
  expect(found, `check ${name} must be reported`).toBeDefined()
  return found
}

describe('doctor — baseline', () => {
  it('passes every check on a fully provisioned host and exits 0', async () => {
    const { deps } = makeDeps()
    const report = await runChecks(deps)
    expect(report.checks.map((check) => check.check)).toEqual([
      'node',
      'pnpm',
      'node_modules',
      'workspace-dirs',
      'duckdb-cli',
      'playwright',
      'vscode',
      'build',
      'port-web',
      'port-engine',
      'port-data-sources',
    ])
    expect(report.checks.filter((check) => check.status !== 'pass')).toEqual([
      // The fixture does not list dist/ output, so the optional build check warns.
      expect.objectContaining({ check: 'build', status: 'warn' }),
    ])
    expect(exitCodeFor(report)).toBe(0)
  })

  it('reports the exact runtime version and the policy it was compared with', async () => {
    const { deps } = makeDeps({ nodeVersion: '24.13.0' })
    const node = byCheck(await runChecks(deps), 'node')
    expect(node).toMatchObject({ status: 'pass', expected: 'Node ^24.0.0', actual: 'v24.13.0' })
  })
})

describe('doctor — mandatory failures', () => {
  it('fails when the runtime major leaves the policy', async () => {
    const { deps } = makeDeps({ nodeVersion: '22.11.0' })
    const report = await runChecks(deps)
    expect(byCheck(report, 'node')).toMatchObject({ status: 'fail', actual: 'v22.11.0' })
    expect(exitCodeFor(report)).toBe(1)
  })

  it('fails when the pnpm executable is missing', async () => {
    const { deps } = makeDeps({ probes: {} })
    const report = await runChecks(deps)
    expect(byCheck(report, 'pnpm')).toMatchObject({
      status: 'fail',
      expected: 'pnpm@11.26.0',
      actual: 'pnpm not found on PATH',
    })
    expect(exitCodeFor(report)).toBe(1)
  })

  it('fails when pnpm reports a different version than packageManager', async () => {
    const { deps } = makeDeps({
      probes: { 'pnpm --version': { ok: true, code: 'ok', stdout: '10.4.0\n', stderr: '' } },
    })
    expect(byCheck(await runChecks(deps), 'pnpm')).toMatchObject({
      status: 'fail',
      actual: '10.4.0',
    })
  })

  it('fails when a version probe times out', async () => {
    const { deps } = makeDeps({
      probes: { 'pnpm --version': { ok: false, code: 'timeout', stdout: '', stderr: '' } },
    })
    expect(byCheck(await runChecks(deps), 'pnpm')).toMatchObject({
      status: 'fail',
      actual: 'pnpm --version timed out',
    })
  })

  it('fails when dependencies are not installed or the checkout is partial', async () => {
    const { deps } = makeDeps({ existing: [] })
    const report = await runChecks(deps)
    expect(byCheck(report, 'node_modules')).toMatchObject({ status: 'fail', actual: 'missing' })
    const dirs = byCheck(report, 'workspace-dirs')
    expect(dirs.status).toBe('fail')
    expect(dirs.actual).toContain('apps/web')
  })
})

describe('doctor — optional prerequisites and --strict', () => {
  it('warns (exit 0) and fails under --strict when e2e prerequisites are absent', async () => {
    const { deps } = makeDeps({
      existing: [
        `${REPO}/node_modules`,
        ...['apps/cli', 'apps/vscode', 'apps/web', 'packages/domain', 'packages/engine-duckdb'].map(
          (dir) => `${REPO}/${dir}/package.json`,
        ),
      ],
      listings: {},
      probes: { 'pnpm --version': { ok: true, code: 'ok', stdout: '11.26.0\n', stderr: '' } },
    })
    const lenient = await runChecks(deps)
    for (const name of ['duckdb-cli', 'playwright', 'vscode', 'build']) {
      expect(byCheck(lenient, name).status).toBe('warn')
    }
    expect(exitCodeFor(lenient)).toBe(0)

    const strict = await runChecks(deps, { strict: true })
    expect(strict.strict).toBe(true)
    for (const name of ['duckdb-cli', 'playwright', 'vscode', 'build']) {
      expect(byCheck(strict, name).status).toBe('fail')
    }
    expect(exitCodeFor(strict)).toBe(1)
  })

  it('warns on an occupied port, fails under --strict, and honours the Playwright env names', async () => {
    const { deps } = makeDeps({
      ports: { 4173: 'occupied' },
      env: { ASSAY_E2E_PORT_ENGINE: '5555' },
    })
    const lenient = await runChecks(deps)
    expect(byCheck(lenient, 'port-web')).toMatchObject({ status: 'warn', actual: 'occupied' })
    expect(exitCodeFor(lenient)).toBe(0)
    expect(byCheck(lenient, 'port-engine')).toMatchObject({
      status: 'pass',
      expected: 'port 5555 free (ASSAY_E2E_PORT_ENGINE overrides 4179)',
    })

    const strict = await runChecks(deps, { strict: true })
    expect(byCheck(strict, 'port-web').status).toBe('fail')
    expect(byCheck(strict, 'port-web').help).toContain('ASSAY_E2E_PORT_WEB')
    expect(exitCodeFor(strict)).toBe(1)
  })

  it('warns when the port probe itself cannot decide', async () => {
    const { deps } = makeDeps({ ports: { 4173: 'unknown' } })
    expect(byCheck(await runChecks(deps), 'port-web')).toMatchObject({
      status: 'warn',
      actual: 'probe failed',
    })
  })

  it('fails on an invalid port override without echoing its value', async () => {
    const { deps } = makeDeps({ env: { ASSAY_E2E_PORT_WEB: 'not-a-port' } })
    const report = await runChecks(deps)
    const web = byCheck(report, 'port-web')
    expect(web).toMatchObject({ status: 'fail', actual: 'invalid value in ASSAY_E2E_PORT_WEB' })
    expect(exitCodeFor(report)).toBe(1)
  })
})

describe('doctor — path handling', () => {
  it('passes a DuckDB path containing spaces through as one argv element', async () => {
    const cliPath = '/tmp/duck db/duckdb'
    const { deps, calls } = makeDeps({
      env: { DUCKDB: cliPath },
      existing: [
        `${REPO}/node_modules`,
        ...['apps/cli', 'apps/vscode', 'apps/web', 'packages/domain', 'packages/engine-duckdb'].map(
          (dir) => `${REPO}/${dir}/package.json`,
        ),
        cliPath,
      ],
      probes: {
        'pnpm --version': { ok: true, code: 'ok', stdout: '11.26.0\n', stderr: '' },
        [`${cliPath} --version`]: { ok: true, code: 'ok', stdout: 'v1.5.5\n', stderr: '' },
        'code --version': { ok: true, code: 'ok', stdout: '1.141.0\n', stderr: '' },
      },
    })
    const duckdb = byCheck(await runChecks(deps), 'duckdb-cli')
    expect(duckdb).toMatchObject({ status: 'pass', actual: 'v1.5.5 ($DUCKDB)' })
    expect(calls).toContainEqual([cliPath, '--version'])
  })

  it('reports a missing DuckDB CLI by its documented name only', async () => {
    const { deps } = makeDeps({ env: { DUCKDB: '/somewhere/else/duckdb' } })
    const duckdb = byCheck(await runChecks(deps), 'duckdb-cli')
    expect(duckdb).toMatchObject({ status: 'warn', actual: 'not found ($DUCKDB)' })
    expect(duckdb.actual).not.toContain('somewhere')
  })
})

describe('doctor — interface', () => {
  it('emits stable JSON fields and no environment values', async () => {
    const secret = 'ghp_DO_NOT_PRINT_ME'
    const { deps } = makeDeps({
      env: { GITHUB_TOKEN: secret, DUCKDB: '/home/tester/private/data/dataset.parquet' },
    })
    const out = capture()
    const code = await main(['--json'], deps, out.stream, capture().stream)
    expect(code).toBe(0)
    const parsed = JSON.parse(out.text())
    expect(Object.keys(parsed)).toEqual(['strict', 'checks'])
    for (const check of parsed.checks) {
      expect(Object.keys(check)).toEqual(['check', 'status', 'expected', 'actual', 'help'])
      expect(['pass', 'warn', 'fail']).toContain(check.status)
    }
    for (const forbidden of [secret, HOME, 'dataset.parquet', 'private']) {
      expect(out.text()).not.toContain(forbidden)
    }
  })

  it('prints the documented setup command next to every non-pass check', async () => {
    const { deps } = makeDeps({ existing: [], probes: {} })
    const out = capture()
    const code = await main([], deps, out.stream, capture().stream)
    expect(code).toBe(1)
    expect(out.text()).toContain('pnpm install')
    expect(out.text()).toContain('corepack enable')
    expect(out.text()).toContain('does not claim the product is healthy')
  })

  it('returns 2 for usage errors and never echoes a positional argument', async () => {
    const { deps } = makeDeps()
    const unknown = capture()
    expect(await main(['--nope'], deps, capture().stream, unknown.stream)).toBe(2)
    expect(unknown.text()).toContain('unknown option --nope')

    const positional = capture()
    expect(await main(['secret-dataset.csv'], deps, capture().stream, positional.stream)).toBe(2)
    expect(positional.text()).not.toContain('secret-dataset.csv')
    expect(positional.text()).toContain('unexpected positional argument')
  })

  it('prints usage for --help and parses flags in any order', async () => {
    const { deps } = makeDeps()
    const out = capture()
    expect(await main(['--strict', '--help'], deps, out.stream, capture().stream)).toBe(0)
    expect(out.text()).toContain('pnpm doctor')
    expect(out.text()).toContain('pnpm exec playwright install chromium')
    expect(parseDoctorArgs(['--json', '--strict'])).toEqual({
      help: false,
      json: true,
      strict: true,
    })
    expect(parseDoctorArgs(['--bad'])).toEqual({ error: 'unknown option --bad' })
  })
})
