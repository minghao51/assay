/**
 * JSON Schema → contract adapter (m5-5): a documented **subset** of JSON
 * Schema draft 2020-12 → {@link ContractV1} (ADR 0013/0026 — adapters for
 * compatible subsets; never a full mapping).
 *
 * `jsonSchemaToContract` is **total**: any input yields either a contract or
 * `JsonSchemaAdapterError[]` — never a throw (repo never-throws convention;
 * hostile inputs — prototype spellings, throwing getters, unreadable
 * proxies — are pinned). Like the m5-0 parser it collects **all independent
 * errors** per conversion; unlike it, errors carry a **JSON Pointer path**
 * (RFC 6901, root is the empty string) and **no line/column**: the input is
 * a *parsed JSON value*, not text — the adapter never sees source positions
 * (nor the original number literals — see "Numerics" below).
 *
 * ## The subset — every mapping decision, documented
 *
 * | JSON Schema (draft 2020-12)                  | Contract v1                                   |
 * | -------------------------------------------- | --------------------------------------------- |
 * | root `type: 'object'` (or `['object']`)      | required; a non-object root is not in the subset and stops the walk |
 * | root `title` (non-empty string)              | `metadata.name` — **required**: v1 has no nameless contracts and the adapter never invents identifiers |
 * | root `description`                           | `metadata.description` (`''` normalizes to absent, mirroring m5-0) |
 * | root `$schema` (string)                      | accepted and ignored — it is an identifier, carrying no constraint |
 * | (no JSON Schema equivalent)                  | `metadata.version` = 1 (a contract's own revision; callers may re-version the AST) |
 * | `properties` (mapping of name → schema)      | `columns[]` — one entry per property, **in `properties` key order**; each entry must be a schema *object* (boolean schemas are out of subset); a property name must be non-empty |
 * | property `type: 'string'`                    | `type: VARCHAR`                               |
 * | property `type: 'integer'`                   | `type: BIGINT`                                |
 * | property `type: 'number'`                    | `type: DOUBLE`                                |
 * | property `type: 'boolean'`                   | `type: BOOLEAN`                               |
 * | property `type` as a single-element array    | same as the string form (`['string']` ≡ `'string'`) |
 * | `required` (root-level array)                | `required: true` on the named property's column; names without a `properties` entry are typed errors (m5-0's unknown-column strictness) — walked even when `properties` is absent or unreadable (see the call-out below); duplicates are errors; `[]` is fine |
 * | property `enum`                              | `allowed-values` — entries must be strings, finite numbers, or booleans (m5-0's entry-kind rule); `null`/objects/arrays are errors (nullness is `required`/`max-null-share` territory); **`[]` maps to `allowed-values: []`** (a real constraint: every non-NULL value fails) |
 * | `minimum` / `maximum`                        | `min` / `max` (inclusive); derived `min > max` is an error, mirroring m5-0 |
 * | `pattern` (RE2-subset-safe per `checkRe2SubsetPattern`) | `regex`, carried **verbatim** |
 *
 * Decisions worth calling out:
 *
 * - **`exclusiveMinimum`/`exclusiveMaximum` are out of subset** (draft
 *   2020-12 number form included): an exclusive bound has *no honest
 *   inclusive representation* in contract v1 — mapping `exclusiveMinimum: 5`
 *   to `min: 5` would admit the very value the schema excludes, and there
 *   is no "next value" for reals. Reported as unsupported keys, never
 *   approximated inclusively.
 * - **`type: 'array' | 'object' | 'null'` (and type arrays beyond the
 *   single-element form) are unsupported types**: JSON has no honest target
 *   in the closed 21-spelling vocabulary — engine `DESCRIBE` reality owns
 *   type truth, and the adapter never invents spellings outside it. Nested
 *   `properties`/`items` under such types are reported as the unsupported
 *   keys they are; flattening nested structure is a future, queued concern.
 * - **A property schema that yields no rule (e.g. `{}`) normalizes away** —
 *   exactly what m5-0's parser does to a rule-less `columns[]` entry, so
 *   the adapter's output has the same shape `parseContract` returns (one
 *   shape per meaning; the round-trip property stays exact).
 * - **Per-property `title`/`description` are unsupported keys** (contract
 *   v1 has no per-column documentation — silently dropping an author's
 *   annotations would violate the honesty bar; annotate the contract YAML
 *   instead). Only root-level `$schema` is accept-and-ignore, and only when
 *   it is a string (a non-string is a `wrong-type` error — nothing is
 *   silently dropped, ever).
 * - **`required` is walked even when `properties` is absent or unreadable**:
 *   the declared-name set is then empty, so every entry of a non-empty
 *   `required` becomes a typed `unknown-key` error at its exact
 *   `/required/N` pointer (a duplicated name reports once per occurrence)
 *   — `{type: 'object', required: ['ghost']}` fails loudly instead of
 *   converting to a validates-nothing `columns: []` contract. An *empty*
 *   `required` without `properties` converts with `columns: []`: an empty
 *   array carries no constraint, so there is nothing to drop. Either way
 *   the outcome is identical to the same schema *with* `properties: {}` —
 *   constraint handling never depends on an unrelated key's presence.
 * - **Duplicate `properties` keys cannot be seen**: JSON object keys are
 *   resolved by the caller's JSON.parse before the adapter runs (last one
 *   wins, silently). Same for number literals (below). Both are properties
 *   of the text→value boundary this interface does not own.
 *
 * ## Numerics (the exact-or-rejected policy, honestly scoped)
 *
 * m5-0's parser rejects a *written literal* the YAML→number parse would
 * silently alter (`9007199254740993` → `…992`) because it sees the source
 * text. This adapter consumes a **parsed JSON value** — a JSON text writing
 * `9007199254740993` reaches it already rounded to the neighboring double;
 * no adapter can recover the written literal. What the adapter guarantees
 * instead, and pins: the number **carried is exactly the number given**
 * (never re-rounded here), every carried number is finite, and its
 * `String()` spelling is a plain decimal literal — precisely the acceptance
 * of the canonical-decimal comparator applied to the only spelling the
 * adapter possesses, which is exactly what `serializeContract` will emit.
 * The one deliberate normalization is `-0` → `0`: m5-0's canonical rule is
 * that ±0 are one value, and the YAML parse of a serialized `-0` yields
 * `+0`, so carrying `-0` would break the exact round trip (JSON itself has
 * no `-0`; this only ever fires for hostile direct-object input).
 * The built contract is re-verified through `parseContract(serializeContract(…))`
 * on every successful conversion (see the internal-invariant shield below),
 * so the m5-0 exactness gate itself signs off on each result.
 *
 * ## Regex dialect honesty
 *
 * `pattern` converts only when {@link checkRe2SubsetPattern} accepts it (a
 * conservative, self-contained RE2-subset filter — see its module doc).
 * Otherwise `pattern` yields a typed **unsupported-key** error naming the
 * reason (the queue's core requirement: dialect honesty, no silent
 * approximation). A converted pattern is later judged authoritatively by
 * the binding-time RE2 checker in `@assay/validation` (m5-1); a pattern that
 * fails there surfaces as that typed binding error — the chain never
 * silently approximates.
 *
 * ## Unsupported keys — all of them, always
 *
 * Every key outside the subset (root or per-property) is reported as a
 * typed `unsupported-key` error **with its JSON Pointer path**, and all of
 * them are collected per conversion (m5-0's all-independent-errors pattern)
 * — nothing is ever silently dropped. The walk has two deliberate stops,
 * mirroring the m5-0 parser's: a non-object input (nothing to walk) and a
 * root that does not declare `type: 'object'` (the document is not in the
 * subset's shape, so the rest is not interpreted).
 *
 * ## The internal-invariant shield
 *
 * A successful conversion is re-verified by re-parsing its own canonical
 * serialization. If that ever failed (an adapter bug), the result is a typed
 * `invalid-contract` error — the "output always parses as a valid m5-0
 * contract" property holds by construction *and* by verification, for every
 * input, not just the seeded corpus. The property suite additionally proves
 * the round trip is *exact* (the re-parsed AST equals the produced one).
 *
 * Purity: no React, no browser APIs, no engine or `@assay/*` imports
 * (docs/engineering/05-repository-structure.md §3, lint-enforced).
 */

