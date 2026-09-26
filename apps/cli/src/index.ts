#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * assay — the Data Workbench CLI (D10 npm-only; compiled per ADR 0042).
 *
 * Commands (docs/product/02-mvp-scope-and-acceptance.md §2):
 *   assay validate <path> --contract <file>   (m5-4)
 *   assay diff <a> <b> (--key <column>… | --infer)  (m6-3)
 *   assay profile <path>                       (ar-5 / AR-C4)
 *
 * The CLI shares the same core packages as web and VS Code (ADR 0008) and
 * executes validation and row-diff plans against the raw dataset file through
 * the engine-neutral helpers in `@assay/engine-duckdb` on a
 * `@duckdb/node-api` connection (ADR 0041). The runtime entry is the `tsc`
 * output `dist/index.js` (ADR 0042) — no `tsx` at runtime; the command
 * modules are imported lazily so `--help`/`--version` never load the engine.
 */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { CliError } from './errors.js'
import type { CliExitCode } from './errors.js'
import { parseArgs } from './args.js'

const VERSION = '0.0.0'

/** The help text (byte-pinned by integration tests — edit deliberately). */
export function helpText(): string {
  return [
    `assay ${VERSION} — the local-first data workbench CLI`,
    '',
    'usage:',
    '  assay validate <path> --contract <file> [options]',
    '  assay diff <a> <b> (--key <column>… | --infer) [options]',
    '  assay profile <path> [options]',
    '',
    'commands:',
    '  validate          validate a dataset against an assay contract',
    '  diff              compare two dataset versions (schema drift, profile',
    '                    deltas, then the key-based row diff)',
    '  profile           profile a dataset (per-column null/distinct counts,',
    '                    numeric stats and quantiles, categorical top-k)',
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
    'diff options:',
    '  --key <column>      key column (repeatable; at least one is required',
    '                      unless --infer is used)',
    '  --infer             infer the key: pick the top candidate from the two',
    '                      profiles and DISCLOSE it (chosen columns + evidence);',
    '                      zero candidates is a binding error (exit 2)',
    '  --format <fmt>      human (default) or json — the report format',
    '  --sample-limit <n>  per-aspect sample bound K (default 20; the engine',
    '                      clamps the returned samples to at most 100 — the',
    '                      aspect counts are always the FULL counts)',
    '',
    'diff requires explicit keys (--key) or disclosed inference (--infer). It',
    'reports schema drift, then per-column profile deltas, then the key-based',
    'row diff (added / removed / changed rows) — in that aspect order.',
    '',
    'profile options:',
    '  --format <fmt>      human (default) or json — the report format',
    '  --version           print the version',
    '  --help              show this help',
    '',
    'profile opens the same parquet, csv, jsonl, and json files and reports',
    'the RAW file (base view only; no editing session). Categorical top-k',
    'lists at most 10 non-null values per column; numeric columns report',
    'min/max/mean/stddev and the p50/p90/p95/p99 quantiles.',
    '',
    'exit codes:',
    '  0   no differences found across the aspects that ran (validate: valid;',
    '      profile: the profile was produced)',
    '  1   differences were found (the report on stdout is the result)',
    '  2   usage, path, inference, or binding error (readable stderr; no',
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
    const { runValidateCommand, resolveValidateOptions } = await import('./validate.js')
    const options = resolveValidateOptions({
      contract: invocation.flags.contract,
      format: invocation.flags.format,
      sampleLimit: invocation.flags.sampleLimit,
      keys: invocation.flags.keys,
      infer: invocation.flags.infer,
      positionals: invocation.positionals,
    })
    return runValidateCommand(options, (text) => process.stdout.write(text))
  }
  if (invocation.command === 'diff') {
    const { runDiffCommand, resolveDiffOptions } = await import('./diff.js')
    const options = resolveDiffOptions({
      keys: invocation.flags.keys,
      infer: invocation.flags.infer,
      contract: invocation.flags.contract,
      format: invocation.flags.format,
      sampleLimit: invocation.flags.sampleLimit,
      positionals: invocation.positionals,
    })
    return runDiffCommand(options, (text) => process.stdout.write(text))
  }
  if (invocation.command === 'profile') {
    const { runProfileCommand, resolveProfileOptions } = await import('./profile.js')
    const options = resolveProfileOptions({
      contract: invocation.flags.contract,
      format: invocation.flags.format,
      sampleLimit: invocation.flags.sampleLimit,
      keys: invocation.flags.keys,
      infer: invocation.flags.infer,
      positionals: invocation.positionals,
    })
    return runProfileCommand(options, (text) => process.stdout.write(text))
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
