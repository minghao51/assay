#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * assay — the CLI for the Assay data workbench (D10 npm-only; compiled per ADR 0042).
 *
 * Commands (docs/product/02-mvp-scope-and-acceptance.md §2):
 *   assay validate <path> --contract <file>   (m5-4)
 *   assay diff <a> <b> (--key <column>… | --infer)  (m6-3)
 *   assay profile <path>                       (ar-5 / AR-C4)
 *   assay pipeline validate|run <file>         (p-4; PT-P queue)
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
import { parseArgs } from './args.js'
import type { CommandContext } from './context.js'
import { CliError } from './errors.js'
import type { CliExitCode } from './errors.js'
import { createProgressReporter } from './progress.js'
import { createReportStyle, shouldUseColor } from './style.js'
import type { CliEnv } from './telemetry/config.js'
import { readCliVersion } from './version.js'

const VERSION = readCliVersion()

/** The help text (byte-pinned by integration tests — edit deliberately). */
export function helpText(): string {
  return [
    `assay ${VERSION} — the local-first data workbench CLI`,
    '',
    'usage:',
    '  assay validate <path> --contract <file> [options]',
    '  assay diff <a> <b> (--key <column>… | --infer) [options]',
    '  assay profile <path> [options]',
    '  assay pipeline validate <file> [options]',
    '  assay pipeline run <file> [options]',
    '',
    'commands:',
    '  validate          validate a dataset against an assay contract',
    '  diff              compare two dataset versions (schema drift, profile',
    '                    deltas, then the key-based row diff)',
    '  profile           profile a dataset (per-column null/distinct counts,',
    '                    numeric stats and quantiles, categorical top-k)',
    '  pipeline          validate or run an Assay pipeline IR file (YAML):',
    '                    validate = DAG validation + data compile + gate',
    '                    visibility (no execution); run = execute the pipeline',
    '                    (gates + materialization) on a local in-memory',
    '                    DuckDB session and report per-node outcomes',
    '  help              show this help',
    '',
    'global options:',
    '  --quiet             suppress progress and hints on stderr; the report',
    '                      on stdout (human or JSON) is unchanged. Progress is',
    '                      written only when stderr is a terminal, so piped',
    '                      runs are already quiet.',
    '  --no-telemetry      opt out of anonymous usage metadata for this',
    '                      invocation (also available via ASSAY_NO_TELEMETRY)',
    '  --version           print the version (read from package.json)',
    '  --help              show this help',
    '',
    'validate options:',
    '  --contract <file>   contract YAML (the m5-0 format) — required',
    '  --format <fmt>      human (default) or json — the report format',
    '  --sample-limit <n>  per-rule sample bound K (default 20; the engine',
    '                      clamps the returned samples to at most 100 — the',
    '                      rule counts are always the FULL counts)',
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
    'reports schema drift, then per-column profile deltas (columns with a',
    'non-zero signal), then the key-based row diff (added / removed / changed',
    'rows) — in that aspect order — and lists any collected input issues.',
    '',
    'profile options:',
    '  --format <fmt>      human (default) or json — the report format',
    '',
    'profile opens the same parquet, csv, jsonl, and json files and reports',
    'the RAW file (base view only; no editing session). Categorical top-k',
    'lists at most 10 non-null values per column; numeric columns report',
    'min/max/mean/stddev and the p50/p90/p95/p99 quantiles.',
    '',
    'pipeline options:',
    '  --key <column>      explicit diff key set (repeatable; applied to',
    '                      every diff node, required when the pipeline has a',
    '                      diff node — keys are never inferred)',
    '  --format <fmt>      human (default) or json — the report format',
    '',
    'pipeline validate loads the pipeline IR (a total parser: malformed',
    'documents report located errors and exit 2), DAG-validates it, and',
    'compiles its data subgraph — nothing is executed and no source dataset',
    'is opened. The report also shows gate visibility: every validate/diff/',
    'publish node, its contract-binding resolution relative to the pipeline',
    'file, and its materialization mode (a missing/unparseable contract or an',
    'unbound diff key is a would-fail disclosure). pipeline run executes the',
    'pipeline node-by-node on a local in-memory DuckDB session (the same',
    'runner the web engine binds), running validate/diff/publish gates and',
    'reporting per-node materialization and gate verdicts, then listing the',
    'addressable output relations; those relations live only in the run',
    'session and end when the process exits. Source and contract paths',
    "resolve relative to the pipeline file's directory (absolute paths pass",
    'through); a source or contract that cannot be resolved is disclosed and refused — never guessed.',
    'A gate failure (validation-failed or publish-blocked) is a result, not a',
    'crash; an export/publish materialization mode this surface cannot execute',
    'is a typed refusal. Cancellation is not triggerable from the one-shot CLI.',
    '',
    'pipeline exit codes: validate — 0 valid (would run), 1 DAG/data-compile',
    'errors or gate-binding failures, 2 malformed or unreadable; run —',
    '0 completed, 1 gated/failed/refused or a DAG/compile refusal, 2 malformed,',
    'unreadable, unresolvable sources, or unresolvable contracts.',
    '',
    'output:',
    '  Human reports get ANSI color only when stdout is a terminal. NO_COLOR',
    '  (any value, including empty) disables it; FORCE_COLOR=0, false, or an',
    '  empty FORCE_COLOR disables it too, while any other FORCE_COLOR value',
    '  forces color on a terminal. Piped output is never colored, and JSON is',
    '  never colored.',
    '',
    'exit codes:',
    '  0   the command completed without a failure verdict (diff: no',
    '      differences found; validate: valid; profile: the profile was produced;',
    '      pipeline run: completed — even when a diff gate found differences)',
    '  1   differences were found (diff), or a pipeline was gated/failed/',
    '      refused (the report on stdout is the result)',
    '  2   usage, path, inference, or binding error (readable stderr; no',
    '      dataset values are ever printed to stderr)',
    '',
  ].join('\n')
}