import { CONTRACT_FORMAT } from './ast'
import type { ColumnRuleSet, ContractScalar, ContractV1 } from './ast'
import type { ContractTypeSpelling } from './vocabulary'
import { describeContractError } from './errors'
import { serializeContract } from './serialize'
import { parseContract } from './parse'
import { checkRe2SubsetPattern } from './re2-subset'

/**
 * Machine-readable adapter failure classes (stable, switch-able; mirrors the
 * m5-0 vocabulary where a concept overlaps — but no line/column, see the
 * module doc).
 */
export type JsonSchemaAdapterErrorCode =
  /** A key is present whose meaning is outside the documented subset — including `pattern` rejected by the conservative RE2-subset check and the exclusive bounds. Never silently dropped. */
  | 'unsupported-key'
  /** A JSON Schema `type` (root or property) with no honest target in the contract type vocabulary. */
  | 'unsupported-type'
  /** A required key is absent (the root `title`). */
  | 'missing-key'
  /** A key's value has the wrong JSON shape/type — including values that cannot be read (a hostile getter or proxy threw). */
  | 'wrong-type'
  /** A value violates its key's domain: a non-finite number, an empty name, derived `min > max`. */
  | 'out-of-range'
  /** The same property named twice in `required`. */
  | 'duplicate-key'
  /** `required` names a property that has no `properties` entry. */
  | 'unknown-key'
  /** Internal-invariant shield: the built contract failed the m5-0 re-parse. Unreachable by construction; if ever seen, it is an adapter bug — reported as data, never an invalid contract. */
  | 'invalid-contract'

