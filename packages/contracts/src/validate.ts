/**
 * Contract-level document validation (m5-0).
 *
 * The walk from a parsed YAML document to a {@link ContractV1}, rejecting
 * everything the v1 format does not explicitly allow. This is where the
 * honesty bar lives (M5 review hard requirement): **unknown and misplaced
 * YAML keys are rejected with typed errors — never silently dropped**, and
 * the same goes for duplicate rules, unknown type spellings, wrong value
 * types and out-of-range numbers.
 *
 * The walk collects *all* independent errors per document (an author wants
 * the full list, not whack-a-mole), with two deliberate stops:
 *
 * 1. YAML syntax problems — the structure is unreliable, so only those are
 *    reported. This includes the `yaml` library's parse *warnings*, which
 *    mean something was silently coerced (unresolved tag, fixed merge key) —
 *    exactly what this format refuses.
 * 2. `format` naming a version other than `v1` — reported alone rather than
 *    guessing what some other version's keys would mean.
 *
 * Each error points at concrete YAML: the key node for key errors, the
 * value node for value errors, the container for missing keys, and the
 * second occurrence for duplicates.
 *
 * Not part of the public surface: positions come from YAML nodes, so
 * validation is exercised through `parseContract` — the only way to supply
 * a document. It lives in its own module to keep the parser readable.
 *
 * Purity: no React, no browser APIs, no engine or `@assay/*` imports.
 */
import { isAlias, isMap, isNode, isScalar, isSeq } from 'yaml'
import type { Alias, Document, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import { CONTRACT_FORMAT } from './ast.js'
import type { ColumnRuleSet, ContractV1, DatasetRuleSet } from './ast.js'
import type { ContractError, ContractErrorCode } from './errors.js'
import { canonicalDecimal, isExactDecimalLiteral } from './numeric.js'
import { contractTypeHint, isKnownContractType } from './vocabulary.js'
import type { ContractTypeSpelling } from './vocabulary.js'

/**
 * Any parsed YAML node (or absence). Deliberately the loose class union —
 * all narrowing happens at runtime via the library's type guards; the
 * `.Parsed` refinements only tighten `range` optionality, which this module
 * already treats as optional everywhere.
 */
type YamlNode = Alias | Scalar | YAMLMap | YAMLSeq | null

/** Path of the document root in `ContractError.path`. */
const ROOT_PATH = 'document'

const ROOT_KEYS = ['format', 'name', 'version', 'description', 'columns', 'dataset'] as const
const COLUMN_KEYS = [
  'name',
  'type',
  'required',
  'unique',
  'min',
  'max',
  'allowed-values',
  'regex',
  'max-null-share',
  'min-distinct-share',
] as const
const DATASET_KEYS = ['min-rows', 'max-rows'] as const

/** Where each YAML key is legal — powers the "misplaced key" hint on unknown-key errors. */
const KEY_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  format: ['the document root'],
  name: ['the document root', 'a columns[] entry'],
  version: ['the document root'],
  description: ['the document root'],
  columns: ['the document root'],
  dataset: ['the document root'],
  type: ['a columns[] entry'],
  required: ['a columns[] entry'],
  unique: ['a columns[] entry'],
  min: ['a columns[] entry'],
  max: ['a columns[] entry'],
  'allowed-values': ['a columns[] entry'],
  regex: ['a columns[] entry'],
  'max-null-share': ['a columns[] entry'],
  'min-distinct-share': ['a columns[] entry'],
  'min-rows': ['the dataset mapping'],
  'max-rows': ['the dataset mapping'],
}

/**
 * 1-based line start offsets of a source (index 0 = start of line 1).
 *
 * A leading BOM is counted as *before* line 1, not as its first character:
 * editors render it invisibly, so columns must match the visible text —
 * without this, an error on the first line of a BOM-prefixed document would
 * point one column too far right (pinned in `parse.test.ts`).
 */
