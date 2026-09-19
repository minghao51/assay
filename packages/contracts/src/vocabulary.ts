/**
 * The contract declared-type vocabulary (m5-0).
 *
 * v1 contracts express a column's declared-type expectation (`type`) using
 * exactly these spellings — a closed, documented, canonical set. The m5-2
 * engine work adds an agreement test asserting every spelling here is a real
 * engine (DuckDB) type, so this list is deliberately **plain data**: an
 * exported readonly list plus trivial helpers. No enum machinery, no parser.
 *
 * ## What belongs in the vocabulary
 *
 * - Flat scalar types a data contract realistically constrains. v1 has no
 *   parameterized spellings (`DECIMAL(18,3)`, `VARCHAR(n)`) and no nested
 *   ones (`STRUCT(…)`, `VARCHAR[]`) — their expectation semantics (arity
 *   validation, element types) overlap the engine's own strict type
 *   validator and are a v1 non-goal. Growing the list later is additive
 *   (a minor change).
 * - **Canonical engine spellings only** (what DuckDB's `DESCRIBE` prints).
 *   Accept aliases (`TEXT`, `INT`, …) would fork the canonical form —
 *   instead, aliases are recognized purely to *improve the error message*
 *   ({@link CONTRACT_TYPE_ALIASES}); they are never accepted as rules.
 * - `DECIMAL` is included as the bare spelling (DuckDB's canonical output
 *   for a bare `DECIMAL` is `DECIMAL(18,3)`; the parameterized form is out
 *   of scope per the point above). The m5-2 agreement test pins this.
 *
 * The RE2 note lives on `ColumnRuleSet.regex` (ast.ts): regex *patterns*
 * are carried verbatim and validated engine-side (m5-1); this vocabulary is
 * about declared *types* only.
 */

/**
 * The closed v1 set of declared-type spellings, sorted ascending. Every
 * entry is an uppercase ASCII identifier (canonical-spelling discipline;
 * pinned by tests).
 */
export const CONTRACT_TYPE_VOCABULARY = [
  'BIGINT',
  'BLOB',
  'BOOLEAN',
  'DATE',
  'DECIMAL',
  'DOUBLE',
  'FLOAT',
  'HUGEINT',
  'INTEGER',
  'JSON',
  'SMALLINT',
  'TIME',
  'TIMESTAMP',
  'TINYINT',
  'UBIGINT',
  'UHUGEINT',
  'UINTEGER',
  'USMALLINT',
  'UTINYINT',
  'UUID',
  'VARCHAR',
] as const

/** A spelling from {@link CONTRACT_TYPE_VOCABULARY} (type-level view of the list). */
export type ContractTypeSpelling = (typeof CONTRACT_TYPE_VOCABULARY)[number]

const VOCABULARY_SET: ReadonlySet<string> = new Set(CONTRACT_TYPE_VOCABULARY)

/**
 * Is `spelling` a member of the v1 declared-type vocabulary? Case-sensitive
 * and exact — `varchar` and `VARCHAR(3)` are both unknown (the latter is a
 * parameterized spelling, a v1 non-goal; see the module doc).
 */
export function isKnownContractType(spelling: string): spelling is ContractTypeSpelling {
  return VOCABULARY_SET.has(spelling)
}

/**
 * Common alias spellings → their canonical vocabulary entry. **Not** part of
 * the accepted rule vocabulary: used only to make `unknown-type` errors
 * actionable ("did you mean X?"). Plain data; grows only alongside
 * {@link CONTRACT_TYPE_VOCABULARY}.
 */
export const CONTRACT_TYPE_ALIASES: Readonly<Record<string, ContractTypeSpelling>> = {
  BOOL: 'BOOLEAN',
  DEC: 'DECIMAL',
  INT: 'INTEGER',
  NUMERIC: 'DECIMAL',
  REAL: 'FLOAT',
  STRING: 'VARCHAR',
  TEXT: 'VARCHAR',
}

/**
 * If `spelling` is a known alias, the canonical spelling to suggest;
 * otherwise `null`. Unknown non-alias spellings get no suggestion (the
 * error points at {@link CONTRACT_TYPE_VOCABULARY} instead).
 *
 * The lookup is **own-property only** (`Object.hasOwn`): `spelling` is
 * user-written YAML, and a plain-record index would happily inherit
 * `Object.prototype` members — `type: __proto__` / `constructor` /
 * `toString` would otherwise produce absurd suggestions ("did you mean
 * \"[object Object]\"?"). Pinned by adversarial spellings in
 * `vocabulary.test.ts`.
 */
export function contractTypeHint(spelling: string): ContractTypeSpelling | null {
  return Object.hasOwn(CONTRACT_TYPE_ALIASES, spelling) ? CONTRACT_TYPE_ALIASES[spelling] : null
}