/** One actionable conversion failure. Plain data — render it however the surface wants. */
export interface JsonSchemaAdapterError {
  readonly code: JsonSchemaAdapterErrorCode
  readonly message: string
  /**
   * RFC 6901 JSON Pointer to the offending key (`/properties/email/pattern`,
   * `/required/0`); the document root is the empty string. `~` and `/` in
   * property names are escaped (`~0`/`~1`). No line/column: the input is a
   * parsed value, not text (see the module doc).
   */
  readonly path: string
}

/** A conversion outcome. `ok` discriminates: never a raw throw. */
export type JsonSchemaAdapterResult =
  | { readonly ok: true; readonly contract: ContractV1 }
  | { readonly ok: false; readonly errors: readonly JsonSchemaAdapterError[] }

/** Keys accepted at the document root — everything else is an unsupported key. */
const ROOT_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
])

/** Keys accepted inside a `properties` entry — everything else is an unsupported key. */
const PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'minimum',
  'maximum',
  'pattern',
])

/** JSON Schema type → contract vocabulary spelling, for the four honest mappings. */
const TYPE_MAPPINGS: Readonly<Record<string, ContractTypeSpelling>> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  number: 'DOUBLE',
  boolean: 'BOOLEAN',
}

/**
 * Curated, actionable reasons for the commonly met unsupported keys (the
 * queue's list). Keys not listed here fall back to the generic reason — the
 * error is equally explicit either way.
 */
const UNSUPPORTED_KEY_REASONS: Readonly<Record<string, string>> = {
  $id: 'an "$id" identifier carries no constraint the contract could express',
  $comment: 'a "$comment" annotation is not carried into contracts',
  $anchor: 'an "$anchor" identifier is meaningless outside its schema document',
  $defs: '"$defs" definitions are outside the subset (references are not followed)',
  $dynamicAnchor: 'dynamic references are outside the subset',
  $dynamicRef: 'dynamic references are outside the subset',
  $ref: '"$ref" references are outside the subset — inline the referenced schema',
  additionalProperties:
    '"additionalProperties" is outside the subset — the subset maps "properties" entries to columns and nothing else',
  allOf: '"allOf" composition is outside the subset — inline the constraints instead',
  anyOf: '"anyOf" composition is outside the subset',
  const: '"const" is outside the subset — write it as "enum" with a single value',
  contains: '"contains" is outside the subset (array schemas are not converted)',
  default: '"default" is an annotation — contracts describe validation, not defaults',
  dependentRequired: 'key-dependency rules are outside the subset',
  dependentSchemas: '"dependentSchemas" is outside the subset',
  deprecated: '"deprecated" is an annotation with no contract equivalent',
  else: '"if/then/else" conditionals are outside the subset',
  then: '"if/then/else" conditionals are outside the subset',
  if: '"if/then/else" conditionals are outside the subset',
  examples: '"examples" is an annotation — not carried into contracts',
  exclusiveMaximum:
    'an exclusive bound has no honest inclusive mapping in contract v1 — "max" would admit the very value the schema excludes; remove the exclusivity or hand-write the contract',
  exclusiveMinimum:
    'an exclusive bound has no honest inclusive mapping in contract v1 — "min" would admit the very value the schema excludes; remove the exclusivity or hand-write the contract',
  format: '"format" annotations are outside the subset — contract v1 has no format expectations',
  items: '"items" is outside the subset (array item schemas are not converted)',
  maxContains: '"contains" is outside the subset (array schemas are not converted)',
  minContains: '"contains" is outside the subset (array schemas are not converted)',
  maxItems: '"minItems"/"maxItems" are outside the subset (array schemas are not converted)',
  minItems: '"minItems"/"maxItems" are outside the subset (array schemas are not converted)',
  maxLength: '"minLength"/"maxLength" are outside the subset — contract v1 has no length rule',
  minLength: '"minLength"/"maxLength" are outside the subset — contract v1 has no length rule',
  maxProperties: '"minProperties"/"maxProperties" are outside the subset',
  minProperties: '"minProperties"/"maxProperties" are outside the subset',
  multipleOf: '"multipleOf" is outside the subset — contract v1 has no step rule',
  not: '"not" composition is outside the subset',
  oneOf: '"oneOf" composition is outside the subset',
  patternProperties:
    '"patternProperties" is outside the subset — declare each constrained property under "properties"',
  prefixItems: '"prefixItems" is outside the subset (array schemas are not converted)',
  propertyNames: '"propertyNames" is outside the subset',
  readOnly: '"readOnly"/"writeOnly" annotations have no contract equivalent',
  writeOnly: '"readOnly"/"writeOnly" annotations have no contract equivalent',
  title: 'contract v1 has no per-column documentation — annotate the contract YAML instead',
  description: 'contract v1 has no per-column documentation — annotate the contract YAML instead',
  unevaluatedItems: '"unevaluatedItems" is outside the subset',
  unevaluatedProperties: '"unevaluatedProperties" is outside the subset',
  uniqueItems: '"uniqueItems" is outside the subset (array schemas are not converted)',
}

