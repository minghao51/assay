#!/usr/bin/env node
/**
 * doctor.mjs — a SAFE, OFFLINE contributor preflight for the Assay checkout.
 *
 * Usage (`pnpm run`, not bare `pnpm doctor`: pnpm 11 ships a built-in `doctor`
 * command that shadows a same-named script)
 *   pnpm run doctor            # human table; exit 0 pass/warn, 1 mandatory failure
 *   pnpm run doctor --json     # machine-readable result; same exit codes
 *   pnpm run doctor --strict   # optional e2e prerequisites become failures
 *   pnpm run doctor --help     # usage; exit 0
 *   exit 2                     # usage error (unknown option)
 *
 * What it checks (each result is `{check,status,expected,actual,help}`)
 * -------------------------------------------------------------------
 *   node              runtime major against the root `package.json` engines.node
 *                     policy (A03: `^24.0.0`); reports the exact version.
 *   pnpm              `pnpm --version` against the `packageManager` pin.
 *   node_modules      dependencies installed at the repository root.
 *   workspace-dirs    the key workspace packages exist (`apps/*`, `packages/*`).
 *   duckdb-cli        the pinned DuckDB CLI at `$DUCKDB` or `/tmp/duckdb`
 *                     (optional, e2e only).
 *   playwright        a Chromium build in the Playwright browser cache
 *                     (optional, e2e only).
 *   vscode            the `code` CLI or the offline `~/.vscode-test` cache
 *                     (optional, desktop only).
 *   build             built `dist/` output for the e2e servers (optional).
 *   port-web          configured web test port free (default 4173).
 *   port-engine       configured engine harness port free (default 4179).
 *   port-data-sources configured data-sources harness port free (default 4180).
 *                     Ports honour the SAME env overrides as
 *                     `playwright.config.ts`: ASSAY_E2E_PORT_WEB,
 *                     ASSAY_E2E_PORT_ENGINE, ASSAY_E2E_PORT_DS.
 *
 * Boundary: mandatory checks are `node`, `pnpm`, `node_modules`,
 * `workspace-dirs` (plus an invalid port override). Everything else is an
 * optional e2e/desktop prerequisite: `warn` normally, `fail` under `--strict`.
 *
 * What it NEVER does: install, download, build, format, delete, dump the
 * environment, modify configuration, inspect user datasets or launch the
 * application or a dev server. It only runs trusted version probes
 * (`pnpm --version`, `code --version`, the resolved DuckDB `--version`) with a
 * timeout, reads a fixed set of paths, and binds a loopback socket to test
 * whether a port is free. Output never contains tokens, env values, the home
 * directory or user file names; a path is reported only by the documented name
 * (`/tmp/duckdb`, `$DUCKDB`) — never by its value.
 *
 * This is a prerequisite probe, not a test run: it does not replace `pnpm test`,
 * and a green preflight is not a claim that the product is healthy.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const defaultRepoRoot = resolve(scriptDir, '..')

/** Key workspace packages every checkout must contain. */
export const KEY_WORKSPACE_DIRS = [
  'apps/cli',
  'apps/vscode',
  'apps/web',
  'packages/domain',
  'packages/engine-duckdb',
]

/** E2E servers built by `pnpm build`; the Playwright config serves these. */
export const BUILD_OUTPUTS = [
  'apps/web/dist',
  'packages/engine-duckdb/dist',
  'packages/data-sources/dist',
]

/** The three configured e2e ports, read exactly as `playwright.config.ts` reads them. */
export const TEST_PORTS = [
  { check: 'port-web', env: 'ASSAY_E2E_PORT_WEB', fallback: 4173 },
  { check: 'port-engine', env: 'ASSAY_E2E_PORT_ENGINE', fallback: 4179 },
  { check: 'port-data-sources', env: 'ASSAY_E2E_PORT_DS', fallback: 4180 },
]

const HELP = {
  node: 'Install Node 24 (see .node-version) and re-run `pnpm install` (README Quickstart).',
  pnpm: 'Use the pinned package manager: `corepack enable` (packageManager is in package.json).',
  install: 'Install the workspace: `pnpm install`.',
  workspace: 'Run doctor from the repository root of a full checkout (README Quickstart).',
  duckdb:
    'Optional (e2e): install the pinned DuckDB CLI v1.5.5 at /tmp/duckdb or set DUCKDB=/path/to/duckdb (handoff §4).',
  playwright: 'Optional (e2e): `pnpm exec playwright install chromium`.',
  vscode:
    'Optional (desktop): open the repository in VS Code; desktop verification needs xvfb-run when headless (handoff §4, apps/vscode/README.md).',
  build: 'Optional (e2e): `pnpm build` before `pnpm test:e2e`.',
  port: (port, env) =>
    `Stop the process listening on ${port}, or set ${env} to a free port (playwright.config.ts).`,
}

