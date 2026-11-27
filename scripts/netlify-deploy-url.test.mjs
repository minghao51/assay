// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for `scripts/netlify-deploy-url.mjs` — the collector workflow's reader for
 * `netlify deploy --json` output.
 *
 * Regression-first: the first case is the EXACT shape that broke run 45992312947 on
 * 2026-11-27 — `npx` warnings on stderr, then pretty-printed multi-line JSON, with no
 * trailing newline — because that run's real log produced a green deploy reported as
 * a failure and skipped the live probe. The old `grep -a '^{' | tail -n 1` extraction
 * is asserted to fail on the same text, so the specific bug cannot come back silently.
 *
 * What is NOT asserted here: that the extracted URL serves the collector (that is the
 * workflow's `--probe` step), nor the deploy's exit status (a separate shell check).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { deployResultFromLog, lastJsonObject } from './netlify-deploy-url.mjs'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'netlify-deploy-url.mjs')

/** Run 45992312947, deploy step: `tee`d log, verbatim shape. No trailing newline. */
const REAL_RUN_LOG = [
  "npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead",
  'npm warn deprecated @opentelemetry/sdk-trace-node@2.12.0: Use @opentelemetry/sdk-trace package',
  'Deploying to production...',
  '{',
  '  "site_id": "6f1c0f7e-0000-4000-8000-000000000000",',
  '  "site_name": "assay-dataworkbench",',
  '  "deploy_id": "6b096c5af962b72365863a5a",',
  '  "deploy_url": "https://6b096c5af962b72365863a5a--assay-dataworkbench.netlify.app",',
  '  "logs": "https://app.netlify.com/projects/assay-dataworkbench/deploys/6b096c5af962b72365863a5a",',
  '  "function_logs": "https://app.netlify.com/projects/assay-dataworkbench/logs/functions",',
  '  "edge_function_logs": "https://app.netlify.com/projects/assay-dataworkbench/logs/edge-functions",',
  '  "url": "https://assay-dataworkbench.netlify.app"',
  '}',
].join('\n')

let tempDirs = []

function writeLog(text) {
  const dir = mkdtempSync(join(tmpdir(), 'assay-netlify-log-'))
  tempDirs.push(dir)
  const path = join(dir, 'netlify-deploy.log')
  writeFileSync(path, text)
  return path
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('deployResultFromLog', () => {
  it('reads the URL out of the pretty-printed multi-line JSON that broke run 45992312947', () => {
    expect(deployResultFromLog(REAL_RUN_LOG)).toEqual({
      ok: true,
      url: 'https://assay-dataworkbench.netlify.app',
      siteName: 'assay-dataworkbench',
      deployId: '6b096c5af962b72365863a5a',
    })
  })

  it('documents why the previous extraction failed on that same log', () => {
    // The old heuristic: the last line starting with `{`. Prettier-printed JSON puts
    // the opening brace alone on its own line, so this yielded a bare "{" — valid
    // input for nothing, and the reason the probe never ran.
    const captured = REAL_RUN_LOG.split('\n')
      .filter((line) => line.startsWith('{'))
      .at(-1)
    expect(captured).toBe('{')
    expect(() => JSON.parse(captured)).toThrow()
    // The new reader gets the same text right.
    expect(deployResultFromLog(REAL_RUN_LOG).ok).toBe(true)
  })

  it('reads compact single-line JSON', () => {
    const log = 'Deploying…\n{"site_name":"s","url":"https://compact.example"}\n'
    expect(deployResultFromLog(log)).toMatchObject({ ok: true, url: 'https://compact.example' })
  })

  it('does not truncate at a nested object', () => {
    const log = [
      '{',
      '  "site_name": "s",',
      '  "build_settings": {',
      '    "dir": "dist"',
      '  },',
      '  "url": "https://nested.example"',
      '}',
    ].join('\n')
    expect(deployResultFromLog(log)).toMatchObject({ ok: true, url: 'https://nested.example' })
  })

  it('takes the last document when the log holds more than one', () => {
    const log = '{"url":"https://stale.example"}\n{"url":"https://final.example"}\n'
    expect(deployResultFromLog(log)).toMatchObject({ ok: true, url: 'https://final.example' })
  })

  it('ignores braces inside JSON strings', () => {
    const log = '{"message":"deploy {not a block} ok","url":"https://braces.example"}'
    expect(deployResultFromLog(log)).toMatchObject({ ok: true, url: 'https://braces.example' })
  })

  it('recovers the payload after an unbalanced brace in human noise', () => {
    const log = 'warning: unmatched { in build output\n{"url":"https://recovered.example"}\n'
    expect(deployResultFromLog(log)).toMatchObject({ ok: true, url: 'https://recovered.example' })
  })

  it('reports no-object when the CLI printed no JSON at all', () => {
    const result = deployResultFromLog('Error: Could not find the site\n')
    expect(result).toMatchObject({ ok: false, reason: 'no-object' })
  })

  it('reports unparsable when a brace block is not JSON', () => {
    const result = deployResultFromLog('building {\nnot json\n}\n')
    expect(result).toMatchObject({ ok: false, reason: 'unparsable' })
  })

  it('names the keys it did get when url is absent', () => {
    const result = deployResultFromLog('{\n "site_name": "s",\n "error": "nope"\n}\n')
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'missing-url' })
    expect(result.detail).toContain('error, site_name')
  })

  it('rejects a url that is not an absolute http(s) URL', () => {
    // The value becomes a probe target and a step summary, so a degenerate shape is
    // refused rather than interpolated.
    for (const url of ['not-a-url', '/.netlify/functions/collect', 'file:///etc/passwd']) {
      const result = deployResultFromLog(`{"url":${JSON.stringify(url)}}`)
      expect(result).toMatchObject({ ok: false, reason: 'invalid-url' })
    }
  })

  it('rejects a non-string url', () => {
    expect(deployResultFromLog('{"url":42}')).toMatchObject({ ok: false, reason: 'missing-url' })
  })

  it('tolerates a missing site_name / deploy_id (only url is required)', () => {
    expect(deployResultFromLog('{"url":"https://only-url.example"}')).toEqual({
      ok: true,
      url: 'https://only-url.example',
      siteName: '',
      deployId: '',
    })
  })
})

