// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CLI-level opt-out/disclosure integration pins (design §6.1/§6.3). These run
 * the real `main` dispatch with an injected environment and sinks, but never
 * configure a reachable collector in a path that would emit — the positive
 * emission path is pinned against an injected transport in
 * `telemetry/runtime.test.ts` (no network here).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLI_DISCLOSURE_COPY } from '@assay/telemetry'
import { main } from './index.js'
import type { CliIo } from './index.js'

const tempDirs: string[] = []
function configEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'assay-t2-main-'))
  tempDirs.push(dir)
  return { ASSAY_CONFIG_DIR: dir, ...extra }
}

function capture(env: Record<string, string> = {}): {
  io: CliIo
  stdout: string[]
  stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout.push(chunk)
          return true
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk)
          return true
        },
      },
      env,
    },
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('main — disclosure never leaks into byte-pinned surfaces', () => {
  it('--help and --version never show the disclosure even with an endpoint configured', async () => {
    const env = configEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    for (const argv of [['--help'], ['--version']]) {
      const { io, stderr } = capture(env)
      await main(argv, io)
      expect(stderr.join('')).not.toContain(CLI_DISCLOSURE_COPY)
    }
  })

  it('ASSAY_NO_TELEMETRY suppresses the disclosure (and all sends)', async () => {
    const { io, stderr } = capture(
      configEnv({
        ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example',
        ASSAY_NO_TELEMETRY: '1',
      }),
    )
    await expect(main(['profile'], io)).rejects.toThrow()
    expect(stderr.join('')).not.toContain(CLI_DISCLOSURE_COPY)
  })

  it('--no-telemetry suppresses the disclosure', async () => {
    const { io, stderr } = capture(
      configEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' }),
    )
    await expect(main(['profile', '--no-telemetry'], io)).rejects.toThrow()
    expect(stderr.join('')).not.toContain(CLI_DISCLOSURE_COPY)
  })

  it('the stock build (no endpoint) is silent', async () => {
    const { io, stderr } = capture(configEnv())
    await expect(main(['profile'], io)).rejects.toThrow()
    expect(stderr.join('')).toBe('')
  })
})
