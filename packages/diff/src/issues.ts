/**
 * The diff input-issue taxonomy — m5-1's `BindingError` discipline applied
 * to diff inputs: plain data, a machine-readable `code`, an actionable
 * `message`, attributed to a side and (where applicable) a column. Issues
 * are *collected* — all independent input problems surface together; a
 * hostile input never aborts the report and never corrupts it silently.
 *
 * Messages echo offending values only through the exact `String()` rendering
 * (the m5-0 never-echo lesson: never a rounded or re-formatted value).
 */

/** Which input side an issue belongs to. A = reference, B = current. */
export type DiffSide = 'A' | 'B'

/** Machine-readable input-problem classes (see {@link DiffIssue}). */
export type DiffIssueCode =
  /**
   * The `diffDatasets` input itself is unusable at a key (missing or
   * unreadable field — e.g. behind a throwing getter). The aspects that
   * would consume that key are skipped *with* this issue, never synthesized
   * from an empty stand-in.
   */
  | 'invalid-input'
  /** A schema side is not an array, or one of its entries is malformed (non-object, missing/empty name or type, NUL character). */
  | 'invalid-schema-input'
  /** A profile side is not an object, or `rowCount`/`columns` is malformed. */
  | 'invalid-profile-input'
  /** One profile column is malformed (bad kind, bad counts, unusable stats payload) — attributed; other columns still compare. */
  | 'invalid-column-profile'
  /** A duplicated column name within one side; the first occurrence wins, later ones are ignored (never a silent merge). */
  | 'duplicate-column-name'

/** One input problem. Plain data; never a throw (see module doc). */
export interface DiffIssue {
  readonly code: DiffIssueCode
  readonly message: string
  /** Which input side the problem belongs to. */
  readonly side?: DiffSide
  /** The column, when the problem is attributable to one. */
  readonly column?: string
}

/** Canonical one-line rendering, compiler-style and greppable. */
export function describeDiffIssue(issue: DiffIssue): string {
  const where = issue.side === undefined ? '' : ` [side ${issue.side}]`
  const column = issue.column === undefined ? '' : ` (column '${issue.column}')`
  return `${issue.code}${where}${column}: ${issue.message}`
}

/**
 * Build an issue with keys omitted (not `undefined`-valued) so reports stay
 * JSON-stable byte-for-byte.
 */
export function makeIssue(
  code: DiffIssueCode,
  message: string,
  attribution: { side?: DiffSide; column?: string } = {},
): DiffIssue {
  return {
    code,
    message,
    ...(attribution.side !== undefined ? { side: attribution.side } : {}),
    ...(attribution.column !== undefined ? { column: attribution.column } : {}),
  }
}