export function makeLineIndex(source: string): readonly number[] {
  const starts = [source.charCodeAt(0) === 0xfeff ? 1 : 0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  }
  return starts
}

/** 1-based line/column of a character offset (clamped into the source; column ≥ 1). */
export function offsetToLineCol(
  lineIndex: readonly number[],
  offset: number,
): { readonly line: number; readonly column: number } {
  const o = Math.max(0, Math.floor(offset))
  // Binary search for the last line start ≤ offset.
  let lo = 0
  let hi = lineIndex.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((lineIndex[mid] as number) <= o) lo = mid
    else hi = mid - 1
  }
  // The clamp keeps degenerate offsets (e.g. a node without a range, mapped
  // to 0) on line 1 even when a BOM shifted line 1's start past them.
  return { line: lo + 1, column: Math.max(1, o - (lineIndex[lo] as number) + 1) }
}

interface WalkContext {
  readonly doc: Document
  /** The original source text — literals are sliced from it for exactness checks. */
  readonly source: string
  readonly lineIndex: readonly number[]
  readonly errors: ContractError[]
}

/** One mapping entry: the plain-text key and its (unresolved) value node. */
interface Entry {
  readonly key: string
  readonly keyNode: Scalar
  readonly valueNode: YamlNode
}

function pushError(
  ctx: WalkContext,
  code: ContractErrorCode,
  message: string,
  path: string,
  node: YamlNode,
): void {
  const offset = nodeOffset(node)
  const { line, column } = offsetToLineCol(ctx.lineIndex, offset)
  ctx.errors.push({ code, message, path, line, column })
}

/** First offset of a node (0 when the node carries no range — degenerate input). */
function nodeOffset(node: YamlNode): number {
  const range = node?.range
  return typeof range?.[0] === 'number' ? range[0] : 0
}

/**
 * The source text a scalar was written as (the literal, tags excluded by the
 * parser's node ranges). `null` when the node carries no range — the same
 * degenerate default {@link nodeOffset} falls back to; no numeric rule value
 * reaches the exactness check through such a node in practice.
 *
 * Because the tag sits outside the sliced text, an explicit standard tag
 * (`!!int 5`, `!!float 1.5`) is verified by its *content* literal under the
 * same gate as the plain spelling (deliberate, pinned in `parse.test.ts`):
 * content that is not a plain decimal (`!!int 0x1F`) is unverifiable and
 * rejected, and unresolvable tags never reach here (library warnings are
 * `yaml-syntax` errors).
 */
function rawScalarText(ctx: WalkContext, node: YamlNode): string | null {
  const range = node?.range
  return typeof range?.[0] === 'number' && typeof range?.[1] === 'number'
    ? ctx.source.slice(range[0], range[1])
    : null
}

/** Position node for value errors: the value, falling back to the key. */
function valuePosition(entry: Entry, resolved: YamlNode): YamlNode {
  return resolved ?? entry.keyNode
}

/** Resolve aliases to their target node (positions then come from the anchor). */
function resolveNode(ctx: WalkContext, node: YamlNode): YamlNode {
  if (node !== null && isAlias(node)) {
    try {
      return (node.resolve(ctx.doc) as YamlNode) ?? null
    } catch {
      // Resolve does not throw for documents that parsed; defensive only.
      return null
    }
  }
  return node
}

/**
 * Collect a mapping's entries, rejecting non-string keys (`unknown-key`) and
 * duplicate keys (`duplicate-key`, pointing at each repeat occurrence).
 * Returns key → first occurrence, in source order; `null` if not a mapping.
 */
