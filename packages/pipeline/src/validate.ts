// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline document validation (p-1): the walk from a parsed YAML document to
 * a {@link PipelineV1}, rejecting everything the v1 format does not explicitly
 * allow.
 *
 * The honesty bar mirrors `@assay/contracts`: unknown and misplaced YAML keys
 * are rejected with typed errors — never silently dropped — as are duplicate
 * keys, unknown node classes, wrong value types, and out-of-range values. The
 * walk collects *all* independent errors per document, with two deliberate
 * stops:
 *
 * 1. YAML syntax problems (including library warnings, which mean something
 *    was silently coerced) — the structure is unreliable, so only those are
 *    reported.
 * 2. `version` naming a version other than 1 — reported alone rather than
 *    guessing what another version's keys would mean.
 *
 * Node bodies are interpreted per class:
 * - `source`/`transform`/`sql` are fully typed (P1 executable classes), and
 *   each accepts an optional `materialization` mode (ADR 0033; p2-2);
 * - `validate`/`publish` are typed to the shapes architecture §5 settles but
 *   carry no execution semantics (P2);
 * - `diff` is typed to the p2-2 settled shape (`input` + `against`, both
 *   table references) — the opaque-body era is over.
 *
 * Two p-2 format tightenings live here:
 * - **exact-or-rejected numbers** — every number in the IR (generic configs
 *   and `version`) passes the reused `@assay/contracts` gate, so a written
 *   literal can never be silently altered before it becomes SQL-bearing;
 * - **reserved namespace** — a node id prefixed `assay_` (case-insensitive;
 *   DuckDB folds identifier case) is rejected because node ids become
 *   relation names and `assay_*` is reserved repo-wide for compiler
 *   internals, which verbatim SQL cannot rename around.
 *
 * Not part of the public surface: positions come from YAML nodes, so
 * validation is exercised through `parsePipeline`.
 *
 * Purity: no React, no browser APIs, no engine, no `@assay/*` imports beyond
 * the allowed set (lint-enforced).
 */
import { isAlias, isMap, isNode, isScalar, isSeq } from 'yaml'
import type { Alias, Document, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import { canonicalDecimal, isExactDecimalLiteral } from '@assay/contracts'
import {
  PIPELINE_IR_VERSION,
  canonicalNodeOrder,
  isMaterializationMode,
  isPipelineNodeClass,
} from './ast.js'
import type {
  DiffNode,
  MaterializationMode,
  OperationConfig,
  PipelineMap,
  PipelineNode,
  PipelineV1,
  PipelineValue,
  PublishNode,
  SourceConfig,
  SourceNode,
  SqlNode,
  TransformNode,
  ValidateNode,
} from './ast.js'
import type { PipelineError, PipelineErrorCode } from './errors.js'

/** Any parsed YAML node (or absence). */
type YamlNode = Alias | Scalar | YAMLMap | YAMLSeq | null

/** Path of the document root in `PipelineError.path`. */
const ROOT_PATH = 'document'

const ROOT_KEYS = ['version', 'pipeline', 'nodes'] as const
const SOURCE_NODE_KEYS = ['type', 'materialization', 'source'] as const
const TRANSFORM_NODE_KEYS = ['type', 'materialization', 'inputs', 'operation'] as const
const SQL_NODE_KEYS = ['type', 'materialization', 'inputs', 'sql'] as const
const VALIDATE_NODE_KEYS = ['type', 'input', 'contract'] as const
const PUBLISH_NODE_KEYS = ['type', 'input', 'requires'] as const
const DIFF_NODE_KEYS = ['type', 'input', 'against'] as const

/**
 * Where each YAML key is legal — powers the "misplaced key" hint on
 * unknown-key errors.
 */
const KEY_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  version: ['the document root'],
  pipeline: ['the document root'],
  nodes: ['the document root'],
  type: ['a pipeline node'],
  materialization: ['a source, transform, or sql node'],
  source: ['a source node'],
  inputs: ['a transform or sql node'],
  operation: ['a transform node'],
  sql: ['a sql node'],
  input: ['a validate, diff, or publish node'],
  contract: ['a validate node'],
  requires: ['a publish node'],
  against: ['a diff node'],
}

/**
 * 1-based line start offsets of a source (index 0 = start of line 1). A
 * leading BOM counts as before line 1 (editors render it invisibly), matching
 * the contracts parser.
 */
