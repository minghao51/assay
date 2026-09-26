// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Argument parsing for the assay CLI (m5-4; extended by m6-3).
 *
 * Deliberately tiny and total: `--flag value` and `--flag=value` forms,
 * positionals in order, everything else a typed usage error (exit 2) with a
 * fixed, actionable message. No library dependency — the parsing rules are
 * part of the byte-pinned help text.
 *
 * m6-3 adds two flags for `assay diff`: `--key <column>` (REPEATABLE — the
 * explicit key set, in the order given) and `--infer` (a boolean; pick the
 * top inferred candidate and disclose it, checkpoint C2). Both are parsed
 * here; their command-level validation lives in `diff.ts`.
 */
import { usageError } from './errors.js'

/** Parsed flags: long names only, values as given. */
export interface CliFlags {
  readonly contract?: string
  readonly format?: string
  readonly sampleLimit?: string
  /** `--key` occurrences, in the order given (repeatable). */
  readonly keys: readonly string[]
  /** `--infer` was passed (top-candidate inference with disclosure). */
  readonly infer: boolean
  /** `--quiet` was passed: suppress progress/hints on stderr (reports stay). */
  readonly quiet: boolean
  readonly help: boolean
  readonly version: boolean
}

/** One parsed invocation: the command word, its positionals, and its flags. */
export interface CliInvocation {
  readonly command: string | undefined
  readonly positionals: readonly string[]
  readonly flags: CliFlags
}

/** The flag names the CLI understands (their value spelling is validated per command). */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  'contract',
  'format',
  'sample-limit',
  'key',
  'infer',
  'quiet',
  'help',
  'version',
])

/** The boolean flags: `--name` alone, no value consumed. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['infer', 'quiet', 'help', 'version'])

/** Parse argv (without the node/script preamble) into command + flags. */
export function parseArgs(argv: readonly string[]): CliInvocation {
  const positionals: string[] = []
  const keys: string[] = []
  let command: string | undefined
  let contract: string | undefined
  let format: string | undefined
  let sampleLimit: string | undefined
  let infer = false
  let quiet = false
  let help = false
  let version = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--') {
      // Everything after `--` is positional, verbatim (a path may start with -).
      for (const rest of argv.slice(index + 1)) {
        if (rest !== undefined) positionals.push(rest)
      }
      break
    }
    if (arg.startsWith('--')) {
      const equal = arg.indexOf('=')
      const name = equal === -1 ? arg.slice(2) : arg.slice(2, equal)
      if (!KNOWN_FLAGS.has(name)) {
        throw usageError(`unknown option '--${name}' (see --help)`)
      }
      // Boolean flags never consume a value (and a boolean spelled with `=`
      // is a caller error, not a silent truthy string).
      if (BOOLEAN_FLAGS.has(name)) {
        if (equal !== -1) {
          throw usageError(`option '--${name}' does not take a value (see --help)`)
        }
        if (name === 'infer') infer = true
        else if (name === 'quiet') quiet = true
        else if (name === 'help') help = true
        else version = true
        continue
      }
      let value: string | undefined
      if (equal === -1) {
        value = argv[index + 1]
        index += 1
      } else {
        value = arg.slice(equal + 1)
      }
      if (value === undefined || value === '') {
        throw usageError(`option '--${name}' requires a value (see --help)`)
      }
      if (name === 'contract') contract = value
      else if (name === 'format') format = value
      else if (name === 'sample-limit') sampleLimit = value
      else if (name === 'key') keys.push(value)
      continue
    }
    if (command === undefined) command = arg
    else positionals.push(arg)
  }
  return {
    command,
    positionals,
    flags: { contract, format, sampleLimit, keys, infer, quiet, help, version },
  }
}
