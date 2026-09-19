/**
 * Argument parsing for the assay CLI (m5-4).
 *
 * Deliberately tiny and total: `--flag value` and `--flag=value` forms,
 * positionals in order, everything else a typed usage error (exit 2) with a
 * fixed, actionable message. No library dependency — the surface is two
 * commands today and the parsing rules are part of the byte-pinned help text.
 */
import { usageError } from './errors'

/** Parsed flags: long names only, values as given. */
export interface CliFlags {
  readonly contract?: string
  readonly format?: string
  readonly sampleLimit?: string
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
  'help',
  'version',
])

/** Parse argv (without the node/script preamble) into command + flags. */
export function parseArgs(argv: readonly string[]): CliInvocation {
  const positionals: string[] = []
  const flags: { -readonly [K in keyof CliFlags]: CliFlags[K] } = {
    help: false,
    version: false,
  }
  let command: string | undefined
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
      let value: string | undefined
      if (equal === -1) {
        if (name === 'help') {
          flags.help = true
          continue
        }
        if (name === 'version') {
          flags.version = true
          continue
        }
        value = argv[index + 1]
        index += 1
      } else {
        value = arg.slice(equal + 1)
      }
      if (value === undefined || value === '') {
        throw usageError(`option '--${name}' requires a value (see --help)`)
      }
      if (name === 'contract') flags.contract = value
      else if (name === 'format') flags.format = value
      else if (name === 'sample-limit') flags.sampleLimit = value
      continue
    }
    if (command === undefined) command = arg
    else positionals.push(arg)
  }
  return { command, positionals, flags: flags as CliFlags }
}
