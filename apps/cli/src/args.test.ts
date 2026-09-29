// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the CLI argument parser (q-4 adds `--quiet`; AR-C8 noted the
 * missing direct coverage). The parser is total: `--quiet` is a global
 * boolean that never consumes a value, and `--` still makes everything after
 * it a verbatim positional.
 */
import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'
import { CliError } from './errors.js'

describe('args — the total parser', () => {
  it('parses --quiet as a global boolean and keeps positionals intact', () => {
    const invocation = parseArgs(['validate', 'data.csv', '--contract', 'c.yaml', '--quiet'])
    expect(invocation.command).toBe('validate')
    expect(invocation.positionals).toEqual(['data.csv'])
    expect(invocation.flags.quiet).toBe(true)
    expect(invocation.flags.contract).toBe('c.yaml')
  })

  it('--quiet defaults false and refuses a value (it is a boolean)', () => {
    expect(parseArgs(['diff', 'a.csv', 'b.csv', '--key', 'id']).flags.quiet).toBe(false)
    expect(() => parseArgs(['--quiet=true'])).toThrow(CliError)
    // A following token is never consumed by the boolean — it stays positional.
    const invocation = parseArgs(['profile', 'data.csv', '--quiet', 'extra'])
    expect(invocation.flags.quiet).toBe(true)
    expect(invocation.positionals).toEqual(['data.csv', 'extra'])
  })

  it('-- makes the rest positional verbatim, so --quiet after it is inert', () => {
    const invocation = parseArgs(['validate', '--', '--quiet', '-weird.csv'])
    expect(invocation.positionals).toEqual(['--quiet', '-weird.csv'])
    expect(invocation.flags.quiet).toBe(false)
  })

  it('parses --no-telemetry as a global boolean and refuses a value', () => {
    expect(parseArgs(['profile', 'data.csv']).flags.noTelemetry).toBe(false)
    const invocation = parseArgs(['profile', 'data.csv', '--no-telemetry'])
    expect(invocation.flags.noTelemetry).toBe(true)
    expect(invocation.positionals).toEqual(['data.csv'])
    expect(() => parseArgs(['--no-telemetry=true'])).toThrow(CliError)
  })
})