/**
 * Repository/environment/command seams. Tests inject a plain object with the
 * same shape; nothing here is global state.
 */
export function createDefaultDeps(repoRoot = defaultRepoRoot) {
  return {
    repoRoot,
    nodeVersion: process.versions.node,
    homeDir: homedir(),
    getEnv: (name) => process.env[name],
    readText(relPath) {
      try {
        return readFileSync(join(repoRoot, relPath), 'utf8')
      } catch {
        return null
      }
    },
    fileExists(absPath) {
      try {
        return existsSync(absPath)
      } catch {
        return false
      }
    },
    listDir(absPath) {
      try {
        return readdirSync(absPath)
      } catch {
        return null
      }
    },
    /** Trusted version probe with a hard timeout. Never throws. */
    run(command, args, { timeoutMs = 10_000 } = {}) {
      const probe = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
      })
      if (probe.error) {
        const code = probe.error.code
        if (code === 'ETIMEDOUT') return { ok: false, code: 'timeout', stdout: '', stderr: '' }
        if (code === 'ENOENT' || code === 'EACCES') {
          return { ok: false, code: 'missing', stdout: '', stderr: '' }
        }
        return { ok: false, code: 'failed', stdout: '', stderr: '' }
      }
      return {
        ok: probe.status === 0,
        code: probe.status === 0 ? 'ok' : 'failed',
        stdout: probe.stdout ?? '',
        stderr: probe.stderr ?? '',
      }
    },
    /** 'free' | 'occupied' | 'unknown' — a loopback bind, nothing is served. */
    checkPort(port, { timeoutMs = 1000 } = {}) {
      return new Promise((settle) => {
        const server = createServer()
        let timer = null
        let settled = false
        const done = (state) => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          try {
            server.close()
          } catch {
            // not listening — nothing to close
          }
          settle(state)
        }
        server.once('error', (error) => done(error?.code === 'EADDRINUSE' ? 'occupied' : 'unknown'))
        server.once('listening', () => done('free'))
        timer = setTimeout(() => done('unknown'), timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        try {
          server.listen({ port, host: '127.0.0.1', exclusive: true })
        } catch {
          done('unknown')
        }
      })
    },
  }
}

function result(check, status, expected, actual, help) {
  return { check, status, expected, actual, help }
}

/** Optional prerequisites warn unless --strict promotes them. */
function optionalStatus(ok, strict) {
  if (ok) return 'pass'
  return strict ? 'fail' : 'warn'
}

