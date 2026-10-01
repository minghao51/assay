// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline DAG validation (p-1): typed results, never throws.
 *
 * `validatePipeline` takes a structurally valid {@link PipelineV1} (from
 * `parsePipeline` or a correctly built AST) and pins the invariants the
 * runner can rely on:
 *
 * - **single writer** — each named output (a node id) is written by exactly
 *   one node;
 * - **references resolve** — every data/gate reference names a declared node;
 * - **port arity** — a transform has at least one input, a source none;
 * - **port type-shape** — a data input references a node that produces a
 *   data relation (the coarsest type the ADRs settle — there is deliberately
 *   no column-level type algebra in P1);
 * - **acyclicity** — the dependency graph (data inputs plus publish gates)
 *   is acyclic, and a validated pipeline carries a deterministic topological
 *   `order`.
 *
 * Errors are collected, not thrown (`errors.ts`); they carry the offending
 * `path`/`nodeId` but no line/column (the AST is position-free).
 *
 * Purity: pure graph logic — no React, no browser APIs, no engine, no
 * `@assay/*` engine imports (lint-enforced).
 */
import { compareNodeIds, portTypeOf } from './ast.js'
import type { PipelineNode, PipelineV1 } from './ast.js'
import type { PipelineError, PipelineValidationResult } from './errors.js'

interface Ports {
  /** Table references (must resolve to a data-producing node). */
  readonly data: readonly string[]
  /** Gate references (must resolve; no type-shape restriction). */
  readonly gates: readonly string[]
}

/** The input ports of a node. `diff`'s body is opaque, so it has none in P1. */
function portsOf(node: PipelineNode): Ports {
  switch (node?.type) {
    case 'transform':
      return { data: asRefs(node.inputs), gates: [] }
    case 'sql':
      return { data: asRefs(node.inputs), gates: [] }
    case 'validate':
      return { data: [node.input], gates: [] }
    case 'publish':
      return { data: [node.input], gates: asRefs(node.requires) }
    case 'source':
    case 'diff':
      return { data: [], gates: [] }
    default:
      return { data: [], gates: [] }
  }
}

function asRefs(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as readonly string[]) : []
}

/** A usable reference: a non-empty string without NUL. */
function isUsableRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && !ref.includes('\u0000')
}

function describeRef(ref: unknown): string {
  return typeof ref === 'string' ? JSON.stringify(ref) : 'a non-string value'
}

/**
 * Validate a pipeline's DAG. On success returns the pipeline plus a
 * deterministic topological order (dependencies first, ties broken by id).
 */