/** JSON-typed description of a value for error messages ("a string", "an array", …). */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  switch (typeof value) {
    case 'string':
      return `the string ${JSON.stringify(value)}`
    case 'number':
      return Number.isNaN(value) ? 'NaN' : `the number ${String(value)}`
    case 'boolean':
      return `the boolean ${String(value)}`
    case 'undefined':
      return 'undefined'
    case 'function':
      return 'a function'
    case 'symbol':
      return 'a symbol'
    case 'bigint':
      return 'a bigint'
    default:
      return 'an object'
  }
}

/**
 * m5-0's canonical ±0 rule: `-0` and `0` are one value, and the YAML parse
 * of a serialized `-0` yields `+0` — so a carried `-0` would break the exact
 * round trip. JSON itself has no `-0`; normalization only ever fires for
 * hostile direct-object input (pinned).
 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value
}

/** RFC 6901 escaping for one path token. */
function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

const ABSENT = Symbol('json-schema-key-absent')

/**
 * Read one own property without ever throwing: absent keys, throwing
 * getters and hostile proxies all come back as data. `ABSENT` marks an
 * absent own key; `THREW` marks an unreadable one.
 */
const THREW = Symbol('json-schema-key-threw')

function readKey(target: object, key: string): unknown {
  try {
    if (!Object.hasOwn(target, key)) return ABSENT
    return (target as Record<string, unknown>)[key]
  } catch {
    return THREW
  }
}

/** Own enumerable string keys of an object; `null` when the object refuses enumeration (hostile proxy). */
function ownKeys(target: object): readonly string[] | null {
  try {
    return Object.keys(target)
  } catch {
    return null
  }
}

/** A non-null, non-array object — the only JSON object shape this adapter accepts. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a root/property key that must be a string, or push the right error. */
function wantString(
  errors: JsonSchemaAdapterError[],
  container: object,
  key: string,
  path: string,
): string | undefined {
  const value = readKey(container, key)
  if (value === ABSENT) return undefined
  if (value === THREW) {
    errors.push({
      code: 'wrong-type',
      message: `${path || 'the schema'}: could not be read — reading it threw (a hostile getter or proxy)`,
      path,
    })
    return undefined
  }
  if (typeof value !== 'string') {
    errors.push({
      code: 'wrong-type',
      message: `${path}: expected a string, got ${describeValue(value)}`,
      path,
    })
    return undefined
  }
  return value
}

/**
 * The walk state for one conversion. Errors accumulate across the whole
 * document — all independent errors are reported, never just the first.
 */
interface WalkState {
  readonly errors: JsonSchemaAdapterError[]
  readonly requiredNames: Set<string>
}

/**
 * Convert a JSON Schema (draft 2020-12 subset) into a contract v1. Total:
 * never throws, for any input. See the module doc for the documented subset
 * and every mapping decision.
 *
 * The input is a *parsed* JSON value (a plain object). JSON text must be
 * parsed by the caller — which also means the caller's JSON.parse owns the
 * text→value honesty boundary (duplicate keys, number-literal rounding);
 * see "Numerics" in the module doc.
 */
