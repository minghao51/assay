// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Input validation/normalization for the diff model (internal — never
 * re-exported from `index.ts`).
 *
 * Every aspect function validates its inputs through here before
 * computing. All independent problems are collected as typed issues in a
 * documented order: side A before side B; within a side, array order;
 * within a column, field order (identity → kind → counts → payloads).
 * Validation never throws, over any input: field reads are guarded
 * (`guards.ts`), every expectation violation becomes an issue, and a
 * top-level unusable side (e.g. `null` where the schema array should be)
 * comes back as `null` so the caller can **skip the aspect** — the model
 * never synthesizes findings from an empty stand-in (that would fabricate
 * "column added" for every real column).
 *
 * Hygiene policy (mirrors the m5-1 compiler's schema validation): names and
 * types must be non-empty strings without NUL; such strings never occur in
 * engine output, so accepting them would only ever serve hostile callers.
 * Duplicate names are issues with first-occurrence-wins — a documented
 * divergence from m5-1's all-or-nothing schema rejection, because diff
 * findings are per-column independent: one malformed column must not erase
 * the others, and the issue carries the attribution.
 */

import type { EngineSchemaColumn } from '@assay/validation'
import {
  echoNumber,
  echoValue,
  isFiniteNumber,
  isNonNegativeSafeInteger,
  readArray,
  readField,
} from './guards.js'
import type { DiffIssue, DiffSide } from './issues.js'
import { makeIssue } from './issues.js'
import type { CategoricalTopKEntry, NumericQuantiles, ProfileColumnKind } from './profile.js'

/** The profile `kind` vocabulary (the m2 profile contract). */
const PROFILE_KINDS: ReadonlySet<string> = new Set(['numeric', 'categorical', 'other'])

/** A schema side normalized for drift computation. */
export interface ValidatedSchema {
  /** Valid entries in input order (duplicates and malformed entries excluded). */
  readonly columns: readonly EngineSchemaColumn[]
  /** By exact, case-sensitive name; first occurrence wins. */
  readonly byName: ReadonlyMap<string, EngineSchemaColumn>
}

/**
 * Validate one schema side. Returns `null` only when the side is unusable
 * at the top level (not an array) — the aspect is then skipped; entry-level
 * problems yield issues and the valid subset.
 */
export function validateSchema(
  schema: unknown,
  side: DiffSide,
  issues: DiffIssue[],
): ValidatedSchema | null {
  // Snapshot, never direct iteration: `Array.isArray` passes array Proxies
  // whose traps throw, and a mid-iteration throw would breach totality. An
  // unreadable array is handled exactly like a non-array (issue + skip).
  const entries = readArray(schema)
  if (entries === null) {
    issues.push(
      makeIssue(
        'invalid-schema-input',
        `schema must be a readable array of { name, type } columns; got ${echoValue(schema)}`,
        { side },
      ),
    )
    return null
  }
  const columns: EngineSchemaColumn[] = []
  const byName = new Map<string, EngineSchemaColumn>()
  entries.forEach((entry, index) => {
    const nameRead = readField(entry, 'name')
    const typeRead = readField(entry, 'type')
    const name = nameRead.ok ? nameRead.value : undefined
    const type = typeRead.ok ? typeRead.value : undefined
    if (typeof name !== 'string' || name === '') {
      issues.push(
        makeIssue(
          'invalid-schema-input',
          `column entry ${index} must have a non-empty string name`,
          {
            side,
          },
        ),
      )
      return
    }
    if (typeof type !== 'string' || type === '') {
      issues.push(
        makeIssue('invalid-schema-input', `column '${name}' must have a non-empty string type`, {
          side,
          column: name,
        }),
      )
      return
    }
    if (name.includes('\u0000') || type.includes('\u0000')) {
      issues.push(
        makeIssue(
          'invalid-schema-input',
          `column '${name}' carries a NUL character, which engine output never contains`,
          { side, column: name },
        ),
      )
      return
    }
    if (byName.has(name)) {
      issues.push(
        makeIssue(
          'duplicate-column-name',
          'duplicate column name; the first occurrence is kept and later ones are ignored',
          { side, column: name },
        ),
      )
      return
    }
    const column = { name, type }
    columns.push(column)
    byName.set(name, column)
  })
  return { columns, byName }
}

/** Numeric stats with every field normalized to finite-or-null (invalid → issue + null). */
export interface ValidatedNumericStats {
  readonly min: number | null
  readonly max: number | null
  readonly mean: number | null
  readonly stddev: number | null
  readonly quantiles: NumericQuantiles
}

/** A categorical top-k summary: valid entries, first-wins on duplicates. */
export interface ValidatedCategoricalStats {
  readonly topK: readonly CategoricalTopKEntry[]
}

/** One profile column normalized for delta/nullability computation. */
export interface ValidatedColumnProfile {
  readonly name: string
  readonly type: string
  readonly kind: ProfileColumnKind
  /** `null` when missing/negative/exceeding rowCount (bounds checks then degrade). */
  readonly nullCount: number | null
  readonly distinctCount: number | null
  readonly numeric: ValidatedNumericStats | null
  readonly categorical: ValidatedCategoricalStats | null
}

/** A profile side normalized for delta/nullability computation. */
export interface ValidatedProfile {
  /** `null` when malformed; row-count-dependent checks then degrade. */
  readonly rowCount: number | null
  readonly columns: readonly ValidatedColumnProfile[]
  readonly byName: ReadonlyMap<string, ValidatedColumnProfile>
}

/**
 * Validate one profile side. Returns `null` only when the side is unusable
 * at the top level (not an object, or `columns` not an array) — the aspects
 * are then skipped; column-level problems yield issues and the valid subset.
 */
export function validateProfile(
  profile: unknown,
  side: DiffSide,
  issues: DiffIssue[],
): ValidatedProfile | null {
  if (profile === null || typeof profile !== 'object') {
    issues.push(
      makeIssue('invalid-profile-input', `profile must be an object; got ${echoValue(profile)}`, {
        side,
      }),
    )
    return null
  }
  const rowCountRead = readField(profile, 'rowCount')
  const rowCount =
    rowCountRead.ok && isNonNegativeSafeInteger(rowCountRead.value) ? rowCountRead.value : null
  if (rowCount === null) {
    issues.push(
      makeIssue(
        'invalid-profile-input',
        'rowCount must be a non-negative safe integer; row-count-dependent checks are skipped and null shares are treated as unknown',
        { side },
      ),
    )
  }
  const columnsRead = readField(profile, 'columns')
  // Snapshot (see `validateSchema`): a hostile array Proxy for `columns` is
  // handled exactly like a non-array — issue + the side degrades to empty.
  const columnEntries = columnsRead.ok ? readArray(columnsRead.value) : null
  if (columnEntries === null) {
    issues.push(
      makeIssue(
        'invalid-profile-input',
        'columns must be a readable array; the side is treated as empty',
        { side },
      ),
    )
    return { rowCount, columns: [], byName: new Map() }
  }
  const columns: ValidatedColumnProfile[] = []
  const byName = new Map<string, ValidatedColumnProfile>()
  columnEntries.forEach((entry, index) => {
    const column = validateColumnProfile(entry, index, rowCount, side, issues)
    if (column === null) return
    if (byName.has(column.name)) {
      issues.push(
        makeIssue(
          'duplicate-column-name',
          'duplicate column name; the first occurrence is kept and later ones are ignored',
          { side, column: column.name },
        ),
      )
      return
    }
    columns.push(column)
    byName.set(column.name, column)
  })
  return { rowCount, columns, byName }
}

/** The non-null row count of a validated column, or `null` when not determined. */
export function nonNullCount(
  column: ValidatedColumnProfile,
  rowCount: number | null,
): number | null {
  if (rowCount === null || column.nullCount === null) return null
  return rowCount - column.nullCount
}

function validateColumnProfile(
  entry: unknown,
  index: number,
  rowCount: number | null,
  side: DiffSide,
  issues: DiffIssue[],
): ValidatedColumnProfile | null {
  const nameRead = readField(entry, 'name')
  const typeRead = readField(entry, 'type')
  const name = nameRead.ok ? nameRead.value : undefined
  const type = typeRead.ok ? typeRead.value : undefined
  if (typeof name !== 'string' || name === '') {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `column entry ${index} must have a non-empty string name`,
        { side },
      ),
    )
    return null
  }
  if (typeof type !== 'string' || type === '') {
    issues.push(
      makeIssue('invalid-column-profile', `column '${name}' must have a non-empty string type`, {
        side,
        column: name,
      }),
    )
    return null
  }
  if (name.includes('\u0000') || type.includes('\u0000')) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `column '${name}' carries a NUL character, which engine output never contains`,
        { side, column: name },
      ),
    )
    return null
  }
  const kindRead = readField(entry, 'kind')
  const kindRaw = kindRead.ok ? kindRead.value : undefined
  const kindValid = typeof kindRaw === 'string' && PROFILE_KINDS.has(kindRaw)
  if (!kindValid) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `kind must be one of 'numeric' | 'categorical' | 'other'; got ${echoValue(
          kindRaw,
        )}; treated as 'other' (fail-closed)`,
        { side, column: name },
      ),
    )
  }
  const kind: ProfileColumnKind = kindValid ? (kindRaw as ProfileColumnKind) : 'other'
  const nullCount = validateCount(entry, 'nullCount', rowCount, 'null', side, name, issues)
  const distinctCount = validateCount(
    entry,
    'distinctCount',
    rowCount,
    'distinct',
    side,
    name,
    issues,
  )
  // The non-null mass the top-k counts must fit into (unknown when the row
  // count or null count is unknown — the sum check then degrades, documented).
  const nonNull = rowCount !== null && nullCount !== null ? rowCount - nullCount : null
  return {
    name,
    type,
    kind,
    nullCount,
    distinctCount,
    numeric: validateStatsPayload(entry, kind, side, name, issues),
    categorical: validateCategoricalPayload(entry, kind, nonNull, side, name, issues),
  }
}