export function makeLineIndex(source: string): readonly number[] {
  const starts = [source.charCodeAt(0) === 0xfeff ? 1 : 0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  }
  return starts
}

/** 1-based line/column of a character offset (clamped into the source). */
export function offsetToLineCol(
  lineIndex: readonly number[],
  offset: number,
): { readonly line: number; readonly column: number } {
  const o = Math.max(0, Math.floor(offset))
  let lo = 0
  let hi = lineIndex.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((lineIndex[mid] as number) <= o) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: Math.max(1, o - (lineIndex[lo] as number) + 1) }
}

interface WalkContext {
  readonly doc: Document
  /** The original source text (kept for symmetry with contracts; positions use ranges). */
  readonly source: string
  readonly lineIndex: readonly number[]
  readonly errors: PipelineError[]
}

/** One mapping entry: the plain-text key and its (unresolved) value node. */
interface Entry {
  readonly key: string
  readonly keyNode: Scalar
  readonly valueNode: YamlNode
}

function pushError(
  ctx: WalkContext,
  code: PipelineErrorCode,
  message: string,
  path: string,
  node: YamlNode,
  nodeId?: string,
): void {
  const offset = nodeOffset(node)
  const { line, column } = offsetToLineCol(ctx.lineIndex, offset)
  ctx.errors.push({
    code,
    message,
    path,
    line,
    column,
    ...(nodeId !== undefined ? { nodeId } : {}),
  })
}

/** First offset of a node (0 when the node carries no range — degenerate input). */
function nodeOffset(node: YamlNode): number {
  const range = node?.range
  return typeof range?.[0] === 'number' ? range[0] : 0
}

/**
 * The source text a scalar was written as (tags are excluded by the parser's
 * node ranges). `null` when the node carries no range — the same degenerate
 * default {@link nodeOffset} falls back to. Mirrors the `@assay/contracts`
 * contract parser: the exactness gate judges the *content* literal, so a
 * library-resolvable tag (`!!int 5`) is verified by its content.
 */
function rawScalarText(ctx: WalkContext, node: YamlNode): string | null {
  const range = node?.range
  return typeof range?.[0] === 'number' && typeof range?.[1] === 'number'
    ? ctx.source.slice(range[0], range[1])
    : null
}

/**
 * The exact-or-rejected numeric gate for **every** number in the IR (p-2;
 * reuses `@assay/contracts`' canonical policy — see `numeric.ts` there). A
 * written literal is accepted only when the double it parses to denotes the
 * same decimal the author wrote; otherwise the parse would silently alter
 * the document (the live `9007199254740993` → `…992` rewrite), and
 * operation numbers can become SQL-bearing in p-2's compiler. The message
 * quotes the **raw source literal only** — never the rounded double the
 * parse produced.
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
      ? `${path}: cannot verify the exact value of ${JSON.stringify(raw)} — write pipeline numbers as plain decimal literals (e.g. 1.5)`
      : `${path}: the written number ${raw} would be silently altered by the YAML→number parse — pipeline numbers must be exactly representable; write a plain decimal that survives the round-trip, e.g. integers within ±2^53`,
    path,
    node,
  )
  return false
}

/** Resolve aliases to their target node (positions then come from the anchor). */
function resolveNode(ctx: WalkContext, node: YamlNode): YamlNode {
  if (node !== null && isAlias(node)) {
    try {
      return (node.resolve(ctx.doc) as YamlNode) ?? null
    } catch (error) {
      // Deep alias nesting overflows the YAML resolver's recursion and throws
      // a RangeError (the "Maximum call stack size exceeded" case). That is a
      // resource-limit failure, not a malformed document the total parser owns
      // — re-throw it so it stays a hard failure instead of degrading to an
      // innocuous-looking null node. Every other resolver failure (an
      // unresolvable alias) degrades to null and is reported as a located error
      // by the caller.
      if (error instanceof RangeError) throw error
      return null
    }
  }
  return node
}

/**
 * Collect a mapping's entries, rejecting non-string keys and duplicate keys.
 * Returns key → first occurrence in source order; `null` if not a mapping.
 */