function collectEntries(ctx: WalkContext, node: YamlNode, path: string): Map<string, Entry> | null {
  if (node === null || !isMap(node)) return null
  const entries = new Map<string, Entry>()
  for (const pair of node.items) {
    const keyNode = pair.key
    if (!isNode(keyNode)) {
      pushError(ctx, 'unknown-key', `mapping keys must be plain text identifiers`, path, null)
      continue
    }
    if (!isScalar(keyNode) || typeof keyNode.value !== 'string') {
      pushError(
        ctx,
        'unknown-key',
        `mapping keys must be plain text identifiers; got ${describeYamlValue(keyNode as YamlNode)}`,
        path,
        keyNode as YamlNode,
      )
      continue
    }
    const existing = entries.get(keyNode.value)
    if (existing !== undefined) {
      pushError(
        ctx,
        'duplicate-key',
        `duplicate key "${keyNode.value}" — each key may appear at most once in "${path}"`,
        path,
        keyNode,
      )
      continue
    }
    const valueNode: YamlNode = isNode(pair.value) ? (pair.value as YamlNode) : null
    entries.set(keyNode.value, { key: keyNode.value, keyNode, valueNode })
  }
  return entries
}

type ScalarKind = 'string' | 'number' | 'boolean' | 'null' | 'other'

function scalarKind(node: YamlNode): { kind: ScalarKind; value?: string | number | boolean } {
  if (node === null || !isScalar(node)) return { kind: node === null ? 'null' : 'other' }
  const value = node.value
  if (value === null || value === undefined) return { kind: 'null' }
  if (typeof value === 'string') return { kind: 'string', value }
  if (typeof value === 'number') return { kind: 'number', value }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  return { kind: 'other' } // tagged scalars (e.g. !!binary) — unusable as rule values
}

/** Human description of a YAML value for error messages ("the string \"yes\"", "a mapping", …). */
function describeYamlValue(node: YamlNode): string {
  if (node === null) return 'an empty value (null)'
  if (isMap(node)) return 'a mapping'
  if (isSeq(node)) return 'a sequence'
  const { kind, value } = scalarKind(node)
  switch (kind) {
    case 'null':
      return 'null (an empty value)'
    case 'string':
      return `the string ${JSON.stringify(value)}`
    case 'number': {
      const n = value as number
      if (Number.isNaN(n)) return 'NaN (.nan)'
      if (!Number.isFinite(n))
        return n > 0 ? 'positive infinity (.inf)' : 'negative infinity (-.inf)'
      return `the number ${String(n)}`
    }
    case 'boolean':
      return `the boolean ${String(value)}`
    case 'other':
      return 'a non-plain scalar (tagged/binary data)'
  }
}

/**
 * The exactness gate for every numeric rule value (see `numeric.ts` for the
 * policy: exact or rejected). Pushes an `imprecise-number` error and returns
 * `false` when the written literal would not survive the YAML→number parse
 * byte-honestly, or is a spelling whose exact value cannot be verified.
 * `node` is the (already alias-resolved) scalar the number was read from.
 * Runs *before* domain checks so a corrupted literal is reported as such,
 * not masked by an error naming the already-rounded value. The message
 * quotes the **raw source literal only** — never the rounded double the
 * parse produced: telling an author that their written `9007199254740993`
 * "is" `9007199254740992` would report a value that appears nowhere in the
 * document, which is the very corruption this gate refuses (pinned in
 * `parse.test.ts`).
 */
function rejectImpreciseNumber(
  ctx: WalkContext,
  node: YamlNode,
  value: number,
  path: string,
): boolean {
  const raw = rawScalarText(ctx, node)
  if (raw === null) return true // no literal to verify; nodeOffset's degenerate default
  if (isExactDecimalLiteral(raw, value)) return true
  const unverifiable = canonicalDecimal(raw) === null
  pushError(
    ctx,
    'imprecise-number',
    unverifiable
      ? `${path}: cannot verify the exact value of ${JSON.stringify(raw)} — write rule numbers as plain decimal literals (e.g. 1.5)`
      : `${path}: the written number ${raw} would be silently altered by the YAML→number parse — rule numbers must be exactly representable (v1 has no arbitrary-precision numbers); write a plain decimal that survives the round-trip, e.g. integers within ±2^53`,
    path,
    node,
  )
  return false
}

