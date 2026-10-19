// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests for the q-4 CLI UX pack (spawns the compiled CLI,
 * `node --import tsx dist/index.js`, ADR 0042):
 *
 *   - `--quiet` is a global boolean that never changes the stdout report;
 *   - ANSI color is TTY-gated (`FORCE_COLOR`/`NO_COLOR` respected) and the
 *     JSON payload is never colored;
 *   - progress stays on stderr and is silent under a pipe (the unit-level
 *     policy lives in `progress.test.ts`);
 *   - `--version` reads the package manifest, and `--help` documents the
 *     global surface.
 *
 * The full JSON byte pins live in the validate/diff/profile integration
 * files; here the same payloads are re-asserted across `--quiet` and
 * `FORCE_COLOR` to prove neither touches stdout bytes.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { main, reportEntryError, workspaceResolutionDiagnostic } from './index.js'
import { CliError } from './errors.js'
import { SMALL_DIRTY_CONTRACT, SMALL_DIRTY_CSV } from './test-datasets.js'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as { version: string }
).version
const ESC = '\u001b'

interface CliRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawn the compiled CLI with a SANITIZED color environment (so the heredoc
 * assertions below are about OUR policy, not the caller's), then apply the
 * test's explicit overrides.
 */
function runCli(args: readonly string[], overrides: NodeJS.ProcessEnv = {}): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.FORCE_COLOR
  delete env.NO_COLOR
  Object.assign(env, overrides)
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'dist/index.js', ...args], {
    cwd: CLI_DIR,
    encoding: 'utf8',
    env,
  })
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

let dirty: string
let contract: string
let cleanA: string
let cleanB: string

interface FakeSink {
  readonly isTTY: boolean
  readonly chunks: string[]
  write(chunk: string): unknown
}

function fakeSink(isTTY: boolean): FakeSink {
  const chunks: string[] = []
  return {
    isTTY,
    chunks,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
  }
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-q4-'))
  dirty = join(dir, 'dirty.csv')
  contract = join(dir, 'contract.yaml')
  writeFileSync(dirty, SMALL_DIRTY_CSV)
  writeFileSync(contract, SMALL_DIRTY_CONTRACT)
  // A minimal unique-key pair for the diff legs (the dirty file repeats id 1).
  cleanA = join(dir, 'a.csv')
  cleanB = join(dir, 'b.csv')
  writeFileSync(cleanA, 'id,amount\n1,10\n2,20\n')
  writeFileSync(cleanB, 'id,amount\n1,10\n2,20\n')
})

describe('q-4 --quiet (reports unaffected, stderr unchanged)', () => {
  it('human validate report is byte-identical with --quiet; stderr stays empty', () => {
    const loud = runCli(['validate', dirty, '--contract', contract])
    const quiet = runCli(['validate', dirty, '--contract', contract, '--quiet'])
    expect(loud.exitCode).toBe(1)
    expect(quiet.exitCode).toBe(1)
    expect(quiet.stdout).toBe(loud.stdout)
    expect(quiet.stderr).toBe('')
    expect(loud.stderr).toBe('')
  })

  it('JSON validate report is byte-identical with --quiet', () => {
    const loud = runCli(['validate', dirty, '--contract', contract, '--format', 'json'])
    const quiet = runCli(['validate', dirty, '--contract', contract, '--format', 'json', '--quiet'])
    expect(quiet.stdout).toBe(loud.stdout)
  })

  it('--quiet is accepted globally (diff and profile)', () => {
    const diff = runCli(['diff', cleanA, cleanB, '--key', 'id', '--quiet'])
    expect(diff.exitCode).toBe(0)
    expect(diff.stderr).toBe('')
    const profile = runCli(['profile', dirty, '--quiet'])
    expect(profile.exitCode).toBe(0)
    expect(profile.stderr).toBe('')
  })
})

describe('q-4 TTY-aware color (none when piped; color on a TTY)', () => {
  it('piped stdout carries no ANSI escapes, even with FORCE_COLOR set (human or JSON)', () => {
    expect(runCli(['validate', dirty, '--contract', contract]).stdout).not.toContain(ESC)
    const json = runCli(['validate', dirty, '--contract', contract, '--format', 'json'])
    expect(json.stdout).not.toContain(ESC)
    expect(
      runCli(['validate', dirty, '--contract', contract], { FORCE_COLOR: '1' }).stdout,
    ).not.toContain(ESC)
  })

  it('a TTY stdout colorizes the human status words and issue counts (in-process)', async () => {
    const stdout = fakeSink(true)
    const code = await main(['validate', dirty, '--contract', contract], {
      stdout,
      stderr: fakeSink(false),
      env: {},
    })
    expect(code).toBe(1)
    const text = stdout.chunks.join('')
    expect(text).toContain(`${ESC}[31mFAIL${ESC}[0m`)
    expect(text).toContain(`${ESC}[32mPASS${ESC}[0m`)
    expect(text).toContain(`${ESC}[36m2 of 6 rows (33%)${ESC}[0m`)
    expect(text).toContain(`${ESC}[31mINVALID${ESC}[0m`)
  })

  it('NO_COLOR disables a TTY; FORCE_COLOR=0 too (in-process)', async () => {
    for (const env of [{ NO_COLOR: '1' }, { FORCE_COLOR: '0' }]) {
      const stdout = fakeSink(true)
      const code = await main(['validate', dirty, '--contract', contract], {
        stdout,
        stderr: fakeSink(false),
        env,
      })
      expect(code).toBe(1)
      expect(stdout.chunks.join('')).not.toContain(ESC)
    }
  })

  it('JSON is never colored, even on a TTY stdout (in-process)', async () => {
    const stdout = fakeSink(true)
    await main(['validate', dirty, '--contract', contract, '--format', 'json'], {
      stdout,
      stderr: fakeSink(false),
      env: {},
    })
    const text = stdout.chunks.join('')
    expect(text).not.toContain(ESC)
    expect(JSON.parse(text)).toBeTruthy()
  })
})

