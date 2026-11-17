// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The closed CSV interpretation vocabulary — validation and SQL composition
 * (EW-03I engine/protocol slice; ADR 0049 items 2–3 and 6, EW-03D §2.1–§2.3).
 *
 * CSV options travel as ONE typed, closed-vocabulary object on exactly two
 * request shapes: `engine/csv-preview` (the non-adopting review) and an
 * optional options field on `engine/open` (adoption of an already-reviewed
 * set). This module is the single source of truth for that vocabulary, and it
 * is composed into the engine package beside `format-view.ts` so the web
 * surface imports it rather than duplicating it (ADR 0049 item 2).
 *
 * Validation runs TWICE — in the client before the request is sent, and again
 * in the worker before any engine touch — because the main thread is
 * untrusted. `parseCsvOptions` is the one total function both passes run: an
 * unknown or out-of-vocabulary key is refused with a typed reason instead of
 * reaching DuckDB and failing opaquely (EW-03D §6.1: engine option-refusal
 * text is not reliably classifiable, so refusal is a host decision).
 *
 * Composition rules (EW-03D §2.2, adopted verbatim by ADR 0049 item 3):
 *
 * 1. Identifiers are engine-generated only, quoted via `quotedIdentifier`;
 *    the registered file name enters SQL as a string literal.
 * 2. Every string value is quoted via `sqlStringLiteral` — a hostile value
 *    stays inside its literal.
 * 3. Option names come from the closed vocabulary below, never from user
 *    input.
 * 4. Type expressions (in `columns`/`types` maps) pass
 *    `validateEngineTypeExpression` — in both validation passes.
 * 5. Map literals compose with string-literal keys AND string-literal values
 *    (a declared type is a string DuckDB parses; the validator is defense in
 *    depth, not the quoting).
 * 6. `sniff_csv`'s `Prompt` is display evidence only — NOTHING in this module
 *    or its callers executes it; it is transported verbatim as copyable text.
 *
 * The `sample_size` option is preview-only: it governs inference only, it is
 * disclosed in the preview's effective option set, and it is REFUSED on
 * `engine/open` (ADR 0049 item 1: "the preview-only `sample_size` never rides
 * `engine/open`").
 *
 * Honesty rules carried from the contract, enforced here by refusal:
 * no silent row-skip (`ignore_errors`/`store_rejects` are refused always —
 * probe M3: 119,999 of 120,000 rows with no error; probe M8: two user tables
 * holding raw CSV lines), no locale inference (`decimal_separator`/
 * `thousands` are deferred and may only ever become explicit user settings),
 * and a sample is never a check (nothing in the preview payload may claim
 * validation — the executor states the row cap, never a verdict).
 *
 * Preview workload budget (ADR 0049 acceptance resolution 8 — the runtime row
 * sets the number): registration is lazy (the acquisition probe read no
 * bytes; a 5 MB candidate registered in 0.2–0.3 ms), the returned sample is
 * bounded by the executor's row cap, so the one unbounded workload knob is
 * the sniffer's inference read. The contract §6.3 measured a 200k-row/4.2 MB
 * full typed evaluation at ≈111 ms; this row sets the inference budget to
 * half of that ({@link MAX_CSV_INFERENCE_SAMPLE_ROWS}, ≈5× DuckDB's own
 * 20480 default) — well under the measured corner. `sample_size = -1` (read
 * every row) is REFUSED, never silently capped: an explicit user value is
 * not reinterpreted. Over-budget requests are refused before registration or
 * any SQL.
 */

import { quotedIdentifier, sqlStringLiteral } from './format-view.js'
import { validateEngineTypeExpression } from './type-expr.js'

/** The context a CSV option set is validated for. */
export type CsvOptionsContext = 'open' | 'preview'

/**
 * The canonical, validated CSV option set. Aliases are resolved by
 * {@link parseCsvOptions} (`sep` → `delim`; `types` stays `types`? — no: a
 * `types` map is canonicalized to `columns`, and setting both is refused as
 * ambiguous). Only options actually set by the caller appear; the composer
 * renders exactly these, in the canonical order below.
 */
export interface EngineCsvOptions {
  /** First line is the header row. */
  header?: boolean
  /** Field delimiter (the vocabulary's `sep` alias resolves here). */
  delim?: string
  /** Quote character ('' disables quoting). */
  quote?: string
  /** Escape character inside quoted fields ('' disables escaping). */
  escape?: string
  /** Declared column names and types (the vocabulary's `types` alias resolves here). */
  columns?: Record<string, string>
  /** Read every column as VARCHAR — the lexeme-preserving mode. */
  all_varchar?: boolean
  /** The string that reads as NULL. */
  nullstr?: string
  /** Explicit date format for DATE/TIME parsing (no locale inference). */
  dateformat?: string
  /** Line comment prefix ('' disables comments). */
  comment?: string
  /** Leading lines to skip. */
  skip?: number
  /**
   * Sniffer sample size for type inference (−1 = all rows). Preview-only:
   * refused on `engine/open`, disclosed in the preview's effective options.
   */
  sample_size?: number
}

/** The raw wire shape a request may carry (aliases still unresolved). */
export type EngineCsvOptionsInput = Record<string, unknown>

/** The effective option set a preview discloses: what was actually composed. */
export interface EngineCsvEffectiveOptions {
  header?: boolean
  delim?: string
  quote?: string
  escape?: string
  columns?: Record<string, string>
  all_varchar?: boolean
  nullstr?: string
  dateformat?: string
  comment?: string
  skip?: number
  sample_size?: number
}

/** Result of the total options parse: the canonical set or a typed reason. */
export type CsvOptionsParseResult =
  | { readonly ok: true; readonly options: EngineCsvOptions }
  | { readonly ok: false; readonly reason: string }

/**
 * The closed vocabulary of ACCEPTED option keys, with the canonical key each
 * alias resolves to. `delim` accepts `sep`; `columns` accepts `types` — each
 * pair means the same option, and setting both spellings at once is refused
 * as ambiguous rather than silently picking one.
 */
const CANONICAL_KEYS: ReadonlySet<string> = new Set([
  'header',
  'delim',
  'quote',
  'escape',
  'columns',
  'all_varchar',
  'nullstr',
  'dateformat',
  'comment',
  'skip',
])

/** Accepted aliases: wire key → canonical key. */
const ALIASES: Readonly<Record<string, string>> = {
  sep: 'delim',
  types: 'columns',
}

/**
 * DEFERRED keys (ADR 0049 item 2): accepted by the installed build but each
 * changes parse semantics without a separate decision. The last two are the
 * locale-shaped pair — they may only ever become explicit user settings,
 * never inferred (carried no-locale-inference rule).
 */
const DEFERRED_KEYS: ReadonlySet<string> = new Set([
  'strict_mode',
  'null_padding',
  'parallel',
  'encoding',
  'compression',
  'max_line_size',
  'buffer_size',
  'decimal_separator',
  'thousands',
])

/**
 * REFUSED-ALWAYS keys (EW-03D §2.3, on probe evidence): `ignore_errors`
 * silently drops rows (M3); `store_rejects`/`rejects_*` manufacture user
 * tables holding raw CSV lines (M8, ADR 0025); `delimiter`/`separator` are
 * not parameters of this build (B4/L7); the rest change naming, multi-file or
 * sniff-control semantics outside the reviewed scope. Any key in none of the
 * sets above is refused as unknown.
 */
const REFUSED_KEYS: ReadonlySet<string> = new Set([
  'ignore_errors',
  'store_rejects',
  'rejects_scan',
  'rejects_table',
  'rejects_limit',
  'delimiter',
  'separator',
  'filename',
  'union_by_name',
  'hive_partitioning',
  'hive_types',
  'hive_types_autocast',
  'files_to_sniff',
  'column_names',
  'names',
  'normalize_names',
  'force_match',
  'auto_detect',
  'auto_type_candidates',
])

/** The canonical composition order of the option arguments (deterministic SQL). */
const CANONICAL_ORDER: readonly string[] = [
  'header',
  'delim',
  'quote',
  'escape',
  'columns',
  'all_varchar',
  'nullstr',
  'dateformat',
  'comment',
  'skip',
  'sample_size',
]

/** Upper bound for one string option value (code points) — bounds the composed SQL. */
export const MAX_CSV_OPTION_VALUE_CODE_POINTS = 64

/** Upper bound for declared columns in one option set. */
export const MAX_CSV_TYPE_COLUMNS = 4096

/**
 * The preview inference budget (rows the sniffer may read for one preview;
 * ADR 0049 acceptance resolution 8 — this runtime row sets the number).
 * Rationale in the module header: half the contract §6.3 measured corner
 * (200k rows ≈ 111 ms full typed evaluation), ≈5× DuckDB's own 20480 default.
 * `sample_size = -1` (all rows) is refused, never silently capped.
 */
export const MAX_CSV_INFERENCE_SAMPLE_ROWS = 100_000

/**
 * Total boundary validator for one CSV option set (the vocabulary, value
 * shapes, alias conflicts and the context rule all in one place, so the
 * client pass and the worker pass cannot drift). Returns the canonical
 * options (fresh objects — the boundary is untrusted, so no reference into
 * the caller's data is retained) or a value-free reason naming the offending
 * option KEY (configuration, not dataset content — never the value).
 */
export function parseCsvOptions(input: unknown, context: CsvOptionsContext): CsvOptionsParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'CSV options must be an object' }
  }
  const raw = input as Record<string, unknown>
  const canonical: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = ALIASES[key] ?? key
    if (name !== key && Object.prototype.hasOwnProperty.call(raw, name)) {
      return {
        ok: false,
        reason: `CSV options ${displayName(key)} and ${displayName(name)} cannot both be set`,
      }
    }
    if (name === 'sample_size') {
      // Preview-only (ADR 0049 item 1): inference input, never an open option.
      if (context === 'open') {
        return {
          ok: false,
          reason: 'sample_size is a preview-only option and cannot ride engine/open',
        }
      }
    } else if (!CANONICAL_KEYS.has(name)) {
      if (DEFERRED_KEYS.has(name)) {
        return {
          ok: false,
          reason: `CSV option ${displayName(name)} is deferred and cannot be set yet (ADR 0049)`,
        }
      }
      if (REFUSED_KEYS.has(name)) {
        return { ok: false, reason: `refused CSV option: ${displayName(name)}` }
      }
      return { ok: false, reason: `unsupported CSV option: ${displayName(name)}` }
    }
    if (Object.prototype.hasOwnProperty.call(canonical, name)) {
      // The same canonical key reached twice via aliases is handled above;
      // object keys cannot repeat, so this is unreachable — kept as a guard.
      return {
        ok: false,
        reason: `CSV options ${displayName(name)} cannot be set twice`,
      }
    }
    canonical[name] = value
  }
  const options: EngineCsvOptions = {}
  for (const name of CANONICAL_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(canonical, name)) continue
    const value = canonical[name]
    switch (name) {
      case 'header':
      case 'all_varchar': {
        if (typeof value !== 'boolean') {
          return { ok: false, reason: `CSV option ${name} must be a boolean` }
        }
        options[name] = value
        break
      }
      case 'delim':
      case 'quote':
      case 'escape':
      case 'nullstr':
      case 'dateformat':
      case 'comment': {
        if (typeof value !== 'string' || value.length > MAX_CSV_OPTION_VALUE_CODE_POINTS) {
          return {
            ok: false,
            reason: `CSV option ${name} must be a string of at most ${MAX_CSV_OPTION_VALUE_CODE_POINTS} code points`,
          }
        }
        options[name] = value
        break
      }
      case 'skip': {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          return { ok: false, reason: 'CSV option skip must be a non-negative safe integer' }
        }
        options.skip = value
        break
      }
      case 'sample_size': {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          return {
            ok: false,
            reason:
              value === -1
                ? `CSV option sample_size = -1 reads every row for inference and is refused: the preview inference budget is ${MAX_CSV_INFERENCE_SAMPLE_ROWS} rows`
                : 'CSV option sample_size must be a non-negative safe integer',
          }
        }
        if (value > MAX_CSV_INFERENCE_SAMPLE_ROWS) {
          return {
            ok: false,
            reason: `CSV option sample_size exceeds the preview inference budget (limit ${MAX_CSV_INFERENCE_SAMPLE_ROWS} rows)`,
          }
        }
        options.sample_size = value
        break
      }
      case 'columns': {
        const parsed = parseTypeMap(value, name)
        if (!parsed.ok) return parsed
        options.columns = parsed.columns
        break
      }
      default: {
        // Unreachable: every name in CANONICAL_ORDER has a case above.
        throw new Error(`CSV option ${displayName(name)} has no validator`)
      }
    }
  }
  return { ok: true, options }
}