function collectEntries(ctx: WalkContext, node: YamlNode, path: string): Map<string, Entry> | null {
  if (node === null || !isMap(node)) return null
  const entries = new Map<string, Entry>()
  for (const pair of node.items) {
    const keyNode = pair.key
    if (!isNode(keyNode)) {
      pushError(ctx, 'unknown-key', 'mapping keys must be plain text identifiers', path, null)
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
  return { kind: 'other' }
}

/** Human description of a YAML value for error messages. */
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

/** Position node for value errors: the value, falling back to the key. */
function valuePosition(entry: Entry, resolved: YamlNode): YamlNode {
  return resolved ?? entry.keyNode
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

/** A required non-empty string. */
function wantNonEmptyString(ctx: WalkContext, entry: Entry, path: string): string | null {
  const text = wantString(ctx, entry, path)
  if (text === null) return null
  if (text.length === 0) {
    pushError(ctx, 'out-of-range', `${path}: must be a non-empty string`, path, entry.valueNode)
    return null
  }
  return text
}

/**
 * Read an optional data-node `materialization` mode (ADR 0033; p2-2). The
 * seven mode strings are exact (case-sensitive, no surrounding whitespace);
 * the default `view` normalizes to absent so the AST keeps one shape per
 * meaning. A mistyped or misspelled key never reaches here — it is an
 * unknown key (see `rejectUnknownKeys`).
 */
function walkMaterialization(
  ctx: WalkContext,
  entry: Entry,
  path: string,
): MaterializationMode | undefined {
  const resolved = resolveNode(ctx, entry.valueNode)
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'string') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a materialization mode (one of: ephemeral, view, table, cache, incremental, export, publish), got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  const text = value as string
  if (!isMaterializationMode(text)) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: unknown materialization mode ${JSON.stringify(text)} — expected one of: ephemeral, view, table, cache, incremental, export, publish`,
      path,
      valuePosition(entry, resolved),
    )
    return undefined
  }
  // The default is spelled by absence (one shape per meaning).
  return text === 'view' ? undefined : text
}

/** The node's optional `materialization` mode, or `undefined` when absent. */
function readMaterialization(
  ctx: WalkContext,
  entries: Map<string, Entry>,
  path: string,
): MaterializationMode | undefined {
  const entry = entries.get('materialization')
  return entry === undefined
    ? undefined
    : walkMaterialization(ctx, entry, `${path}.materialization`)
}

/** A finite number (NaN/.inf rejected — generic config carries no honest infinities). */
function readFiniteNumber(ctx: WalkContext, resolved: YamlNode, path: string): number | undefined {
  const { kind, value } = scalarKind(resolved)
  if (kind !== 'number') {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a number, got ${describeYamlValue(resolved)}`,
      path,
      resolved,
    )
    return undefined
  }
  const n = value as number
  if (!Number.isFinite(n)) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: expected a finite number, got ${describeYamlValue(resolved)}`,
      path,
      resolved,
    )
    return undefined
  }
  if (!rejectImpreciseNumber(ctx, resolved, n, path)) return undefined
  // Canonical ±0 rule (mirrors m5-0): -0 and 0 are one value.
  return n === 0 ? 0 : n
}

/**
 * A horizontal list of table/gate references: a sequence of non-empty,
 * NUL-free strings, with no duplicate entry within the list. An absent list
 * is handled by the caller.
 */
function wantReferenceList(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  seen: Set<object>,
): string[] | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null || !isSeq(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a list of node references, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  if (seen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      `${path}: recursively anchored value (an alias cycle) — pipeline documents cannot contain alias cycles`,
      path,
      resolved,
    )
    return null
  }
  const childSeen = new Set([...seen, resolved])
  const items: readonly YamlNode[] = resolved.items as readonly YamlNode[]
  const refs: string[] = []
  const seenRefs = new Set<string>()
  for (let index = 0; index < items.length; index++) {
    const itemPath = `${path}[${index}]`
    const itemResolved = resolveNode(ctx, items[index] ?? null)
    if (itemResolved !== null && childSeen.has(itemResolved)) {
      pushError(
        ctx,
        'yaml-syntax',
        `${itemPath}: recursively anchored value (an alias cycle) — pipeline documents cannot contain alias cycles`,
        itemPath,
        itemResolved,
      )
      continue
    }
    const ref = readReference(ctx, itemResolved, itemPath)
    if (ref === null) continue
    if (seenRefs.has(ref)) {
      pushError(
        ctx,
        'duplicate-reference',
        `${itemPath}: duplicate reference ${JSON.stringify(ref)} — an input/gate may be listed at most once`,
        itemPath,
        itemResolved,
      )
      continue
    }
    seenRefs.add(ref)
    refs.push(ref)
  }
  return refs
}

/** Read one node reference: a non-empty, NUL-free string. */
function readReference(ctx: WalkContext, node: YamlNode, path: string): string | null {
  const { kind, value } = scalarKind(node)
  if (kind !== 'string') {
    pushError(
      ctx,
      'invalid-reference',
      `${path}: expected a node reference (a string), got ${describeYamlValue(node)}`,
      path,
      node,
    )
    return null
  }
  const text = value as string
  if (text.length === 0) {
    pushError(ctx, 'invalid-reference', `${path}: a node reference must be non-empty`, path, node)
    return null
  }
  if (text.includes('\u0000')) {
    pushError(
      ctx,
      'invalid-reference',
      `${path}: a node reference must not contain a NUL character`,
      path,
      node,
    )
    return null
  }
  return text
}

/** Read a single reference field (`input:` on validate/publish). */
function wantReference(ctx: WalkContext, entry: Entry, path: string): string | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved !== null && isSeq(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a single node reference, got a sequence — use "input" for a single reference`,
      path,
      resolved,
    )
    return null
  }
  return readReference(ctx, resolved, path)
}