/**
 * A count field: safe non-negative integer, ≤ rowCount when the row count
 * is known. Invalid → issue + `null` (treated as unknown, documented).
 */
function validateCount(
  entry: unknown,
  field: 'nullCount' | 'distinctCount',
  rowCount: number | null,
  label: 'null' | 'distinct',
  side: DiffSide,
  column: string,
  issues: DiffIssue[],
): number | null {
  const read = readField(entry, field)
  if (read.ok && isNonNegativeSafeInteger(read.value)) {
    if (rowCount !== null && read.value > rowCount) {
      issues.push(
        makeIssue(
          'invalid-column-profile',
          `${label}Count ${echoNumber(read.value)} exceeds rowCount ${echoNumber(
            rowCount,
          )}; treated as unknown`,
          { side, column },
        ),
      )
      return null
    }
    return read.value
  }
  issues.push(
    makeIssue(
      'invalid-column-profile',
      `${label}Count must be a non-negative safe integer; got ${echoValue(
        read.ok ? read.value : undefined,
      )}; treated as unknown`,
      { side, column },
    ),
  )
  return null
}

/**
 * The numeric stats payload: required and readable only for `kind:
 * 'numeric'`. A payload on any other kind is an issue and is ignored (the
 * kind governs — documented). Fields are individually normalized to
 * finite-or-null; a negative stddev is impossible and rejected.
 */
