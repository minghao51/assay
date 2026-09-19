#!/usr/bin/env -S node --import tsx
/**
 * assay — the Data Workbench CLI (pre-MVP, tsx-run; D10 default npm-only).
 *
 * Commands (docs/product/07-mvp-scope-and-acceptance.md §2):
 *   assay validate <path> --contract <file>   (m5-4)
 *
 * Planned commands: `assay profile <path>`, `assay diff <base> <candidate>`.
 * The CLI shares the same core packages as web and VS Code (ADR 0008) and
 * executes the m5-1 validation plan against the raw dataset file through the
 * engine-neutral helpers in `@assay/engine-duckdb` on a `@duckdb/node-api`
 * connection (the m5-4 backend spike's recommendation; ADR draft in the task
 * report — the orchestrator authors the ADR).
 */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { CliError } from './errors'
import type { CliExitCode } from './errors'
import { parseArgs } from './args'
import { runValidateCommand, resolveValidateOptions } from './validate'

const VERSION = '0.0.0'

/** The help text (byte-pinned by integration tests — edit deliberately). */
export function helpText(): string {
  return [
    `assay ${VERSION} — the local-first data workbench CLI`,
    '',
    'usage:',
    '  assay validate <path> --contract <file> [options]',
    '',
    'commands:',
    '  validate          validate a dataset against an assay contract',
    '  help              show this help',
    '',
    'validate options:',
    '  --contract <file>   contract YAML (the m5-0 format) — required',
    '  --format <fmt>      human (default) or json — the report format',
    '  --sample-limit <n>  per-rule sample bound K (default 20; the engine',
    '                      clamps the returned samples to at most 100 — the',
    '                      rule counts are always the FULL counts)',
    '  --version           print the version',
    '  --help              show this help',
    '',
    'validate opens parquet, csv, jsonl, and json files. It validates the RAW',
    'dataset file — the base view: a CLI run has no editing session, so the',
    'report says baseViewOnly: true and stale: false in --format json.',
    '',
    'exit codes:',
    '  0   the dataset is valid (0 violations)',
    '  1   violations were found (the report on stdout is the result)',
    '  2   usage, contract, path, or execution error (readable stderr; no',
    '      dataset values are ever printed to stderr)',
    '',
  ].join('\n')
}

/** The CLI main: dispatch, and map every failure to its exit code. */
export async function main(argv: readonly string[]): Promise<CliExitCode> {
  const invocation = parseArgs(argv)
  if (invocation.flags.version) {
    process.stdout.write(`assay ${VERSION}\n`)
    return 0
  }
  if (invocation.flags.help || invocation.command === undefined || invocation.command === 'help') {
    process.stdout.write(helpText())
    return invocation.flags.help || invocation.command === 'help' ? 0 : 2
  }
  if (invocation.command === 'validate') {
    const options = resolveValidateOptions({
      contract: invocation.flags.contract,
      format: invocation.flags.format,
      sampleLimit: invocation.flags.sampleLimit,
      positionals: invocation.positionals,
    })
    return runValidateCommand(options, (text) => process.stdout.write(text))
  }
  throw new CliError(2, `unknown command '${invocation.command}' (see --help)`)
}

/**
 * True when this module IS the process entry (the `assay` bin, a symlink to
 * this file, resolves to it): guards against side effects when a test or
 * tool imports the module.
 */
function isEntryModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isEntryModule()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      if (error instanceof CliError) {
        process.stderr.write(error.message + '\n')
        process.exitCode = error.exitCode
      } else {
        // Untrusted error text is never echoed (ADR 0025 discipline): an
        // unexpected exception's message could embed dataset content.
        process.stderr.write('internal error (no details)\n')
        process.exitCode = 2
      }
    },
  )
}