/**
 * Walk a generic pipeline value (source config, operation args, opaque diff
 * body). Plain JSON-like values only: scalars, sequences, and mappings (with
 * string keys, no duplicates). Alias cycles are rejected rather than
 * recursing forever.
 */
function walkValue(
  ctx: WalkContext,
  node: YamlNode,
  path: string,
  seen: Set<object>,
): PipelineValue | undefined {
  const resolved = resolveNode(ctx, node)
  if (resolved === null) return null
  if (seen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      `${path}: recursively anchored value (an alias cycle) — pipeline documents cannot contain alias cycles`,
      path,
      resolved,
    )
    return undefined
  }
  if (isMap(resolved)) {
    const childSeen = new Set([...seen, resolved])
    const entries = collectEntries(ctx, resolved, path)
    if (entries === null) return undefined
    const out: Record<string, PipelineValue> = {}
    for (const [key, entry] of entries) {
      const value = walkValue(ctx, entry.valueNode, `${path}.${key}`, childSeen)
      if (value === undefined) continue
      defineOwn(out, key, value)
    }
    return out
  }
  if (isSeq(resolved)) {
    const childSeen = new Set([...seen, resolved])
    const items: readonly YamlNode[] = resolved.items as readonly YamlNode[]
    const out: PipelineValue[] = []
    for (let index = 0; index < items.length; index++) {
      const value = walkValue(ctx, items[index] ?? null, `${path}[${index}]`, childSeen)
      if (value !== undefined) out.push(value)
    }
    return out
  }
  const { kind, value } = scalarKind(resolved)
  switch (kind) {
    case 'null':
      return null
    case 'string': {
      const text = value as string
      if (text.includes('\u0000')) {
        pushError(ctx, 'out-of-range', `${path}: must not contain a NUL character`, path, resolved)
        return undefined
      }
      return text
    }
    case 'number':
      return readFiniteNumber(ctx, resolved, path)
    case 'boolean':
      return value as boolean
    case 'other':
      pushError(
        ctx,
        'wrong-type',
        `${path}: expected a string, number, boolean, list, or mapping; got ${describeYamlValue(resolved)}`,
        path,
        resolved,
      )
      return undefined
  }
}