function validateStatsPayload(
  entry: unknown,
  kind: ProfileColumnKind,
  side: DiffSide,
  column: string,
  issues: DiffIssue[],
): ValidatedNumericStats | null {
  const payloadRead = readField(entry, 'numeric')
  const present =
    payloadRead.ok && payloadRead.value !== null && typeof payloadRead.value === 'object'
  if (kind !== 'numeric') {
    if (present) {
      issues.push(
        makeIssue(
          'invalid-column-profile',
          `numeric stats payload present but kind is '${kind}'; the payload is ignored (the kind governs)`,
          { side, column },
        ),
      )
    }
    return null
  }
  if (!present) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `kind 'numeric' requires a numeric stats payload; the column has no numeric delta`,
        { side, column },
      ),
    )
    return null
  }
  const payload = payloadRead.ok ? payloadRead.value : undefined
  const min = finiteOrNullField(payload, 'min', side, column, issues)
  const max = finiteOrNullField(payload, 'max', side, column, issues)
  const mean = finiteOrNullField(payload, 'mean', side, column, issues)
  let stddev = finiteOrNullField(payload, 'stddev', side, column, issues)
  if (stddev !== null && stddev < 0) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `stddev must be non-negative; got ${echoNumber(stddev)}; treated as null`,
        { side, column },
      ),
    )
    stddev = null
  }
  const quantilesRead = readField(payload, 'quantiles')
  if (
    !quantilesRead.ok ||
    quantilesRead.value === null ||
    typeof quantilesRead.value !== 'object'
  ) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        'numeric stats quantiles must be an object with p50/p90/p95/p99; all quantiles treated as null',
        { side, column },
      ),
    )
  }
  const quantiles = quantilesRead.ok ? quantilesRead.value : undefined
  const readQuantile = (key: keyof NumericQuantiles): number | null =>
    finiteOrNullField(quantiles, key, side, column, issues)
  return {
    min,
    max,
    mean,
    stddev,
    quantiles: {
      p50: readQuantile('p50'),
      p90: readQuantile('p90'),
      p95: readQuantile('p95'),
      p99: readQuantile('p99'),
    },
  }
}