/**
 * m5-0's canonical ±0 rule: `-0` and `0` are one value. `literals.ts`
 * renders `-0` as `0`, `json-schema.ts` normalizes `-0`, and the canonical
 * serializer must too — otherwise `min: -0` and `min: 0` would be two
 * shapes for one meaning (AR-V5). Applied at every numeric read site.
 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value
}

function wantString(ctx: WalkContext, entry: Entry, path: string): string | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'string') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a string, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  const text = value as string
  // NUL is unbindable in SQL text (and unrepresentable in a plan). Rejecting
  // it here keeps the parser's output inside the compiler's valid domain —
  // without this, a parsed contract could reach `invalid-contract-input`,
  // contradicting that code's "parseContract output can never trigger this"
  // doc (AR-V2).
  if (text.includes('\u0000')) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: must not contain a NUL character (it cannot be bound to SQL text)`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  return text
}

function wantBoolean(ctx: WalkContext, entry: Entry, path: string): boolean | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'boolean') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected true or false, got ${describeYamlValue(resolved)} — this format follows YAML 1.2, so booleans are spelled true/false`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  return value as boolean
}

/** A finite number (NaN/.inf rejected — not meaningful bounds or shares). */
function wantFiniteNumber(ctx: WalkContext, entry: Entry, path: string): number | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'number') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a number, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  const n = value as number
  if (!Number.isFinite(n)) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: expected a finite number, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  if (!rejectImpreciseNumber(ctx, resolved, n, path)) return null
  return normalizeZero(n)
}