export function jsonSchemaToContract(input: unknown): JsonSchemaAdapterResult {
  // Stop 1: nothing to walk. (A JSON document is an object or an array; an
  // array root is not a schema, and anything else is not JSON at all.)
  if (!isJsonObject(input)) {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: `the schema must be a JSON object, got ${describeValue(input)}`,
          path: '',
        },
      ],
    }
  }

  const keys = ownKeys(input)
  if (keys === null) {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: 'the schema: could not be read — enumerating its keys threw (a hostile proxy)',
          path: '',
        },
      ],
    }
  }

  // Stop 2: the subset converts object-rooted schemas only. Reported alone
  // rather than guessing at the rest (mirrors the m5-0 format stop).
  const rootType = readKey(input, 'type')
  if (rootType === THREW) {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: '/type: could not be read — reading it threw (a hostile getter or proxy)',
          path: '/type',
        },
      ],
    }
  }
  if (rootType === ABSENT) {
    return {
      ok: false,
      errors: [
        {
          code: 'unsupported-type',
          message:
            'the root schema declares no "type" — this adapter converts only object-rooted schemas ("type": "object")',
          path: '/type',
        },
      ],
    }
  }
  if (!rootTypeIsObject(rootType)) {
    return {
      ok: false,
      errors: [
        {
          code: 'unsupported-type',
          message: `the root schema must declare "type": "object" (or ["object"]), got ${describeValue(
            rootType,
          )} — this adapter converts only object-rooted schemas`,
          path: '/type',
        },
      ],
    }
  }

  const state: WalkState = { errors: [], requiredNames: new Set() }

  // Unsupported root keys — every key outside the subset is reported with
  // its path, collected across the whole document (never silently dropped).
  for (const key of keys) {
    if (!ROOT_KEYS.has(key)) {
      state.errors.push({
        code: 'unsupported-key',
        message: `unsupported key "${key}" — ${
          Object.hasOwn(UNSUPPORTED_KEY_REASONS, key)
            ? UNSUPPORTED_KEY_REASONS[key]
            : 'not part of the documented subset'
        }; this adapter converts only the documented subset and never drops keys silently`,
        path: `/${escapePointerToken(key)}`,
      })
    }
  }

  // --- metadata -----------------------------------------------------------
  // `title` is required: contract v1 has no nameless contracts, and the
  // adapter never invents identifiers.
  const titleValue = readKey(input, 'title')
  let title: string | undefined
  if (titleValue === ABSENT) {
    state.errors.push({
      code: 'missing-key',
      message:
        'missing required key "title" — it becomes the contract\'s name (the adapter never invents identifiers)',
      path: '/title',
    })
  } else {
    title = wantString(state.errors, input, 'title', '/title')
    if (title !== undefined && title.length === 0) {
      state.errors.push({
        code: 'out-of-range',
        message:
          '/title: must be a non-empty string — the contract name (the adapter never invents identifiers)',
        path: '/title',
      })
    }
  }
  const description = wantString(state.errors, input, 'description', '/description')
  const schemaId = readKey(input, '$schema')
  if (schemaId === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: '/$schema: could not be read — reading it threw (a hostile getter or proxy)',
      path: '/$schema',
    })
  } else if (schemaId !== ABSENT && typeof schemaId !== 'string') {
    state.errors.push({
      code: 'wrong-type',
      message: `/$schema: expected a string (it is accepted as an identifier and otherwise ignored), got ${describeValue(
        schemaId,
      )}`,
      path: '/$schema',
    })
  }

  // --- properties → columns ----------------------------------------------
  const properties = readKey(input, 'properties')
  const columns: ColumnRuleSet[] = []
  // The readable `properties` mapping and its declared keys — both null
  // when `properties` is absent, unreadable, or not an object (each of
  // those states pushes its own error below, and the declared names are
  // then unknowable). The `required` walk below always runs — against the
  // empty name set in that case, so every required name becomes a typed
  // unknown-key error and a non-empty `required` is never silently
  // dropped, whatever shape `properties` takes.
  let propertySchemas: Record<string, unknown> | null = null
  let propertyKeys: readonly string[] | null = null
  if (properties === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: '/properties: could not be read — reading it threw (a hostile getter or proxy)',
      path: '/properties',
    })
  } else if (properties !== ABSENT) {
    if (!isJsonObject(properties)) {
      state.errors.push({
        code: 'wrong-type',
        message: `/properties: expected an object mapping property names to schemas, got ${describeValue(
          properties,
        )}`,
        path: '/properties',
      })
    } else {
      propertyKeys = ownKeys(properties)
      if (propertyKeys === null) {
        state.errors.push({
          code: 'wrong-type',
          message: '/properties: could not be read — enumerating its keys threw (a hostile proxy)',
          path: '/properties',
        })
      } else {
        propertySchemas = properties
      }
    }
  }
  // `required` first — and always, readable `properties` or not: a required
  // name alone turns its property into a rule-bearing column, so the
  // rule-less normalization in walkProperty must already see it; and with
  // no declared names (no readable `properties`), every required name is a
  // typed unknown-key error — nothing silently dropped.
  walkRequired(state, input, new Set<string>(propertyKeys ?? []))
  if (propertySchemas !== null && propertyKeys !== null) {
    for (const name of propertyKeys) {
      const column = walkProperty(state, propertySchemas, name)
      if (column !== null) columns.push(column)
    }
  }

  if (state.errors.length > 0) return { ok: false, errors: state.errors }

  // Assemble the normalized AST — the exact shape parseContract returns:
  // `description: ''` omitted, `columns` always an array (rule-less entries
  // were dropped in walkProperty), `version` always carried.
  const metadata: { name: string; version: number; description?: string } = {
    name: title as string,
    version: 1,
  }
  // `description: ''` normalizes to absent (mirrors m5-0; keeps the
  // adapter's output exactly the shape parseContract returns).
  if (description !== undefined && description !== '') metadata.description = description
  const contract: ContractV1 = { format: CONTRACT_FORMAT, metadata, columns }

  // Internal-invariant shield: the produced contract must re-parse as valid.
  // Unreachable by construction; if an adapter bug ever breaks it, the
  // caller gets a typed error instead of an invalid contract.
  const verification = parseContract(serializeContract(contract))
  if (!verification.ok) {
    return {
      ok: false,
      errors: [
        {
          code: 'invalid-contract',
          message: `internal invariant violated: the converted contract failed re-parse — ${verification.errors
            .map(describeContractError)
            .join('; ')}`,
          path: '',
        },
      ],
    }
  }
  return { ok: true, contract }
}