/** Parse a declared-columns map: string keys, validated engine type values. */
function parseTypeMap(
  value: unknown,
  name: 'columns',
): { ok: true; columns: Record<string, string> } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: `CSV option ${name} must be an object mapping column names to engine type strings`,
    }
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return { ok: false, reason: `CSV option ${name} must declare at least one column` }
  }
  if (entries.length > MAX_CSV_TYPE_COLUMNS) {
    return {
      ok: false,
      reason: `CSV option ${name} declares too many columns (limit ${MAX_CSV_TYPE_COLUMNS})`,
    }
  }
  const columns: Record<string, string> = {}
  for (const [columnName, typeValue] of entries) {
    if (typeof columnName !== 'string' || columnName.length > MAX_CSV_OPTION_VALUE_CODE_POINTS) {
      return {
        ok: false,
        reason: `CSV option ${name} keys must be column names of at most ${MAX_CSV_OPTION_VALUE_CODE_POINTS} code points`,
      }
    }
    if (typeof typeValue !== 'string') {
      return { ok: false, reason: `CSV option ${name}.${displayName(columnName)} must be a string` }
    }
    // EW-03D §2.2 rule 4: every type value passes the strict type-expression
    // validator — in this (worker) pass and again wherever the host validates.
    try {
      validateEngineTypeExpression(typeValue)
    } catch {
      return {
        ok: false,
        reason: `CSV option ${name}.${displayName(columnName)} is not a valid engine type expression`,
      }
    }
    columns[columnName] = typeValue
  }
  return { ok: true, columns }
}