/** Define an own property safely (hostile `__proto__` keys must not pollute). */
function defineOwn(target: Record<string, PipelineValue>, key: string, value: PipelineValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** Walk the `source` block: a mapping with a required `kind`; the rest is opaque. */
function walkSourceConfig(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  seen: Set<object>,
): SourceConfig | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null || !isMap(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a source configuration mapping with a "kind", got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  if (seen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      `${path}: recursively anchored value (an alias cycle) — pipeline documents cannot contain alias cycles`,
      path,
      resolved,
    )
    return null
  }
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) return null
  const kindEntry = entries.get('kind')
  if (kindEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "kind" — a source must declare its kind (e.g. file)`,
      path,
      resolved,
    )
  } else {
    wantNonEmptyString(ctx, kindEntry, `${path}.kind`)
  }
  const value = walkValue(ctx, resolved, path, seen)
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    return null
  }
  return value as SourceConfig
}

/** Walk a transform `operation`: exactly one operation key with a mapping argument. */
function walkOperation(
  ctx: WalkContext,
  entry: Entry,
  path: string,
  seen: Set<object>,
): OperationConfig | null {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null || !isMap(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected an operation mapping with exactly one operation key, got ${describeYamlValue(resolved)}`,
      path,
      valuePosition(entry, resolved),
    )
    return null
  }
  if (seen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      `${path}: recursively anchored value (an alias cycle) — pipeline documents cannot contain alias cycles`,
      path,
      resolved,
    )
    return null
  }
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) return null
  if (entries.size !== 1) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: expected exactly one operation key, got ${entries.size}${entries.size === 0 ? ' (an operation is required)' : ''}`,
      path,
      resolved,
    )
    return null
  }
  const [name, opEntry] = entries.entries().next().value as [string, Entry]
  if (name.length === 0) {
    pushError(
      ctx,
      'out-of-range',
      `${path}: the operation name must be non-empty`,
      path,
      opEntry.keyNode,
    )
    return null
  }
  const argsResolved = resolveNode(ctx, opEntry.valueNode)
  if (argsResolved === null || !isMap(argsResolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}.${name}: expected the operation arguments as a mapping, got ${describeYamlValue(argsResolved)}`,
      `${path}.${name}`,
      valuePosition(opEntry, argsResolved),
    )
    return null
  }
  const args = walkValue(ctx, argsResolved, `${path}.${name}`, seen)
  if (args === undefined || args === null || Array.isArray(args) || typeof args !== 'object') {
    return null
  }
  return { operation: name, args: args as PipelineMap }
}

/** Unknown-key message with a misplaced-key hint when the key is legal somewhere else. */
function unknownKeyMessage(key: string, where: string, knownKeys: readonly string[]): string {
  const locations = Object.hasOwn(KEY_LOCATIONS, key) ? KEY_LOCATIONS[key] : undefined
  if (locations !== undefined) {
    return `unknown key "${key}" ${where}; "${key}" is valid only in ${locations.join(' and ')}`
  }
  return `unknown key "${key}" ${where}; expected one of: ${knownKeys.join(', ')}`
}

function rejectUnknownKeys(
  ctx: WalkContext,
  entries: Map<string, Entry>,
  allowed: readonly string[],
  where: string,
  path: string,
): void {
  for (const [key, entry] of entries) {
    if (allowed.includes(key)) continue
    pushError(ctx, 'unknown-key', unknownKeyMessage(key, where, allowed), path, entry.keyNode)
  }
}

/** Walk one node body. `id` is the mapping key; `path` locates it for errors. */
function walkNode(
  ctx: WalkContext,
  id: string,
  node: YamlNode,
  path: string,
  seen: Set<object>,
): PipelineNode | null {
  const resolved = resolveNode(ctx, node)
  if (resolved === null || !isMap(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `${path}: expected a node mapping with a "type", got ${describeYamlValue(resolved)}`,
      path,
      resolved,
    )
    return null
  }
  if (seen.has(resolved)) {
    pushError(
      ctx,
      'yaml-syntax',
      `${path}: recursively anchored value (an alias cycle) — pipeline documents cannot contain alias cycles`,
      path,
      resolved,
    )
    return null
  }
  const childSeen = new Set([...seen, resolved])
  const entries = collectEntries(ctx, resolved, path)
  if (entries === null) return null

  const typeEntry = entries.get('type')
  if (typeEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "type" — one of source, transform, sql, validate, diff, publish`,
      path,
      resolved,
    )
    return null
  }
  const type = wantString(ctx, typeEntry, `${path}.type`)
  if (type === null) return null
  if (!isPipelineNodeClass(type)) {
    pushError(
      ctx,
      'unknown-node-class',
      `${path}.type: unknown node class ${JSON.stringify(type)} — expected one of: source, transform, sql, validate, diff, publish`,
      `${path}.type`,
      typeEntry.valueNode,
      id,
    )
    return null
  }

  switch (type) {
    case 'source':
      return walkSourceNode(ctx, id, entries, path, childSeen)
    case 'transform':
      return walkTransformNode(ctx, id, entries, path, childSeen)
    case 'sql':
      return walkSqlNode(ctx, id, entries, path, childSeen)
    case 'validate':
      return walkValidateNode(ctx, id, entries, path)
    case 'publish':
      return walkPublishNode(ctx, id, entries, path, childSeen)
    case 'diff':
      return walkDiffNode(ctx, id, entries, path)
  }
}

function walkSourceNode(
  ctx: WalkContext,
  id: string,
  entries: Map<string, Entry>,
  path: string,
  seen: Set<object>,
): SourceNode | null {
  rejectUnknownKeys(ctx, entries, SOURCE_NODE_KEYS, `in the source node at "${path}"`, path)
  const materialization = readMaterialization(ctx, entries, path)
  const sourceEntry = entries.get('source')
  if (sourceEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "source" — a source node declares its configuration`,
      path,
      null,
      id,
    )
    return null
  }
  const source = walkSourceConfig(ctx, sourceEntry, `${path}.source`, seen)
  if (source === null) return null
  return {
    id,
    type: 'source',
    ...(materialization !== undefined ? { materialization } : {}),
    source,
  }
}