/** A finite number in [0, 1] (the two share rules). */
function wantShare(ctx: WalkContext, entry: Entry, path: string): number | null {
  const n = wantFiniteNumber(ctx, entry, path)
  if (n === null) return null
  if (n < 0 || n > 1) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: expected a share between 0 and 1, got ${String(n)}`,
      path,
      valuePosition(entry, resolveNode(ctx, entry.valueNode)),
    )
    return null
  }
  return n
}

function wantPositiveInteger(ctx: WalkContext, entry: Entry, path: string): number | null {
  return wantInteger(ctx, entry, path, 'a positive integer', 1)
}

function wantNonNegativeInteger(ctx: WalkContext, entry: Entry, path: string): number | null {
  return wantInteger(ctx, entry, path, 'a non-negative integer', 0)
}

function wantInteger(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  label: string,
  minimum: number,
): number | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'number') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected ${label}, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  const n = value as number
  // Exactness first: a 17th-digit literal arrives already rounded, and the
  // generic message below would name the rounded value as if the author
  // wrote it — the imprecise-number error is the honest report.
  if (!rejectImpreciseNumber(ctx, resolved, n, path)) return null
  if (!Number.isSafeInteger(n) || n < minimum) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: expected ${label}, got ${String(n)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  return normalizeZero(n)
}

/** Unknown-key message with a misplaced-key hint when the key is legal somewhere else. */
function unknownKeyMessage(key: string, where: string, knownKeys: readonly string[]): string {
  // Own-property only: `key` is user-written YAML, and a plain-record index
  // would inherit `Object.prototype` members — `toString:`/`__proto__:` keys
  // would otherwise find inherited values and crash the message builder
  // (`.join` on a function), breaking the never-throws promise. Pinned.
  const locations = Object.hasOwn(KEY_LOCATIONS, key) ? KEY_LOCATIONS[key] : undefined
  if (locations !== undefined) {
    return `unknown key "${key}" ${where}; "${key}" is valid only in ${locations.join(' and ')}`
  }
  return `unknown key "${key}" ${where}; expected one of: ${knownKeys.join(', ')}`
}

interface RootBuild {
  name?: string
  version?: number
  description?: string
  columns?: ColumnRuleSet[]
  dataset?: DatasetRuleSet
}

/**
 * Validate a parsed document and build its contract. Returns the built
 * contract only when no errors were collected.
 */
export function validateContractDocument(
  doc: Document,
  source: string,
): { contract?: ContractV1; errors: readonly ContractError[] } {
  const ctx: WalkContext = { doc, source, lineIndex: makeLineIndex(source), errors: [] }
  const build = walkRoot(ctx, doc.contents as YamlNode)
  if (ctx.errors.length > 0 || build === null) return { errors: ctx.errors }
  // Unreachable with undefined name/version: a missing or invalid one always
  // collected an error above, so the early return already fired.
  const metadata: { name: string; version: number; description?: string } = {
    name: build.name as string,
    version: build.version as number,
  }
  if (build.description !== undefined) metadata.description = build.description
  const contract: ContractV1 = {
    format: CONTRACT_FORMAT,
    metadata,
    columns: build.columns ?? [],
    ...(build.dataset !== undefined ? { dataset: build.dataset } : {}),
  }
  return { contract, errors: ctx.errors }
}

function walkRoot(ctx: WalkContext, root: YamlNode): RootBuild | null {
  if (root === null) {
    pushError(
      ctx,
      'wrong-type',
      'the document is empty — expected a contract mapping starting with "format: v1"',
      ROOT_PATH,
      null,
    )
    return null
  }
  if (!isMap(root)) {
    pushError(
      ctx,
      'wrong-type',
      `the contract document must be a YAML mapping, got ${describeYamlValue(root)}`,
      ROOT_PATH,
      root,
    )
    return null
  }
  const entries = collectEntries(ctx, root, ROOT_PATH)
  if (entries === null) return null
  const seen = new Set<object>([root])

  // `format` decides whether the rest of the document may be interpreted at
  // all: any other version is reported alone instead of guessed at.
  const formatEntry = entries.get('format')
  if (formatEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing required key "format" — add "format: v1" (the only supported contract format)',
      ROOT_PATH,
      root,
    )
  } else {
    const format = wantString(ctx, formatEntry, 'format')
    if (format !== null && format !== CONTRACT_FORMAT) {
      pushError(
        ctx,
        'unsupported-format',
        `unsupported contract format ${JSON.stringify(format)} — this parser implements "${CONTRACT_FORMAT}" only`,
        'format',
        formatEntry.valueNode,
      )
      return null
    }
  }

  const build: RootBuild = {}
  for (const [key, entry] of entries) {
    if (key === 'format') continue // handled above
    const path = key
    switch (key) {
      case 'name': {
        const name = wantString(ctx, entry, path)
        if (name !== null) {
          if (name.length === 0) {
            pushError(
              ctx,
              'out-of-range',
              'name: must be a non-empty string',
              path,
              entry.valueNode,
            )
          } else {
            build.name = name
          }
        }
        break
      }
      case 'version': {
        const version = wantPositiveInteger(ctx, entry, path)
        if (version !== null) build.version = version
        break
      }
      case 'description': {
        const description = wantString(ctx, entry, path)
        if (description !== null && description !== '') build.description = description // '' ⇒ absent (canonical normalization)
        break
      }
      case 'columns': {
        build.columns = walkColumns(ctx, entry, seen)
        break
      }
      case 'dataset': {
        build.dataset = walkDataset(ctx, entry, seen)
        break
      }
      default:
        pushError(
          ctx,
          'unknown-key',
          unknownKeyMessage(key, 'at the document root', ROOT_KEYS),
          ROOT_PATH,
          entry.keyNode,
        )
    }
  }

  if (!entries.has('name')) {
    pushError(
      ctx,
      'missing-key',
      'missing required key "name" — the contract\'s human identifier',
      ROOT_PATH,
      root,
    )
  }
  if (!entries.has('version')) {
    pushError(
      ctx,
      'missing-key',
      'missing required key "version" — a positive integer identifying the contract\'s revision (not the format version)',
      ROOT_PATH,
      root,
    )
  }
  return build
}

function walkColumns(ctx: WalkContext, entry: Entry, parentSeen: Set<object>): ColumnRuleSet[] {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null) {
    pushError(
      ctx,
      'wrong-type',
      'columns: expected a list of column rule mappings, got null (an empty value) — omit the key entirely for no column rules',
      'columns',
      entry.keyNode,
    )
    return []
  }
  if (!isSeq(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `columns: expected a list of column rule mappings, got ${describeYamlValue(resolved)}`,
      'columns',
      resolved,
    )
    return []
  }
  if (parentSeen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      'columns: recursively anchored value (an alias cycle) — contract documents cannot contain alias cycles',
      'columns',
      resolved,
    )
    return []
  }
  const seen = new Set([...parentSeen, resolved])
  const columns: ColumnRuleSet[] = []
  const namedAt = new Map<string, number>()
  const items: readonly YamlNode[] = resolved.items as readonly YamlNode[]
  for (let index = 0; index < items.length; index++) {
    const path = `columns[${index}]`
    const itemResolved = resolveNode(ctx, items[index] ?? null)
    if (itemResolved !== null && seen.has(itemResolved)) {
      pushError(
        ctx,
        'yaml-syntax',
        `${path}: recursively anchored value (an alias cycle) — contract documents cannot contain alias cycles`,
        path,
        itemResolved,
      )
      continue
    }
    const column = walkColumn(ctx, itemResolved, path, seen)
    if (column === null) continue
    const firstIndex = namedAt.get(column.name)
    if (firstIndex !== undefined) {
      pushError(
        ctx,
        'duplicate-key',
        `duplicate column name ${JSON.stringify(column.name)} — columns[${firstIndex}] already declares it; each column may appear at most once`,
        path,
        itemResolved,
      )
      continue
    }
    namedAt.set(column.name, index)
    // A rule-less entry (only a name) constrains nothing, so canonical
    // normalization drops it — one shape per meaning (see the ast.ts module
    // doc). Duplicate-name rejection above still saw it: declaring a column
    // twice is an authoring error even when one entry is empty.
    if (!hasDeclaredRule(column)) continue
    columns.push(column)
  }
  return columns
}

/** Does this rule set carry at least one rule (anything beyond `name`)? */
function hasDeclaredRule(column: ColumnRuleSet): boolean {
  return (
    column.type !== undefined ||
    column.required !== undefined ||
    column.unique !== undefined ||
    column.min !== undefined ||
    column.max !== undefined ||
    column.allowedValues !== undefined ||
    column.regex !== undefined ||
    column.maxNullShare !== undefined ||
    column.minDistinctShare !== undefined
  )
}

function walkColumn(
  ctx: WalkContext,
  node: YamlNode,
  path: string,
  parentSeen: Set<object>,
): ColumnRuleSet | null {
  if (node === null || !isMap(node)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a column rule mapping, got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  const seen = new Set([...parentSeen, node])
  const entries = collectEntries(ctx, node, path)
  if (entries === null) return null

  // Rule values, plus the node needed to point the min>max cross-check at
  // the offending bound (reported at the `max` value).
  const build: {
    name: string
    type?: ContractTypeSpelling
    required?: true
    unique?: true
    min?: number
    max?: number
    allowedValues?: readonly (string | number | boolean)[]
    regex?: string
    maxNullShare?: number
    minDistinctShare?: number
  } = { name: '' }
  let maxValue: number | undefined
  let maxNode: YamlNode = null
  for (const [key, keyEntry] of entries) {
    const fieldPath = `${path}.${key}`
    switch (key) {
      case 'name': {
        const name = wantString(ctx, keyEntry, fieldPath)
        if (name !== null) {
          if (name.length === 0) {
            pushError(
              ctx,
              'out-of-range',
              `${fieldPath}: must be a non-empty string`,
              fieldPath,
              keyEntry.valueNode,
            )
          } else {
            build.name = name
          }
        }
        break
      }
      case 'type': {
        const spelling = wantString(ctx, keyEntry, fieldPath)
        if (spelling !== null) {
          if (!isKnownContractType(spelling)) {
            const hint = contractTypeHint(spelling)
            pushError(
              ctx,
              'unknown-type',
              `${fieldPath}: unknown declared type ${JSON.stringify(spelling)} — not in CONTRACT_TYPE_VOCABULARY (the v1 vocabulary)${
                hint !== null ? `; did you mean "${hint}"?` : ''
              }`,
              fieldPath,
              keyEntry.valueNode,
            )
          } else {
            build.type = spelling
          }
        }
        break
      }
      case 'required': {
        const required = wantBoolean(ctx, keyEntry, fieldPath)
        if (required === true) build.required = true // false ⇒ absent (canonical normalization)
        break
      }
      case 'unique': {
        const unique = wantBoolean(ctx, keyEntry, fieldPath)
        if (unique === true) build.unique = true // false ⇒ absent (canonical normalization)
        break
      }
      case 'min': {
        const min = wantFiniteNumber(ctx, keyEntry, fieldPath)
        if (min !== null) build.min = min
        break
      }
      case 'max': {
        const max = wantFiniteNumber(ctx, keyEntry, fieldPath)
        if (max !== null) {
          build.max = max
          maxValue = max
          maxNode = keyEntry.valueNode
        }
        break
      }
      case 'allowed-values': {
        const values = walkAllowedValues(ctx, keyEntry, fieldPath, seen)
        if (values !== null) build.allowedValues = values
        break
      }
      case 'regex': {
        const regex = wantString(ctx, keyEntry, fieldPath)
        if (regex !== null) build.regex = regex
        break
      }
      case 'max-null-share': {
        const share = wantShare(ctx, keyEntry, fieldPath)
        if (share !== null) build.maxNullShare = share
        break
      }
      case 'min-distinct-share': {
        const share = wantShare(ctx, keyEntry, fieldPath)
        if (share !== null) build.minDistinctShare = share
        break
      }
      default:
        pushError(
          ctx,
          'unknown-key',
          unknownKeyMessage(key, `in the rule set at "${path}"`, COLUMN_KEYS),
          path,
          keyEntry.keyNode,
        )
    }
  }

  if (!entries.has('name')) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "name" — the dataset column this rule set addresses`,
      path,
      node,
    )
    return null
  }
  if (build.name.length === 0) return null // name present but invalid — already reported

  const minValue = build.min
  if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) {
    pushError(
      ctx,
      'out-of-range',
      `${path}.max: max (${String(maxValue)}) must be ≥ min (${String(minValue)})`,
      `${path}.max`,
      maxNode ?? node,
    )
  }
  return {
    name: build.name,
    ...(build.type !== undefined ? { type: build.type } : {}),
    ...(build.required !== undefined ? { required: build.required } : {}),
    ...(build.unique !== undefined ? { unique: build.unique } : {}),
    ...(build.min !== undefined ? { min: build.min } : {}),
    ...(build.max !== undefined ? { max: build.max } : {}),
    ...(build.allowedValues !== undefined ? { allowedValues: build.allowedValues } : {}),
    ...(build.regex !== undefined ? { regex: build.regex } : {}),
    ...(build.maxNullShare !== undefined ? { maxNullShare: build.maxNullShare } : {}),
    ...(build.minDistinctShare !== undefined ? { minDistinctShare: build.minDistinctShare } : {}),
  }
}

