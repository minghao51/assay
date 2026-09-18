/**
 * Column-operation client validation (m4-4) — the honest, testable boundary
 * between the column-affordance UI (rename/cast) and the domain's edit ops.
 *
 * Two rules, spelled out because "validate the cast type" is easy to
 * over-promise:
 *
 * 1. **Rename**: a column name is a quoted identifier, so almost any
 *    non-empty string is a legal name; the only client-side guarantee is
 *    "not empty" (the domain would happily fold `"x" → ""` because `""` is
 *    not a colliding name — an empty column name is a lie the UI must never
 *    create). Collisions are *not* pre-checked here: the domain owns the
 *    effective schema and yields a typed `rename-collision` conflict, which
 *    the app surfaces via `editOutcomeMessage` and leaves state unchanged.
 *    Reproducing the collision check client-side would be a second, drifting
 *    source of truth.
 * 2. **Cast**: a target type is untrusted input that the engine interpolates
 *    into a SQL type position, so every spelling is validated with the
 *    engine's own exported validator (`validateEngineTypeExpression`) before
 *    an op is composed. A structurally invalid spelling is refused here with
 *    a readable message and no op appended. This is deliberately *not* a
 *    type-catalog check: the validator proves "exactly one well-shaped type
 *    expression", so a well-shaped but engine-unknown type (e.g. `VARBIT`
 *    or a typo like `INTEGR`) still reaches the engine — where it fails at
 *    schema materialization and is honest-surfaced through the commit
 *    rollback+alert path (see `session.ts`). Two failure classes, two
 *    honest surfaces.
 *
 * Purity: engine validation only (no React/DOM) — Node-tested. The returned
 * `targetType` is the trimmed original; it is never rebuilt from parsed
 * info (the engine composes the already-validated original).
 */
import { validateEngineTypeExpression } from '@assay/engine-duckdb'

/**
 * A sensible, closed set of common cast targets offered by the UI. Every
 * entry is validated by the engine validator at render time (see the unit
 * tests); the list is a convenience, never the definition of the type space —
 * the custom spelling path can express anything the engine accepts.
 */
export const COMMON_CAST_TARGETS: readonly string[] = [
  'VARCHAR',
  'BIGINT',
  'INTEGER',
  'DOUBLE',
  'DECIMAL(10,2)',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
]

/** The option value that reveals the free-form type input. */
export const CAST_CUSTOM_OPTION = '__custom__'

/** One client validation outcome: a committable value, or a readable reason. */
export type ColumnOpResult<T extends object> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string }

/**
 * Validate a rename target. Empty (after trimming surrounding whitespace) is
 * refused with readable text; identity and collisions are left to the domain
 * (`rename-identity` no-op / `rename-collision` conflict), so the client
 * never contradicts the fold.
 */
export function validateRenameTarget(name: string): ColumnOpResult<{ readonly name: string }> {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, reason: 'Enter a column name.' }
  return { ok: true, name: trimmed }
}

/**
 * Validate a cast target with the engine's exported type-expression
 * validator. Returns the trimmed original spelling on success; on a
 * `EngineTypeError` (or any throw) returns a readable reason and the caller
 * appends no op.
 */
export function validateCastTarget(
  target: string,
): ColumnOpResult<{ readonly targetType: string }> {
  const trimmed = target.trim()
  if (trimmed === '') return { ok: false, reason: 'Choose a target type or enter one.' }
  try {
    validateEngineTypeExpression(trimmed)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `"${trimmed}" is not a valid column type: ${detail}.` }
  }
  return { ok: true, targetType: trimmed }
}