function walkTransformNode(
  ctx: WalkContext,
  id: string,
  entries: Map<string, Entry>,
  path: string,
  seen: Set<object>,
): TransformNode | null {
  rejectUnknownKeys(ctx, entries, TRANSFORM_NODE_KEYS, `in the transform node at "${path}"`, path)
  const materialization = readMaterialization(ctx, entries, path)
  const inputsEntry = entries.get('inputs')
  let inputs: string[] | null = null
  if (inputsEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "inputs" — a transform consumes at least one table`,
      path,
      null,
      id,
    )
  } else {
    inputs = wantReferenceList(ctx, inputsEntry, `${path}.inputs`, seen)
    if (inputs !== null && inputs.length === 0) {
      pushError(
        ctx,
        'port-arity',
        `${path}.inputs: a transform requires at least one input, got an empty list`,
        `${path}.inputs`,
        inputsEntry.valueNode,
        id,
      )
      inputs = null
    }
  }
  const operationEntry = entries.get('operation')
  let operation: OperationConfig | null = null
  if (operationEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "operation" — a transform declares one operation`,
      path,
      null,
      id,
    )
  } else {
    operation = walkOperation(ctx, operationEntry, `${path}.operation`, seen)
  }
  if (inputs === null || operation === null) return null
  return {
    id,
    type: 'transform',
    ...(materialization !== undefined ? { materialization } : {}),
    inputs,
    operation,
  }
}

function walkSqlNode(
  ctx: WalkContext,
  id: string,
  entries: Map<string, Entry>,
  path: string,
  seen: Set<object>,
): SqlNode | null {
  rejectUnknownKeys(ctx, entries, SQL_NODE_KEYS, `in the sql node at "${path}"`, path)
  const materialization = readMaterialization(ctx, entries, path)
  const inputsEntry = entries.get('inputs')
  let inputs: string[] | null = null
  if (inputsEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "inputs" — declare the tables the SQL reads (use [] for none)`,
      path,
      null,
      id,
    )
  } else {
    inputs = wantReferenceList(ctx, inputsEntry, `${path}.inputs`, seen)
  }
  const sqlEntry = entries.get('sql')
  let sql: string | null = null
  if (sqlEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "sql" — a sql node carries its query text`,
      path,
      null,
      id,
    )
  } else {
    sql = wantNonEmptyString(ctx, sqlEntry, `${path}.sql`)
  }
  if (inputs === null || sql === null) return null
  return {
    id,
    type: 'sql',
    ...(materialization !== undefined ? { materialization } : {}),
    inputs,
    sql,
  }
}

function walkValidateNode(
  ctx: WalkContext,
  id: string,
  entries: Map<string, Entry>,
  path: string,
): ValidateNode | null {
  rejectUnknownKeys(ctx, entries, VALIDATE_NODE_KEYS, `in the validate node at "${path}"`, path)
  const inputEntry = entries.get('input')
  let input: string | null = null
  if (inputEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "input" — a validate node names the table to validate`,
      path,
      null,
      id,
    )
  } else {
    input = wantReference(ctx, inputEntry, `${path}.input`)
  }
  const contractEntry = entries.get('contract')
  let contract: string | null = null
  if (contractEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "contract" — a validate node names its contract`,
      path,
      null,
      id,
    )
  } else {
    contract = wantNonEmptyString(ctx, contractEntry, `${path}.contract`)
  }
  if (input === null || contract === null) return null
  return { id, type: 'validate', input, contract }
}