function walkAllowedValues(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  parentSeen: Set<object>,
): readonly (string | number | boolean)[] | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null || !isSeq(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a list of scalar values, got ${describeYamlValue(resolved)} — an empty list is allowed (it rejects every non-NULL value)`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  if (parentSeen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      `${path}: recursively anchored value (an alias cycle) — contract documents cannot contain alias cycles`,
      path,
      resolved,
    )
    return null
  }
  const values: (string | number | boolean)[] = []
  const items: readonly YamlNode[] = resolved.items as readonly YamlNode[]
  for (let index = 0; index < items.length; index++) {
    const itemPath = `${path}[${index}]`
    const itemResolved = resolveNode(ctx, items[index] ?? null)
    const { kind, value } = scalarKind(itemResolved)
    if (kind === 'string') {
      const text = value as string
      if (text.includes('\u0000')) {
        pushError(
          ctx,
          'out-of-range',
          `${itemPath}: must not contain a NUL character (it cannot be bound to SQL text)`,
          itemPath,
          itemResolved,
        )
        continue
      }
      values.push(text)
    } else if (kind === 'boolean') {
      values.push(value as boolean)
    } else if (kind === 'number' && Number.isFinite(value as number)) {
      if (!rejectImpreciseNumber(ctx, itemResolved, value as number, itemPath)) continue
      values.push(normalizeZero(value as number))
    } else {
      pushError(
        ctx,
        'wrong-type',
        `${itemPath}: allowed-values entries must be strings, finite numbers, or booleans, got ${describeYamlValue(
          itemResolved,
        )}${kind === 'null' ? ' — null membership is not expressible; govern nullness with "required" / "max-null-share" instead' : ''}`,
        itemPath,
        itemResolved,
      )
    }
  }
  return values
}

function walkDataset(
  ctx: WalkContext,
  entry: Entry,
  parentSeen: Set<object>,
): DatasetRuleSet | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null) {
    pushError(
      ctx,
      'wrong-type',
      'dataset: expected a rule mapping (min-rows / max-rows), got null (an empty value) — omit the key entirely for no dataset rules',
      'dataset',
      entry.keyNode,
    )
    return undefined
  }
  if (!isMap(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `dataset: expected a rule mapping (min-rows / max-rows), got ${describeYamlValue(resolved)}`,
      'dataset',
      resolved,
    )
    return undefined
  }
  if (parentSeen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      'dataset: recursively anchored value (an alias cycle) — contract documents cannot contain alias cycles',
      'dataset',
      resolved,
    )
    return undefined
  }
  const entries = collectEntries(ctx, resolved, 'dataset')
  if (entries === null) return undefined
  const build: { minRows?: number; maxRows?: number } = {}
  let maxRowsNode: YamlNode = null
  for (const [key, keyEntry] of entries) {
    const fieldPath = `dataset.${key}`
    switch (key) {
      case 'min-rows': {
        const minRows = wantNonNegativeInteger(ctx, keyEntry, fieldPath)
        if (minRows !== null) build.minRows = minRows
        break
      }
      case 'max-rows': {
        const maxRows = wantNonNegativeInteger(ctx, keyEntry, fieldPath)
        if (maxRows !== null) {
          build.maxRows = maxRows
          maxRowsNode = keyEntry.valueNode
        }
        break
      }
      default:
        pushError(
          ctx,
          'unknown-key',
          unknownKeyMessage(key, 'in the "dataset" mapping', DATASET_KEYS),
          'dataset',
          keyEntry.keyNode,
        )
    }
  }
  const { minRows, maxRows } = build
  if (minRows !== undefined && maxRows !== undefined && minRows > maxRows) {
    pushError(
      ctx,
      'out-of-range',
      `dataset.max-rows: max-rows (${String(maxRows)}) must be ≥ min-rows (${String(minRows)})`,
      'dataset.max-rows',
      maxRowsNode ?? resolved,
    )
  }
  // A rule-less `dataset: {}` normalizes to absent (canonical normalization).
  if (minRows === undefined && maxRows === undefined) return undefined
  return {
    ...(minRows !== undefined ? { minRows } : {}),
    ...(maxRows !== undefined ? { maxRows } : {}),
  }
}