export function validatePipeline(pipeline: PipelineV1): PipelineValidationResult {
  const errors: PipelineError[] = []
  const rawNodes: unknown = (pipeline as { nodes?: unknown } | undefined)?.nodes
  const nodes: readonly unknown[] = Array.isArray(rawNodes) ? rawNodes : []

  const byId = new Map<string, PipelineNode>()
  const ids: string[] = []
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    const path = `nodes[${index}]`
    const id = nodeIdOf(node)
    if (id === null) {
      errors.push({
        code: 'invalid-reference',
        message: `${path}: a node must have a non-empty string id`,
        path: `${path}.id`,
      })
      continue
    }
    // p2-1 (i): the parse path rejects the repo-wide reserved `assay_*`
    // namespace (node id = relation name) at parse time; programmatic ASTs
    // reach validatePipeline directly, so the SAME rule (case-insensitive,
    // whitespace-trimmed, same value-free error shape) is enforced here too.
    if (id.trim().toLowerCase().startsWith('assay_')) {
      errors.push({
        code: 'reserved-identifier',
        message: `${path}: the node id ${JSON.stringify(id)} uses the reserved "assay_" namespace — node ids become relation names, and "assay_*" is reserved repo-wide for compiler-internal identifiers; choose another id`,
        path: `${path}.id`,
        nodeId: id,
      })
      continue
    }
    if (byId.has(id)) {
      errors.push({
        code: 'single-writer',
        message: `${path}: node id ${JSON.stringify(id)} is already declared — each named output has exactly one writer`,
        path,
        nodeId: id,
      })
      continue
    }
    byId.set(id, node as PipelineNode)
    ids.push(id)
  }
  ids.sort(compareNodeIds)

  // Reference resolution and coarse port typing.
  let graphComplete = true
  const dependencies = new Map<string, string[]>()
  for (const id of ids) {
    const node = byId.get(id) as PipelineNode
    const path = `nodes.${id}`
    const ports = portsOf(node)
    const deps: string[] = []
    collectArityErrors(errors, node, ports, path, id)
    for (let index = 0; index < ports.data.length; index++) {
      const ref = ports.data[index]
      if (!isUsableRef(ref)) {
        errors.push({
          code: 'invalid-reference',
          message: `${path}: data input #${index + 1} must be a non-empty string reference, got ${describeRef(ref)}`,
          path,
          nodeId: id,
        })
        graphComplete = false
        continue
      }
      const target = byId.get(ref)
      if (target === undefined) {
        errors.push({
          code: 'unresolved-reference',
          message: `${path}: data input ${JSON.stringify(ref)} names no declared node`,
          path,
          nodeId: id,
        })
        graphComplete = false
        continue
      }
      if (portTypeOf(target) !== 'data') {
        errors.push({
          code: 'port-type-shape',
          message: `${path}: data input ${JSON.stringify(ref)} refers to a node that does not produce a data relation`,
          path,
          nodeId: id,
        })
        continue
      }
      deps.push(ref)
    }
    for (let index = 0; index < ports.gates.length; index++) {
      const ref = ports.gates[index]
      if (!isUsableRef(ref)) {
        errors.push({
          code: 'invalid-reference',
          message: `${path}: gate #${index + 1} must be a non-empty string reference, got ${describeRef(ref)}`,
          path,
          nodeId: id,
        })
        graphComplete = false
        continue
      }
      if (!byId.has(ref)) {
        errors.push({
          code: 'unresolved-reference',
          message: `${path}: required gate ${JSON.stringify(ref)} names no declared node`,
          path,
          nodeId: id,
        })
        graphComplete = false
        continue
      }
      deps.push(ref)
    }
    dependencies.set(id, deps)
  }

  if (!graphComplete) return { ok: false, errors }

  const order = topologicalOrder(ids, dependencies)
  if (order === null) {
    const cycle = findCycle(ids, dependencies)
    const cycleText = cycle === null ? 'a cycle' : cycle.map((id) => JSON.stringify(id)).join(' → ')
    const first = cycle?.[0] ?? ids[0] ?? ''
    errors.push({
      code: 'cycle',
      message: `the pipeline dependency graph contains a cycle: ${cycleText}`,
      path: `nodes.${first}`,
      nodeId: first,
    })
  }

  if (errors.length > 0 || order === null) return { ok: false, errors }
  return { ok: true, pipeline, order }
}

function nodeIdOf(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null
  const id = (node as { id?: unknown }).id
  return isUsableRef(id) ? id : null
}

function collectArityErrors(
  errors: PipelineError[],
  node: PipelineNode,
  ports: Ports,
  path: string,
  id: string,
): void {
  switch (node?.type) {
    case 'source': {
      // A source produces, it does not consume: a stray `inputs` is an arity error.
      const stray = (node as { inputs?: unknown }).inputs
      if (Array.isArray(stray) && stray.length > 0) {
        errors.push({
          code: 'port-arity',
          message: `${path}: a source node takes no inputs, got ${stray.length}`,
          path,
          nodeId: id,
        })
      }
      break
    }
    case 'transform': {
      if (ports.data.length === 0) {
        errors.push({
          code: 'port-arity',
          message: `${path}: a transform requires at least one input`,
          path,
          nodeId: id,
        })
      }
      break
    }
    default:
      break
  }
}

/**
 * Kahn's algorithm with a deterministic tie-break (smallest id first). Returns
 * `null` when a cycle prevents a complete order.
 */
function topologicalOrder(
  ids: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    dependents.set(id, [])
  }
  for (const id of ids) {
    for (const dep of dependencies.get(id) ?? []) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
      dependents.get(dep)?.push(id)
    }
  }
  const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort(compareNodeIds)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift() as string
    order.push(id)
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort(compareNodeIds)
      }
    }
  }
  return order.length === ids.length ? order : null
}

/** Find a concrete cycle among nodes that did not reach indegree 0 (deterministic). */
function findCycle(
  ids: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const inProgress = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    if (inProgress.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (done.has(id)) return null
    inProgress.add(id)
    stack.push(id)
    const deps = [...(dependencies.get(id) ?? [])].sort(compareNodeIds)
    for (const dep of deps) {
      if (!dependencies.has(dep)) continue
      const found = visit(dep)
      if (found !== null) return found
    }
    stack.pop()
    inProgress.delete(id)
    done.add(id)
    return null
  }

  for (const id of [...ids].sort(compareNodeIds)) {
    const found = visit(id)
    if (found !== null) return found
  }
  return null
}
