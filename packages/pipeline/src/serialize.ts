// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical Pipeline IR serializer (p-1): one `PipelineV1` → one exact YAML
 * text, byte-stable everywhere the format appears.
 *
 * ## Canonical form
 *
 * - Root keys in fixed order: `version`, `pipeline`, `nodes`.
 * - Node mapping keys ascending by id (code-unit order); node keys in fixed
 *   order: `type`, then the class-specific fields in their documented order.
 * - Within generic values (source config, operation args, opaque `diff` body)
 *   mapping keys are sorted ascending recursively — order in the *source* is
 *   not meaning, so canonical output depends on the AST only.
 * - `inputs`/`requires` render as flow sequences (`[ a, b ]`); everything else
 *   is block style, 2-space indent, no line folding, single trailing newline.
 * - `publish.requires` is omitted when empty.
 * - Multi-line `sql` renders as a literal block by the library's canonical
 *   scalar styling.
 *
 * ## Trust boundary
 *
 * The parameter is *typed*: callers pass a `PipelineV1` from `parsePipeline`
 * or a correctly built AST. The function is still total — it reads the known
 * fields with defensive reads, so a caller bug degrades to deterministic,
 * plain output rather than a raw throw (such output is not guaranteed to
 * re-parse as a valid pipeline).
 *
 * Purity: no React, no browser APIs, no engine (lint-enforced).
 */
import { Document, stringify } from 'yaml'
import { PIPELINE_IR_VERSION, compareNodeIds } from './ast.js'
import type { PipelineNode, PipelineV1 } from './ast.js'

/** Serialize a pipeline to its canonical YAML form. Total; see the module doc. */
export function serializePipeline(pipeline: PipelineV1): string {
  const doc = new Document()
  const nodes = Array.isArray(pipeline?.nodes) ? pipeline.nodes : []
  // Derive safe id strings *before* sorting: a caller bug behind a cast must
  // not make the sort coerce a hostile object (`{ toString: null }`).
  const ordered = nodes
    .map((node) => ({ id: asText(node?.id), node }))
    .sort((a, b) => compareNodeIds(a.id, b.id))
  const nodesMap = new Map<string, unknown>()
  for (const { id, node } of ordered) nodesMap.set(id, serializeNode(doc, node))
  const root = new Map<string, unknown>([
    ['version', PIPELINE_IR_VERSION],
    ['pipeline', asText(pipeline?.pipeline)],
    ['nodes', doc.createNode(nodesMap)],
  ])
  doc.contents = doc.createNode(root)
  return stringify(doc, {
    lineWidth: 0, // never fold long scalars — folding would be another canonical degree-of-freedom
    indent: 2,
  })
}

function serializeNode(doc: Document, node: PipelineNode): unknown {
  switch (node?.type) {
    case 'source':
      return new Map<string, unknown>([
        ['type', 'source'],
        ['source', serializeSource(node.source)],
      ])
    case 'transform':
      return new Map<string, unknown>([
        ['type', 'transform'],
        ['inputs', doc.createNode(asStringList(node.inputs), { flow: true })],
        ['operation', serializeOperation(node.operation)],
      ])
    case 'sql':
      return new Map<string, unknown>([
        ['type', 'sql'],
        ['inputs', doc.createNode(asStringList(node.inputs), { flow: true })],
        ['sql', asText(node.sql)],
      ])
    case 'validate':
      return new Map<string, unknown>([
        ['type', 'validate'],
        ['input', asText(node.input)],
        ['contract', asText(node.contract)],
      ])
    case 'publish': {
      const entries: [string, unknown][] = [
        ['type', 'publish'],
        ['input', asText(node.input)],
      ]
      const requires = asStringList(node.requires)
      if (requires.length > 0) entries.push(['requires', doc.createNode(requires, { flow: true })])
      return new Map<string, unknown>(entries)
    }
    case 'diff':
      return new Map<string, unknown>([
        ['type', 'diff'],
        ...sortedEntries(asRecord(node.config), (value) => toYamlValue(value)),
      ])
    default:
      // A caller bug behind a cast: emit a defensible minimal marker rather
      // than throwing. Not guaranteed to re-parse.
      return new Map<string, unknown>([['type', asText((node as { type?: unknown })?.type)]])
  }
}

function serializeSource(source: unknown): unknown {
  const record = asRecord(source)
  const kind = Object.hasOwn(record, 'kind') ? asText(record.kind) : asText(undefined)
  const rest = sortedEntries(record, (value) => toYamlValue(value), 'kind')
  return new Map<string, unknown>([['kind', kind], ...rest])
}

function serializeOperation(operation: unknown): unknown {
  const record = asRecord(operation)
  const name = Object.hasOwn(record, 'operation') ? asText(record.operation) : asText(undefined)
  const args = sortedEntries(asRecord(record.args), (value) => toYamlValue(value))
  return new Map<string, unknown>([[name, new Map<string, unknown>(args)]])
}

/** Sort a record's own keys ascending, mapping values and dropping `undefined` results. */
function sortedEntries(
  record: Record<string, unknown>,
  mapValue: (value: unknown) => unknown,
  skip?: string,
): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const key of Object.keys(record).sort()) {
    if (key === skip) continue
    const value = mapValue(record[key])
    if (value === undefined) continue
    out.push([key, value])
  }
  return out
}

/** Recursively canonicalize a generic value; `undefined` when it has no honest YAML form. */
function toYamlValue(value: unknown): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : undefined
    case 'object': {
      if (value === null) return null
      if (Array.isArray(value)) {
        const items: unknown[] = []
        for (const item of value) {
          const mapped = toYamlValue(item)
          if (mapped !== undefined) items.push(mapped)
        }
        return items
      }
      const entries = sortedEntries(value as Record<string, unknown>, (item) => toYamlValue(item))
      return new Map<string, unknown>(entries)
    }
    default:
      return undefined // undefined, bigint, function, symbol
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * Total text renderer for identifier fields. Mirrors `@assay/contracts`:
 * primitives use their short form, but objects are never stringified (their
 * coercion can throw). The serializer's totality depends on it.
 */
function asText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value)
    case 'undefined':
      return 'undefined'
    case 'object':
      return value === null ? 'null' : 'an object (no safe string form)'
    default:
      return `a ${typeof value} value` // function or symbol
  }
}