describe('lastJsonObject', () => {
  it('returns null for text with no JSON object', () => {
    expect(lastJsonObject('nothing here')).toBeNull()
  })

  it('returns the object itself, not a wrapper', () => {
    expect(lastJsonObject('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('CLI', () => {
  it('prints tab-separated fields and exits 0 for the real log shape', () => {
    const log = writeLog(REAL_RUN_LOG)
    const run = spawnSync(process.execPath, [scriptPath, log], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      'https://assay-dataworkbench.netlify.app\tassay-dataworkbench\t6b096c5af962b72365863a5a\n',
    )
  })

  it('exits 1 with the reason on stderr when there is no URL', () => {
    const log = writeLog('Error: Could not find the site\n')
    const run = spawnSync(process.execPath, [scriptPath, log], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('no-object')
  })

  it('exits 2 on a missing argument and on an unreadable path', () => {
    expect(spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' }).status).toBe(2)
    const missing = spawnSync(
      process.execPath,
      [scriptPath, join(tmpdir(), 'nope-does-not-exist.log')],
      {
        encoding: 'utf8',
      },
    )
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('cannot read')
  })

  it('reads several paths in order, so stdout and stderr can both be passed', () => {
    // The workflow passes the stderr log first and the stdout payload second; the
    // last parsable object in the concatenation wins, so it does not matter which
    // stream actually carried the JSON.
    const stderrLog = writeLog('npm warn deprecated something\nDeploying to production...\n')
    const stdoutPayload = writeLog(REAL_RUN_LOG.slice(REAL_RUN_LOG.indexOf('{')))
    const run = spawnSync(process.execPath, [scriptPath, stderrLog, stdoutPayload], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout.split('\t')[0]).toBe('https://assay-dataworkbench.netlify.app')

    // Reversed order still resolves, and a path that carries the JSON alone suffices.
    const reversed = spawnSync(process.execPath, [scriptPath, stdoutPayload, stderrLog], {
      encoding: 'utf8',
    })
    expect(reversed.status).toBe(0)
    expect(reversed.stdout.split('\t')[0]).toBe('https://assay-dataworkbench.netlify.app')
  })
})