/** Is the root `type` value the object spelling (string or single-element array form)? Total over hostile arrays (element getters can throw). */
function rootTypeIsObject(rootType: unknown): boolean {
  try {
    if (rootType === 'object') return true
    return Array.isArray(rootType) && rootType.length === 1 && rootType[0] === 'object'
  } catch {
    return false // an unreadable element is not the object spelling — reported as unsupported-type below
  }
}

/**
 * Walk one property schema and build its column rule set. Returns `null`
 * when the entry contributes no column (rules all normalized away, or the
 * schema was unreadable — the errors say which).
 */
function walkProperty(
  state: WalkState,
  properties: Record<string, unknown>,
  name: string,
): ColumnRuleSet | null {
  const pointer = `/properties/${escapePointerToken(name)}`
  if (name.length === 0) {
    state.errors.push({
      code: 'out-of-range',
      message: `${pointer}: property names must be non-empty strings — contract v1 has no nameless columns`,
      path: pointer,
    })
    return null
  }
  if (name.includes('\u0000')) {
    // A NUL in a column name is unbindable in SQL text and the m5-0 parser
    // rejects it; refuse it here so the adapter never builds a contract its
    // own re-parse shield would reject (AR-V2).
    state.errors.push({
      code: 'out-of-range',
      message: `${pointer}: property names must not contain a NUL character (it cannot be bound to SQL text)`,
      path: pointer,
    })
    return null
  }
  const schema = readKey(properties, name)
  if (schema === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: `${pointer}: could not be read — reading it threw (a hostile getter or proxy)`,
      path: pointer,
    })
    return null
  }
  if (!isJsonObject(schema)) {
    state.errors.push({
      code: 'wrong-type',
      message: `${pointer}: expected a schema object, got ${describeValue(schema)} (boolean schemas are outside the subset)`,
      path: pointer,
    })
    return null
  }
  const keys = ownKeys(schema)
  if (keys === null) {
    state.errors.push({
      code: 'wrong-type',
      message: `${pointer}: could not be read — enumerating its keys threw (a hostile proxy)`,
      path: pointer,
    })
    return null
  }

  // Unsupported keys first — every key outside the subset is reported with
  // its path, collected across the whole document.
  for (const key of keys) {
    if (!PROPERTY_KEYS.has(key)) {
      state.errors.push({
        code: 'unsupported-key',
        message: `unsupported key "${key}" — ${
          Object.hasOwn(UNSUPPORTED_KEY_REASONS, key)
            ? UNSUPPORTED_KEY_REASONS[key]
            : 'not part of the documented subset'
        }; this adapter converts only the documented subset and never drops keys silently`,
        path: `${pointer}/${escapePointerToken(key)}`,
      })
    }
  }

  // type → declared-type
  let type: ContractTypeSpelling | undefined
  const typeValue = readKey(schema, 'type')
  if (typeValue === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: `${pointer}/type: could not be read — reading it threw (a hostile getter or proxy)`,
      path: `${pointer}/type`,
    })
  } else if (typeValue !== ABSENT) {
    // Array element access is guarded: a hostile array can carry throwing
    // index getters, and the never-throws promise covers them too.
    let forms: readonly unknown[] | null
    if (typeof typeValue === 'string') forms = [typeValue]
    else if (Array.isArray(typeValue)) {
      try {
        forms = [...typeValue]
      } catch {
        forms = null
      }
    } else forms = null
    if (forms === null) {
      state.errors.push({
        code: 'wrong-type',
        message: `${pointer}/type: expected a string or an array of strings, got ${describeValue(
          typeValue,
        )}`,
        path: `${pointer}/type`,
      })
    } else if (forms.length !== 1) {
      state.errors.push({
        code: 'unsupported-type',
        message: `${pointer}/type: ${forms.length === 0 ? 'an empty type array' : 'a union of types'} has no single honest declared-type in the contract vocabulary (a v1 column addresses one type; null-union member types are not stripped silently)`,
        path: `${pointer}/type`,
      })
    } else {
      const spellingKey = forms[0]
      // Own-property only: the key is user-written JSON, and a plain-record
      // index would inherit `Object.prototype` members — a `type` array of
      // ["__proto__"] would otherwise "map" to the prototype object itself.
      const spelling =
        typeof spellingKey === 'string' && Object.hasOwn(TYPE_MAPPINGS, spellingKey)
          ? TYPE_MAPPINGS[spellingKey]
          : undefined
      if (spelling === undefined) {
        state.errors.push({
          code: 'unsupported-type',
          message: `${pointer}/type: ${JSON.stringify(
            spellingKey,
          )} has no honest target in the contract type vocabulary (the closed v1 spelling set; engine DESCRIBE reality owns type truth) — only "string", "integer", "number" and "boolean" convert`,
          path: `${pointer}/type`,
        })
      } else {
        type = spelling
      }
    }
  }

  // enum → allowed-values (m5-0's entry-kind strictness)
  let allowedValues: readonly ContractScalar[] | undefined
  const enumValue = readKey(schema, 'enum')
  if (enumValue === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: `${pointer}/enum: could not be read — reading it threw (a hostile getter or proxy)`,
      path: `${pointer}/enum`,
    })
  } else if (enumValue !== ABSENT) {
    if (!Array.isArray(enumValue)) {
      state.errors.push({
        code: 'wrong-type',
        message: `${pointer}/enum: expected an array of values, got ${describeValue(enumValue)}`,
        path: `${pointer}/enum`,
      })
    } else {
      // `length` is read under guard: a proxy over an array can throw on any
      // property read, including `length`.
      let length: number | null
      try {
        length = enumValue.length
      } catch {
        length = null
      }
      if (length === null) {
        state.errors.push({
          code: 'wrong-type',
          message: `${pointer}/enum: could not be read — reading it threw (a hostile getter or proxy)`,
          path: `${pointer}/enum`,
        })
      }
      const values: ContractScalar[] = []
      for (let index = 0; index < (length ?? 0); index++) {
        // Element access is guarded: hostile arrays can carry throwing index
        // getters (the never-throws promise covers them).
        let entry: unknown
        try {
          entry = enumValue[index]
        } catch {
          state.errors.push({
            code: 'wrong-type',
            message: `${pointer}/enum/${index}: could not be read — reading it threw (a hostile getter or proxy)`,
            path: `${pointer}/enum/${index}`,
          })
          continue
        }
        const entryPointer = `${pointer}/enum/${index}`
        if (typeof entry === 'string') {
          if (entry.includes('\u0000')) {
            state.errors.push({
              code: 'out-of-range',
              message: `${entryPointer}: must not contain a NUL character (it cannot be bound to SQL text)`,
              path: entryPointer,
            })
          } else {
            values.push(entry)
          }
        } else if (typeof entry === 'boolean') {
          values.push(entry)
        } else if (typeof entry === 'number') {
          if (!Number.isFinite(entry)) {
            state.errors.push({
              code: 'out-of-range',
              message: `${entryPointer}: expected a finite number, got ${describeValue(entry)}`,
              path: entryPointer,
            })
          } else {
            values.push(normalizeZero(entry))
          }
        } else {
          state.errors.push({
            code: 'wrong-type',
            message: `${entryPointer}: enum entries must be strings, finite numbers, or booleans, got ${describeValue(
              entry,
            )}${
              entry === null
                ? ' — null membership is not expressible; govern nullness with "required" instead'
                : ''
            }`,
            path: entryPointer,
          })
        }
      }
      // An empty enum is preserved: `allowed-values: []` is a real
      // constraint ("every non-NULL value fails") — the honest mapping.
      // (With a hostile unreadable `length`, `values` stays empty — but the
      // unreadable error above fails the conversion, so nothing is lost.)
      allowedValues = values
    }
  }

  // minimum/maximum → min/max
  const minimum = wantFiniteNumber(state, schema, `${pointer}/minimum`)
  const maximum = wantFiniteNumber(state, schema, `${pointer}/maximum`)
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    state.errors.push({
      code: 'out-of-range',
      message: `${pointer}/maximum: maximum (${String(maximum)}) must be ≥ minimum (${String(minimum)})`,
      path: `${pointer}/maximum`,
    })
  }

  // pattern → regex (verbatim), gated by the conservative RE2-subset check
  let regex: string | undefined
  const patternValue = readKey(schema, 'pattern')
  if (patternValue === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: `${pointer}/pattern: could not be read — reading it threw (a hostile getter or proxy)`,
      path: `${pointer}/pattern`,
    })
  } else if (patternValue !== ABSENT) {
    if (typeof patternValue !== 'string') {
      state.errors.push({
        code: 'wrong-type',
        message: `${pointer}/pattern: expected a string, got ${describeValue(patternValue)}`,
        path: `${pointer}/pattern`,
      })
    } else {
      const check = checkRe2SubsetPattern(patternValue)
      if (!check.valid) {
        state.errors.push({
          code: 'unsupported-key',
          message: `unsupported key "pattern" — the pattern is outside the conservative RE2 subset this adapter converts (${check.reason}); the authoritative RE2 judgment happens when the contract is bound to a dataset, so nothing is approximated here — simplify the pattern or hand-write the contract`,
          path: `${pointer}/pattern`,
        })
      } else {
        regex = patternValue
      }
    }
  }

  // Assemble the rule set. A property that yields no rule at all
  // (e.g. `{}`) normalizes away — exactly what m5-0's parser does to a
  // rule-less columns[] entry — except that a name in `required` IS a rule
  // (applied below, before assembly, via requiredNames).
  if (
    type === undefined &&
    allowedValues === undefined &&
    minimum === undefined &&
    maximum === undefined &&
    regex === undefined &&
    !state.requiredNames.has(name)
  ) {
    return null
  }
  const column: {
    name: string
    type?: ContractTypeSpelling
    required?: true
    min?: number
    max?: number
    allowedValues?: readonly ContractScalar[]
    regex?: string
  } = { name }
  if (type !== undefined) column.type = type
  if (state.requiredNames.has(name)) column.required = true
  if (minimum !== undefined) column.min = minimum
  if (maximum !== undefined) column.max = maximum
  if (allowedValues !== undefined) column.allowedValues = allowedValues
  if (regex !== undefined) column.regex = regex
  return column
}