function walkPublishNode(
  ctx: WalkContext,
  id: string,
  entries: Map<string, Entry>,
  path: string,
  seen: Set<object>,
): PublishNode | null {
  rejectUnknownKeys(ctx, entries, PUBLISH_NODE_KEYS, `in the publish node at "${path}"`, path)
  const inputEntry = entries.get('input')
  let input: string | null = null
  if (inputEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "input" — a publish node names the table to publish`,
      path,
      null,
      id,
    )
  } else {
    input = wantReference(ctx, inputEntry, `${path}.input`)
  }
  const requiresEntry = entries.get('requires')
  let requires: string[] | undefined
  if (requiresEntry !== undefined) {
    const list = wantReferenceList(ctx, requiresEntry, `${path}.requires`, seen)
    if (list !== null && list.length > 0) requires = list
    // An empty `requires` normalizes to absent (one shape per meaning).
  }
  if (input === null) return null
  return { id, type: 'publish', input, ...(requires !== undefined ? { requires } : {}) }
}

function walkDiffNode(
  ctx: WalkContext,
  id: string,
  entries: Map<string, Entry>,
  path: string,
): DiffNode | null {
  // p2-2 settled shape: exactly `input` + `against`, both table references.
  // The opaque-body era is over — unknown keys are rejected like every other
  // class (one shape per meaning).
  rejectUnknownKeys(ctx, entries, DIFF_NODE_KEYS, `in the diff node at "${path}"`, path)
  const inputEntry = entries.get('input')
  let input: string | null = null
  if (inputEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "input" — a diff node names the table compared`,
      path,
      null,
      id,
    )
  } else {
    input = wantReference(ctx, inputEntry, `${path}.input`)
  }
  const againstEntry = entries.get('against')
  let against: string | null = null
  if (againstEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      `${path}: missing required key "against" — a diff node names the table compared against`,
      path,
      null,
      id,
    )
  } else {
    against = wantReference(ctx, againstEntry, `${path}.against`)
  }
  if (input === null || against === null) return null
  return { id, type: 'diff', input, against }
}

interface RootBuild {
  version?: number
  pipeline?: string
  nodes?: PipelineNode[]
}