describe('q-4 progress stays on stderr (silent under a pipe)', () => {
  it('a full validate scan writes nothing to stderr', () => {
    const run = runCli(['validate', dirty, '--contract', contract, '--format', 'json'])
    expect(run.stderr).toBe('')
    expect(JSON.parse(run.stdout)).toBeTruthy()
  })

  it('the entry wires progress to an interactive stderr (in-process)', async () => {
    const stdout = fakeSink(false)
    const stderr = fakeSink(true)
    const code = await main(['validate', dirty, '--contract', contract], {
      stdout,
      stderr,
      env: {},
    })
    expect(code).toBe(1)
    const phases = stderr.chunks.join('')
    expect(phases).toContain('assay: opening dataset\n')
    expect(phases).toContain('assay: running validation plan\n')
    expect(phases).toContain('assay: done\n')
    // stdout stayed the report, not progress.
    expect(stdout.chunks.join('')).toContain('verdict: INVALID')
  })

  it('--quiet silences progress even on an interactive stderr (in-process)', async () => {
    const stderr = fakeSink(true)
    const code = await main(['validate', dirty, '--contract', contract, '--quiet'], {
      stdout: fakeSink(false),
      stderr,
      env: {},
    })
    expect(code).toBe(1)
    expect(stderr.chunks).toEqual([])
  })
})

describe('q-4 entry error handling through CliIo', () => {
  it('writes authored CliError text through injected stderr and preserves its exit code', () => {
    const stderr = fakeSink(false)
    const code = reportEntryError(new CliError(1, 'safe fixed error'), {
      stdout: fakeSink(false),
      stderr,
      env: {},
    })
    expect(code).toBe(1)
    expect(stderr.chunks.join('')).toBe('safe fixed error\n')
  })

  it('sanitizes unexpected errors through CliIo', () => {
    const stderr = fakeSink(false)
    const code = reportEntryError(new Error('untrusted value'), {
      stdout: fakeSink(false),
      stderr,
      env: {},
    })
    expect(code).toBe(2)
    expect(stderr.chunks.join('')).toBe('internal error (no details)\n')
  })
})

describe('gb-5 workspace dist resolution diagnostics', () => {
  const packagesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages')
  const diagnostic =
    'Running the workspace checkout dist directly is unsupported; build and pack first: `corepack pnpm build`, then `apps/cli/scripts/pack-consumer-smoke.mjs`.'

  it('recognizes an unknown-extension failure for a workspace TypeScript source path', () => {
    expect(
      workspaceResolutionDiagnostic({
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
        message: `Unknown file extension for ${join(packagesPath, 'contracts/src/index.ts')}`,
      }),
    ).toBe(diagnostic)
  })

  it('recognizes module-not-found for a path under workspace packages', () => {
    expect(
      workspaceResolutionDiagnostic({
        code: 'ERR_MODULE_NOT_FOUND',
        message: `Cannot find module ${join(packagesPath, 'contracts/dist/index.js')}`,
      }),
    ).toBe(diagnostic)
  })

  it('does not recognize unknown-extension failures outside workspace packages', () => {
    expect(
      workspaceResolutionDiagnostic({
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
        message: 'Unknown file extension /elsewhere/local/mod.ts',
      }),
    ).toBeNull()
  })

  it('does not recognize module-not-found failures outside workspace packages', () => {
    expect(
      workspaceResolutionDiagnostic({
        code: 'ERR_MODULE_NOT_FOUND',
        message: 'Cannot find module /elsewhere/lib/x.js',
      }),
    ).toBeNull()
  })

  it('leaves unrelated errors on the sanitized fallback', () => {
    expect(workspaceResolutionDiagnostic(new Error('untrusted value'))).toBeNull()
  })

  it('writes only the authored diagnostic before the sanitized fallback through CliIo', () => {
    const stderr = fakeSink(false)
    const code = reportEntryError(
      {
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
        message: `Unknown file extension for ${join(packagesPath, 'contracts/src/index.ts')}: private value`,
      },
      { stdout: fakeSink(false), stderr, env: {} },
      true,
    )
    expect(code).toBe(2)
    expect(stderr.chunks.join('')).toBe(`${diagnostic}\ninternal error (no details)\n`)
    expect(stderr.chunks.join('')).not.toContain('private value')
  })
})

describe('q-4 --version/--help as global options', () => {
  it('--version prints the package.json version (single source of truth)', () => {
    const run = runCli(['--version'])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe(`assay ${PACKAGE_VERSION}\n`)
    expect(run.stderr).toBe('')
  })

  it('--help documents every global option and the color policy', () => {
    const run = runCli(['--help'])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('global options:')
    expect(run.stdout).toContain('--quiet')
    expect(run.stdout).toContain('suppress progress on stderr')
    expect(run.stdout).not.toContain('hints on stderr')
    expect(run.stdout).toContain('--version')
    expect(run.stdout).toContain('--help')
    expect(run.stdout).toContain('NO_COLOR')
    expect(run.stdout).toContain('FORCE_COLOR')
    expect(run.stdout).toContain('non-zero signal')
  })
})