/** Read `minimum`/`maximum`-shaped numeric keys, with hostile-value handling. */
function wantFiniteNumber(state: WalkState, container: object, path: string): number | undefined {
  const key = path.slice(path.lastIndexOf('/') + 1)
  const value = readKey(container, key)
  if (value === ABSENT) return undefined
  if (value === THREW) {
    state.errors.push({
      code: 'wrong-type',
      message: `${path}: could not be read — reading it threw (a hostile getter or proxy)`,
      path,
    })
    return undefined
  }
  if (typeof value !== 'number') {
    state.errors.push({
      code: 'wrong-type',
      message: `${path}: expected a number, got ${describeValue(value)}`,
      path,
    })
    return undefined
  }
  if (!Number.isFinite(value)) {
    state.errors.push({
      code: 'out-of-range',
      message: `${path}: expected a finite number, got ${describeValue(value)}`,
      path,
    })
    return undefined
  }
  return normalizeZero(value)
}

/** JSON Pointer path of one `required` entry. */
function entryPointer(index: number): string {
  return `/required/${index}`
}

/**
 * Walk the root `required` array: marks, unknowns, duplicates, wrong shapes.
 * Runs whatever `properties` did — against an empty name set when no
 * readable `properties` declared any names, which types every entry
 * `unknown-key` at its own pointer (nothing silently dropped).
 */
