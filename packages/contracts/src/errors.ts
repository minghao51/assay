/**
 * Typed errors for contract parsing (m5-0).
 *
 * The parser is **total**: malformed input never throws — it produces
 * `ContractError[]`, each carrying a machine-readable `code`, an actionable
 * `message`, a `path` into the document (`columns[2].max-null-share`,
 * `dataset.min-rows`, `document` for the root), and a 1-based `line`/
 * `column` pointing at the offending YAML (the key for key errors, the
 * value for value errors, the container for missing keys).
 *
 * This mirrors the repo's never-throws degradation convention (cf. the web
 * type parser, the domain overlay fold): callers get data they can render,
 * not an exception to catch.
 */
import type { ContractV1 } from './ast'

/** Machine-readable failure classes (one switch-able vocabulary; see `ContractError`). */
export type ContractErrorCode =
  /** The document is not even parseable YAML (or hits an unsupported YAML corner — unresolved tags, alias cycles, merge keys). */
  | 'yaml-syntax'
  /** A `format` value other than 'v1' — reported instead of guessing other versions' semantics. */
  | 'unsupported-format'
  /** A required key is absent (`format`, `name`, `version`, a column's `name`). */
  | 'missing-key'
  /** A mapping key that is not valid at its location (unknown, or valid only elsewhere — the message says which). */
  | 'unknown-key'
  /** A value has the wrong YAML type for its key (string where boolean was required, a mapping where a list was required, …). */
  | 'wrong-type'
  /** A number violates its domain: non-finite, a share outside [0,1], a non-integer version, `min > max`, … */
  | 'out-of-range'
  /** A written number is not exactly representable — the parse would silently alter it (`9007199254740993` → `9007199254740992`) — or its content literal is not a plain decimal spelling whose exact value can be verified (`0x1F`). The message names the written literal only, never the rounded double. v1 carries no arbitrary-precision numbers; standard tags (`!!int`/`!!float`) are accepted, but their content passes the same gate. */
  | 'imprecise-number'
  /** The same rule key twice in one mapping, or the same column name twice. */
  | 'duplicate-key'
  /** A declared-type spelling not in CONTRACT_TYPE_VOCABULARY (alias hints are attached to the message). */
  | 'unknown-type'

/**
 * One actionable parse failure. Plain data — render it however the surface
 * wants (see `describeContractError` for the canonical one-liner).
 */
export interface ContractError {
  readonly code: ContractErrorCode
  readonly message: string
  /** Path into the document; `document` is the root, `columns[2]` a column entry, etc. */
  readonly path: string
  /** 1-based line of the offending YAML. */
  readonly line: number
  /** 1-based column (character offset within the line) of the offending YAML. */
  readonly column: number
}

/** A parse outcome. `ok` discriminates: never a raw throw. */
export type ContractParseResult =
  | { readonly ok: true; readonly contract: ContractV1 }
  | { readonly ok: false; readonly errors: readonly ContractError[] }

/**
 * Canonical one-line rendering, compiler-style and greppable:
 * `columns[0].min:3:9: max (5) must be ≥ min (10)`. The structured fields
 * remain the primary surface; this is for humans and logs.
 */
export function describeContractError(error: ContractError): string {
  return `${error.path}:${error.line}:${error.column}: ${error.message}`
}