/** The process surfaces `main` writes through (injectable in tests). */
export interface CliIo {
  readonly stdout: { write(chunk: string): unknown; readonly isTTY?: boolean | undefined }
  readonly stderr: { write(chunk: string): unknown; readonly isTTY?: boolean | undefined }
  readonly env: NodeJS.ProcessEnv
}

/** The process-backed IO the shipped entry uses. */
function processIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env }
}

/** The CLI main: dispatch, and map every failure to its exit code. */
export async function main(argv: readonly string[], io: CliIo = processIo()): Promise<CliExitCode> {
  const invocation = parseArgs(argv)
  if (invocation.flags.version) {
    io.stdout.write(`assay ${VERSION}\n`)
    return 0
  }
  if (invocation.flags.help || invocation.command === undefined || invocation.command === 'help') {
    io.stdout.write(helpText())
    return invocation.flags.help || invocation.command === 'help' ? 0 : 2
  }
  // Load the telemetry runtime lazily so `--help`/`--version` never pull in a
  // workspace package at runtime (ADR 0042: the built entry runs under plain
  // node with no TS loader).
  const { createCliTelemetry } = await import('./telemetry/runtime.js')
  const telemetry = createCliTelemetry({
    env: io.env as CliEnv,
    flagNoTelemetry: invocation.flags.noTelemetry,
    stderr: io.stderr,
  })
  // One context per run: stdout is the byte-stable report sink, human
  // styling follows the stdout TTY policy, and progress follows stderr/quiet.
  const context: CommandContext = {
    out: (text) => {
      io.stdout.write(text)
    },
    style: createReportStyle(shouldUseColor({ isTTY: io.stdout.isTTY === true, env: io.env })),
    progress: createProgressReporter({ stream: io.stderr, quiet: invocation.flags.quiet }),
    telemetry,
  }
  // The first-run disclosure (stderr only) and `app_boot` are emitted before
  // the command runs, and never for `--help`/`--version` (design §6.3).
  telemetry.start()
  try {
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
      return await runValidateCommand(options, context)
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
      return await runDiffCommand(options, context)
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
      return await runProfileCommand(options, context)
    }
    if (invocation.command === 'pipeline') {
      const { runPipelineCommand, resolvePipelineOptions } = await import('./pipeline.js')
      const options = resolvePipelineOptions({
        contract: invocation.flags.contract,
        keys: invocation.flags.keys,
        infer: invocation.flags.infer,
        sampleLimit: invocation.flags.sampleLimit,
        format: invocation.flags.format,
        positionals: invocation.positionals,
      })
      return await runPipelineCommand(options, context)
    }
    throw new CliError(2, `unknown command '${invocation.command}' (see --help)`)
  } finally {
    // Bounded exit flush (design §8.3); never blocks past the budget (R9).
    await telemetry.flush()
  }
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