function walkRequired(
  state: WalkState,
  input: Record<string, unknown>,
  propertyNames: ReadonlySet<string>,
): void {
  const required = readKey(input, 'required')
  if (required === ABSENT || required === THREW) {
    if (required === THREW) {
      state.errors.push({
        code: 'wrong-type',
        message: '/required: could not be read — reading it threw (a hostile getter or proxy)',
        path: '/required',
      })
    }
    return
  }
  if (!Array.isArray(required)) {
    state.errors.push({
      code: 'wrong-type',
      message: `/required: expected an array of property names, got ${describeValue(required)}`,
      path: '/required',
    })
    return
  }
  let length: number | null
  try {
    length = required.length
  } catch {
    length = null
  }
  if (length === null) {
    state.errors.push({
      code: 'wrong-type',
      message: '/required: could not be read — reading it threw (a hostile getter or proxy)',
      path: '/required',
    })
    return
  }
  const seen = new Set<string>()
  for (let index = 0; index < length; index++) {
    // Element access is guarded: hostile arrays can carry throwing index getters.
    let entry: unknown
    try {
      entry = required[index]
    } catch {
      state.errors.push({
        code: 'wrong-type',
        message: `${entryPointer(index)}: could not be read — reading it threw (a hostile getter or proxy)`,
        path: entryPointer(index),
      })
      continue
    }
    const path = entryPointer(index)
    if (typeof entry !== 'string') {
      state.errors.push({
        code: 'wrong-type',
        message: `${path}: required entries must be strings, got ${describeValue(entry)}`,
        path,
      })
      continue
    }
    if (!propertyNames.has(entry)) {
      state.errors.push({
        code: 'unknown-key',
        message: `${path}: required names ${JSON.stringify(
          entry,
        )} but "properties" declares no such property — add a schema for it under "properties" (or remove it from "required")`,
        path,
      })
      continue
    }
    if (seen.has(entry)) {
      state.errors.push({
        code: 'duplicate-key',
        message: `${path}: duplicate required entry ${JSON.stringify(entry)} — each property may be required at most once`,
        path,
      })
      continue
    }
    seen.add(entry)
    state.requiredNames.add(entry)
  }
}