/**
 * The categorical stats payload: required and readable only for
 * `kind: 'categorical'`. Entries must be well-formed (string value,
 * positive safe-integer count — a top-k entry exists only because the
 * value was observed); any malformed entry makes the whole payload unusable
 * (a partially-summarized top-k would silently distort the pooled-`other`
 * mass), while duplicate values keep the first occurrence (issue, never a
 * silent merge). Counts exceeding the non-null mass are impossible and
 * reject the payload.
 */
function validateCategoricalPayload(
  entry: unknown,
  kind: ProfileColumnKind,
  nonNull: number | null,
  side: DiffSide,
  column: string,
  issues: DiffIssue[],
): ValidatedCategoricalStats | null {
  const payloadRead = readField(entry, 'categorical')
  const present =
    payloadRead.ok && payloadRead.value !== null && typeof payloadRead.value === 'object'
  if (kind !== 'categorical') {
    if (present) {
      issues.push(
        makeIssue(
          'invalid-column-profile',
          `categorical stats payload present but kind is '${kind}'; the payload is ignored (the kind governs)`,
          { side, column },
        ),
      )
    }
    return null
  }
  if (!present) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `kind 'categorical' requires a categorical stats payload; the column has no categorical delta`,
        { side, column },
      ),
    )
    return null
  }
  const payload = payloadRead.ok ? payloadRead.value : undefined
  const topKRead = readField(payload, 'topK')
  // Snapshot (see `validateSchema`): a hostile array Proxy for `topK` is
  // handled exactly like a non-array — the payload is unusable.
  const topKEntries = topKRead.ok ? readArray(topKRead.value) : null
  if (topKEntries === null) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        'categorical stats topK must be a readable array; the column has no categorical delta',
        { side, column },
      ),
    )
    return null
  }
  const topK: CategoricalTopKEntry[] = []
  const seen = new Set<string>()
  let sum = 0
  let usable = true
  topKEntries.forEach((raw, i) => {
    const valueRead = readField(raw, 'value')
    const countRead = readField(raw, 'count')
    const value = valueRead.ok ? valueRead.value : undefined
    const count = countRead.ok ? countRead.value : undefined
    if (typeof value !== 'string') {
      issues.push(
        makeIssue(
          'invalid-column-profile',
          `top-k entry ${i} must have a string value; got ${echoValue(value)}; the payload is treated as unusable`,
          { side, column },
        ),
      )
      usable = false
      return
    }
    if (!isNonNegativeSafeInteger(count) || count === 0) {
      issues.push(
        makeIssue(
          'invalid-column-profile',
          `top-k entry ${i} must have a positive safe-integer count; got ${echoValue(
            count,
          )}; the payload is treated as unusable`,
          { side, column },
        ),
      )
      usable = false
      return
    }
    if (seen.has(value)) {
      issues.push(
        makeIssue(
          'invalid-column-profile',
          'duplicate top-k value; the first occurrence is kept and later ones are ignored',
          { side, column },
        ),
      )
      return
    }
    seen.add(value)
    topK.push({ value, count })
    sum += count
  })
  if (!usable) return null
  if (nonNull !== null && sum > nonNull) {
    issues.push(
      makeIssue(
        'invalid-column-profile',
        `top-k counts sum to ${echoNumber(sum)}, exceeding the ${echoNumber(
          nonNull,
        )} non-null rows; the payload is treated as unusable`,
        { side, column },
      ),
    )
    return null
  }
  return { topK }
}

/** One finite-or-null numeric field; anything else is an issue + null. */
function finiteOrNullField(
  target: unknown,
  key: string,
  side: DiffSide,
  column: string,
  issues: DiffIssue[],
): number | null {
  const read = readField(target, key)
  if (read.ok) {
    if (read.value === null) return null
    if (isFiniteNumber(read.value)) return read.value
  }
  issues.push(
    makeIssue(
      'invalid-column-profile',
      `numeric stats field '${key}' must be a finite number or null; got ${echoValue(
        read.ok ? read.value : undefined,
      )}; treated as null`,
      { side, column },
    ),
  )
  return null
}