function walkRoot(ctx: WalkContext, root: YamlNode): RootBuild | null {
  if (root === null) {
    pushError(
      ctx,
      'wrong-type',
      'the document is empty — expected a pipeline mapping starting with "version: 1"',
      ROOT_PATH,
      null,
    )
    return null
  }
  if (!isMap(root)) {
    pushError(
      ctx,
      'wrong-type',
      `the pipeline document must be a YAML mapping, got ${describeYamlValue(root)}`,
      ROOT_PATH,
      root,
    )
    return null
  }
  const entries = collectEntries(ctx, root, ROOT_PATH)
  if (entries === null) return null

  // `version` decides whether the rest of the document may be interpreted at
  // all: any other version is reported alone instead of guessed at.
  const versionEntry = entries.get('version')
  if (versionEntry === undefined) {
    pushError(
      ctx,
      'missing-key',
      'missing required key "version" — add "version: 1" (the only supported Pipeline IR version)',
      ROOT_PATH,
      root,
    )
  } else {
    const resolved = resolveNode(ctx, versionEntry.valueNode)
    const { kind, value } = scalarKind(resolved)
    if (kind !== 'number') {
      pushError(
        ctx,
        'wrong-type',
        `version: expected the number 1, got ${describeYamlValue(resolved)}`,
        'version',
        valuePosition(versionEntry, resolved),
      )
    } else if (!rejectImpreciseNumber(ctx, resolved, value as number, 'version')) {
      // Imprecise version: the gate already reported it honestly; stop the
      // walk like any other unsupported-version outcome.
      return null
    } else if ((value as number) !== PIPELINE_IR_VERSION) {
      pushError(
        ctx,
        'unsupported-version',
        `unsupported pipeline version ${String(value)} — this parser implements version ${String(PIPELINE_IR_VERSION)} only`,
        'version',
        versionEntry.valueNode,
      )
      return null
    }
  }

  const build: RootBuild = {}
  for (const [key, entry] of entries) {
    if (key === 'version') continue
    switch (key) {
      case 'pipeline': {
        const name = wantNonEmptyString(ctx, entry, 'pipeline')
        if (name !== null) build.pipeline = name
        break
      }
      case 'nodes': {
        build.nodes = walkNodes(ctx, entry)
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

  if (!entries.has('pipeline')) {
    pushError(
      ctx,
      'missing-key',
      'missing required key "pipeline" — the pipeline\'s identity',
      ROOT_PATH,
      root,
    )
  }
  if (!entries.has('nodes')) {
    pushError(
      ctx,
      'missing-key',
      'missing required key "nodes" — the pipeline must declare its nodes (use an empty mapping for none)',
      ROOT_PATH,
      root,
    )
  }
  return build
}

function walkNodes(ctx: WalkContext, entry: Entry): PipelineNode[] {
  const resolved = resolveNode(ctx, entry.valueNode)
  if (resolved === null || !isMap(resolved)) {
    pushError(
      ctx,
      'wrong-type',
      `nodes: expected a mapping of node id → node, got ${describeYamlValue(resolved)}`,
      'nodes',
      valuePosition(entry, resolved),
    )
    return []
  }
  const entries = collectEntries(ctx, resolved, 'nodes')
  if (entries === null) return []
  const seen = new Set<object>([resolved])
  const nodes: PipelineNode[] = []
  for (const [id, nodeEntry] of entries) {
    const path = `nodes.${id}`
    if (id.length === 0) {
      pushError(
        ctx,
        'out-of-range',
        'nodes: a node id must be a non-empty string',
        'nodes',
        nodeEntry.keyNode,
      )
      continue
    }
    if (id.includes('\u0000')) {
      pushError(
        ctx,
        'out-of-range',
        'nodes: a node id must not contain a NUL character',
        'nodes',
        nodeEntry.keyNode,
      )
      continue
    }
    // p-2 (ruling 1): a node id is its output relation name, and verbatim SQL
    // references relations by node id — so compile-time renaming would break
    // verbatim SQL. The repo-wide reserved `assay_*` namespace (compiler
    // internals; cf. m6-1) is therefore rejected at parse. DuckDB folds
    // identifier case even when quoted, so the check is case-insensitive. It
    // is also applied to the whitespace-trimmed id: surrounding whitespace is
    // not meaningful in a relation name, so `" assay_x"` / `"assay_x "` must
    // not slip past the reserved-prefix gate by a spelling difference (uniform
    // fail-closed reading; non-reserved hostile ids keep their whitespace).
    if (id.trim().toLowerCase().startsWith('assay_')) {
      pushError(
        ctx,
        'reserved-identifier',
        `nodes: the node id ${JSON.stringify(id)} uses the reserved "assay_" namespace — node ids become relation names, and "assay_*" is reserved repo-wide for compiler-internal identifiers; choose another id`,
        'nodes',
        nodeEntry.keyNode,
      )
      continue
    }
    const node = walkNode(ctx, id, nodeEntry.valueNode, path, seen)
    if (node !== null) nodes.push(node)
  }
  return canonicalNodeOrder(nodes)
}

/**
 * Validate a parsed document and build its pipeline. Returns the pipeline only
 * when no errors were collected. Internal — the public entry point is
 * `parsePipeline`.
 */
export function validatePipelineDocument(
  doc: Document,
  source: string,
): { pipeline?: PipelineV1; errors: readonly PipelineError[] } {
  const ctx: WalkContext = { doc, source, lineIndex: makeLineIndex(source), errors: [] }
  const build = walkRoot(ctx, doc.contents as YamlNode)
  if (ctx.errors.length > 0 || build === null) return { errors: ctx.errors }
  if (build.pipeline === undefined || build.nodes === undefined) {
    // A missing/invalid `pipeline`/`nodes` already collected an error above.
    return { errors: ctx.errors }
  }
  const pipeline: PipelineV1 = {
    version: PIPELINE_IR_VERSION,
    pipeline: build.pipeline,
    nodes: build.nodes,
  }
  return { pipeline, errors: ctx.errors }
}