/** A key may be echoed in a refusal (configuration, never a value) — bounded. */
function displayName(key: string): string {
  return key.length <= MAX_CSV_OPTION_VALUE_CODE_POINTS ? key : '(key withheld)'
}

/** The option arguments fragment, e.g. `header = true, delim = ';'`. */
function csvOptionArgsSql(options: EngineCsvOptions, include: (name: string) => boolean): string[] {
  const args: string[] = []
  for (const name of CANONICAL_ORDER) {
    if (!include(name)) continue
    const value = (options as Record<string, unknown>)[name]
    if (value === undefined) continue
    if (typeof value === 'boolean' || typeof value === 'number') {
      // Booleans and numbers are pre-validated safe shapes; rendered as literals.
      args.push(`${name} = ${String(value)}`)
    } else if (name === 'columns' && typeof value === 'object' && value !== null) {
      const map = value as Record<string, string>
      const entries = Object.entries(map)
        .map(
          ([columnName, typeValue]) =>
            `${sqlStringLiteral(columnName)}: ${sqlStringLiteral(typeValue)}`,
        )
        .join(', ')
      args.push(`${name} = {${entries}}`)
    } else if (typeof value === 'string') {
      args.push(`${name} = ${sqlStringLiteral(value)}`)
    }
  }
  return args
}