function readRootManifest(deps) {
  const text = deps.readText('package.json')
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function checkNodeRuntime(deps) {
  const manifest = readRootManifest(deps)
  const policy = typeof manifest?.engines?.node === 'string' ? manifest.engines.node : null
  const policyMajor = policy === null ? null : (/^\^?(\d+)/.exec(policy)?.[1] ?? null)
  const actualMajor = deps.nodeVersion.split('.')[0]
  const ok = policyMajor !== null && actualMajor === policyMajor
  return result(
    'node',
    ok ? 'pass' : 'fail',
    policy === null ? 'root package.json engines.node' : `Node ${policy}`,
    `v${deps.nodeVersion}`,
    HELP.node,
  )
}

function checkPnpm(deps) {
  const manifest = readRootManifest(deps)
  const manager = typeof manifest?.packageManager === 'string' ? manifest.packageManager : null
  const expectedVersion =
    manager?.startsWith('pnpm@') === true ? manager.slice('pnpm@'.length) : null
  const probe = deps.run('pnpm', ['--version'], { timeoutMs: 10_000 })
  let actual
  if (probe.code === 'missing') actual = 'pnpm not found on PATH'
  else if (probe.code === 'timeout') actual = 'pnpm --version timed out'
  else if (!probe.ok) actual = 'pnpm --version failed'
  else actual = probe.stdout.trim().split('\n')[0] || '(empty output)'
  const ok = expectedVersion !== null && actual === expectedVersion
  return result(
    'pnpm',
    ok ? 'pass' : 'fail',
    manager === null ? 'packageManager pin in package.json' : manager,
    actual,
    HELP.pnpm,
  )
}

function checkInstall(deps) {
  const present = deps.fileExists(join(deps.repoRoot, 'node_modules'))
  return result(
    'node_modules',
    present ? 'pass' : 'fail',
    'node_modules/ present at the repository root',
    present ? 'present' : 'missing',
    HELP.install,
  )
}

function checkWorkspaceDirs(deps) {
  const missing = KEY_WORKSPACE_DIRS.filter(
    (dir) => !deps.fileExists(join(deps.repoRoot, dir, 'package.json')),
  )
  return result(
    'workspace-dirs',
    missing.length === 0 ? 'pass' : 'fail',
    `key workspace packages present (${KEY_WORKSPACE_DIRS.join(', ')})`,
    missing.length === 0 ? 'all present' : `missing ${missing.join(', ')}`,
    HELP.workspace,
  )
}

function checkDuckdb(deps, strict) {
  const fromEnv = deps.getEnv('DUCKDB')
  const label = fromEnv === undefined || fromEnv === '' ? '/tmp/duckdb' : '$DUCKDB'
  const cliPath = fromEnv === undefined || fromEnv === '' ? '/tmp/duckdb' : fromEnv
  let ok = false
  let actual
  if (!deps.fileExists(cliPath)) {
    actual = `not found (${label})`
  } else {
    const probe = deps.run(cliPath, ['--version'], { timeoutMs: 5_000 })
    if (probe.code === 'missing') actual = `not executable (${label})`
    else if (probe.code === 'timeout') actual = `--version timed out (${label})`
    else if (!probe.ok) actual = `--version failed (${label})`
    else {
      const version = /v\d+\.\d+\.\d+/.exec(probe.stdout)?.[0] ?? 'unknown version'
      ok = /^v1\.5\./.test(version)
      actual = `${version} (${label})`
    }
  }
  return result(
    'duckdb-cli',
    optionalStatus(ok, strict),
    'DuckDB CLI v1.5.x at $DUCKDB or /tmp/duckdb',
    actual,
    HELP.duckdb,
  )
}

function checkPlaywright(deps, strict) {
  const override = deps.getEnv('PLAYWRIGHT_BROWSERS_PATH')
  const cacheDir =
    override === undefined || override === ''
      ? join(deps.homeDir, '.cache', 'ms-playwright')
      : override
  const entries = deps.listDir(cacheDir) ?? []
  const chromium = entries.filter((name) => /^chromium(-\d+)?$/.test(name))
  return result(
    'playwright',
    optionalStatus(chromium.length > 0, strict),
    'Chromium installed in the Playwright browser cache',
    chromium.length === 0
      ? 'no chromium build in the cache'
      : `chromium present (${chromium.length})`,
    HELP.playwright,
  )
}

function checkVsCode(deps, strict) {
  const probe = deps.run('code', ['--version'], { timeoutMs: 5_000 })
  const codeVersion =
    probe.ok && probe.stdout.trim() !== '' ? probe.stdout.trim().split('\n')[0] : null
  const cache = deps.listDir(join(deps.homeDir, '.vscode-test')) ?? []
  const offlineCache = cache.filter((name) => /^vscode-linux-x64-/.test(name)).length
  const ok = codeVersion !== null || offlineCache > 0
  const parts = []
  if (codeVersion !== null) parts.push(`code ${codeVersion}`)
  if (offlineCache > 0) parts.push('offline test cache present')
  return result(
    'vscode',
    optionalStatus(ok, strict),
    'VS Code CLI (`code`) or the offline test cache',
    parts.length === 0 ? 'neither available' : parts.join('; '),
    HELP.vscode,
  )
}

function checkBuild(deps, strict) {
  const missing = BUILD_OUTPUTS.filter((dir) => !deps.fileExists(join(deps.repoRoot, dir)))
  return result(
    'build',
    optionalStatus(missing.length === 0, strict),
    `built output present (${BUILD_OUTPUTS.join(', ')})`,
    missing.length === 0 ? 'all present' : `missing ${missing.join(', ')}`,
    HELP.build,
  )
}

async function checkTestPort(deps, strict, spec) {
  const raw = deps.getEnv(spec.env)
  const configured = raw === undefined || raw === '' ? spec.fallback : Number(raw)
  if (!Number.isInteger(configured) || configured < 1 || configured > 65535) {
    // A malformed override is a configuration fault, so it fails in both modes.
    return result(
      spec.check,
      'fail',
      `a valid port from ${spec.env} (default ${spec.fallback})`,
      `invalid value in ${spec.env}`,
      HELP.port(spec.fallback, spec.env),
    )
  }
  const state = await deps.checkPort(configured)
  return result(
    spec.check,
    optionalStatus(state === 'free', strict),
    `port ${configured} free (${spec.env} overrides ${spec.fallback})`,
    state === 'free' ? 'free' : state === 'occupied' ? 'occupied' : 'probe failed',
    HELP.port(configured, spec.env),
  )
}

/**
 * Run every check in a stable order. Returns `{ strict, checks }` with no
 * writes, no installs and no application launch.
 */
export async function runChecks(deps, { strict = false } = {}) {
  const checks = [
    checkNodeRuntime(deps),
    checkPnpm(deps),
    checkInstall(deps),
    checkWorkspaceDirs(deps),
    checkDuckdb(deps, strict),
    checkPlaywright(deps, strict),
    checkVsCode(deps, strict),
    checkBuild(deps, strict),
  ]
  for (const spec of TEST_PORTS) checks.push(await checkTestPort(deps, strict, spec))
  return { strict, checks }
}

export function exitCodeFor({ checks }) {
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}

const USAGE = `pnpm doctor — offline contributor preflight (Assay)

Usage: node scripts/doctor.mjs [--json] [--strict] [--help]

  --json     print {strict, checks:[{check,status,expected,actual,help}]}
  --strict   treat optional e2e/desktop prerequisites as failures
  --help     show this help

Exit codes: 0 pass/warn, 1 mandatory failure, 2 usage error.

Checks (expected = documented prerequisite, actual = what this host has):
  node, pnpm, node_modules, workspace-dirs   mandatory
  duckdb-cli, playwright, vscode, build      optional e2e/desktop
  port-web, port-engine, port-data-sources   optional; override with
      ASSAY_E2E_PORT_WEB / ASSAY_E2E_PORT_ENGINE / ASSAY_E2E_PORT_DS

Setup commands this preflight refers to (docs: README Quickstart, AGENTS.md
"Commands", docs/process/handoff.md §4):
  pnpm install
  corepack enable
  pnpm build
  pnpm exec playwright install chromium
  DUCKDB=/path/to/duckdb (pinned CLI v1.5.5)

doctor never installs, downloads, builds or launches anything, and a green
preflight does not replace \`pnpm test\` or claim the product is healthy.
`

export function formatHuman({ strict, checks }, stdout) {
  const width = Math.max(...checks.map((check) => check.check.length))
  stdout.write(`pnpm doctor — offline preflight${strict ? ' (--strict)' : ''}\n\n`)
  for (const check of checks) {
    const label = check.status.toUpperCase().padEnd(4)
    stdout.write(
      `${label}  ${check.check.padEnd(width)}  expected: ${check.expected}  actual: ${check.actual}\n`,
    )
    if (check.status !== 'pass') stdout.write(`${' '.repeat(6)}help: ${check.help}\n`)
  }
  const count = (status) => checks.filter((check) => check.status === status).length
  stdout.write(
    `\nSummary: ${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail.` +
      `${count('warn') > 0 ? ' Optional prerequisites warned; re-run with --strict to fail on them.' : ''}\n` +
      'Preflight only: it does not run tests and does not claim the product is healthy.\n',
  )
}

/** Parse argv; returns `{ help, json, strict }` or `{ error }`. */
export function parseDoctorArgs(argv) {
  const options = { help: false, json: false, strict: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--strict') options.strict = true
    else if (arg.startsWith('-')) return { error: `unknown option ${arg}` }
    else return { error: 'unexpected positional argument' }
  }
  return options
}

/**
 * CLI entry point. `deps` defaults to the real environment; tests pass a plain
 * object. Writes only to the given streams.
 */
export async function main(
  argv,
  deps = createDefaultDeps(),
  stdout = process.stdout,
  stderr = process.stderr,
) {
  const options = parseDoctorArgs(argv)
  if (options.error !== undefined) {
    stderr.write(`doctor: ${options.error}\n`)
    stderr.write(USAGE)
    return 2
  }
  if (options.help) {
    stdout.write(USAGE)
    return 0
  }
  const report = await runChecks(deps, { strict: options.strict })
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else formatHuman(report, stdout)
  return exitCodeFor(report)
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