/**
 * The options-aware CSV scan relation: `read_csv('<registered name>', …)` —
 * composed only from the engine-generated file name (as a string literal),
 * the closed option names, and literal-quoted values (EW-03D §2.2 rules 1–5).
 * An empty option set composes the exact bare `read_csv('<name>')` the quick
 * open has always issued.
 */
export function csvScanRelationSql(registeredFileName: string, options: EngineCsvOptions): string {
  const args = csvOptionArgsSql(options, () => true)
  const file = sqlStringLiteral(registeredFileName)
  return args.length === 0 ? `read_csv(${file})` : `read_csv(${file}, ${args.join(', ')})`
}

/**
 * A bounded preview sample over the scan: `SELECT * FROM <scan> LIMIT <n>`.
 * The cap is stated in the response — the sample is a sample, never a check
 * (ADR 0049 item 6).
 */
export function csvSampleSql(
  registeredFileName: string,
  options: EngineCsvOptions,
  rowCap: number,
): string {
  if (!Number.isSafeInteger(rowCap) || rowCap < 1) {
    throw new Error('csv sample rowCap must be a safe integer of at least 1')
  }
  return `SELECT * FROM ${csvScanRelationSql(registeredFileName, options)} LIMIT ${rowCap}`
}

/**
 * The sniff disclosure query: `SELECT * FROM sniff_csv('<name>', …)`. It
 * receives the same options as the scan EXCEPT the declared-columns map:
 * `columns` is a declaration, not an inference input, so the sniff payload
 * stays the sniffer's own evidence (the effective option set discloses the
 * declarations separately). `sample_size` DOES ride the sniff — it governs
 * inference, which is exactly what the sniffer does.
 */
export function csvSniffSql(registeredFileName: string, options: EngineCsvOptions): string {
  const args = csvOptionArgsSql(options, (name) => name !== 'columns')
  const file = sqlStringLiteral(registeredFileName)
  return args.length === 0
    ? `SELECT * FROM sniff_csv(${file})`
    : `SELECT * FROM sniff_csv(${file}, ${args.join(', ')})`
}

/**
 * The options-aware open view: binds the composed scan to the engine-
 * generated session view name (identifiers quoted, scan composed per the
 * rules above). The no-options open path keeps using `format-view.ts`'s
 * `createViewSql` byte-identically; this variant exists only for the
 * options-carrying adoption.
 */
export function csvCreateViewSql(
  viewName: string,
  registeredFileName: string,
  options: EngineCsvOptions,
): string {
  return `CREATE VIEW ${quotedIdentifier(viewName)} AS SELECT * FROM ${csvScanRelationSql(registeredFileName, options)}`
}

/**
 * The effective option set a preview discloses: exactly what was composed,
 * canonically ordered, JSON-able (deep-copied — the response must not alias
 * the caller's maps). Disclosure only: nothing here may read as a verdict
 * about the data (a sample is never a check).
 */
export function effectiveCsvOptions(options: EngineCsvOptions): EngineCsvEffectiveOptions {
  const effective: EngineCsvEffectiveOptions = {}
  for (const name of CANONICAL_ORDER) {
    const value = (options as Record<string, unknown>)[name]
    if (value === undefined) continue
    if (name === 'columns' && typeof value === 'object' && value !== null) {
      effective.columns = { ...(value as Record<string, string>) }
    } else if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      ;(effective as Record<string, unknown>)[name] = value
    }
  }
  return effective
}
