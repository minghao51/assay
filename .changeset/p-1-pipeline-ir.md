---
'@assay/pipeline': minor
---

feat(p-1): Assay Pipeline IR core — versioned schema, canonical YAML, DAG validation (pure package).

Makes `packages/pipeline` real per ADR 0030/0029/0031/0032 and architecture
`02-pipeline-dag-etl.md` §5:

- **IR AST** (`ast.ts`) — `version: 1`, pipeline identity, nodes keyed by a
  stable string id (the node id is its output port / relation reference),
  explicit table-reference inputs; P1-executable classes `source`,
  `transform`, `sql`; `validate`/`publish` typed to the §5 shapes but
  non-executable (P2); `diff`'s body is carried opaquely because §5 does not
  settle its shape. Nodes are canonically ordered by id.
- **Canonical serializer** (`serialize.ts`) — one shape per meaning: fixed
  root/node key order, sorted generic mapping keys, flow `inputs`, literal
  `sql` blocks, single trailing newline, byte-stable and total.
- **Total located-error parser** (`parse.ts`/`validate.ts`) — never throws;
  hostile input degrades to typed `PipelineError`s (yaml-syntax,
  unsupported-version, missing/unknown/duplicate key, wrong-type,
  out-of-range, unknown-node-class, invalid/duplicate reference, …) with
  document path and 1-based line/column; NUL and non-finite values rejected;
  alias cycles refused.
- **DAG validation** (`dag.ts`) — single-writer (unique node ids), resolvable
  data/gate references, port arity, coarse port type-shape (data inputs must
  reference a data-producing node), and acyclicity with a deterministic
  topological order; typed results, never throws.
- **Shared identifier helper** (`identifiers.ts`) — reuses
  `@assay/validation`'s `quoteIdentifier` for port names; never hand-rolled.
- Golden fixtures (`fixtures/pipeline/`): canonical-text documents
  (`text === serialize(parse(text))` pinned) plus `architecture-example.yaml`
  holding the architecture §5 example verbatim, parse-verified to
  canonicalize byte-for-byte to `customer_portfolio.yaml`; hostile names
  (`__proto__`, quotes, unicode, reserved `assay_*`) and the reserved
  validate/diff/publish surface, with a checksum manifest, `canonical` flag,
  and seeded round-trip, canonical-stability, totality (incl. anchors/aliases),
  and DAG-invariant property suites.

Allowed deps only: `yaml` + `@assay/validation`; the purity ESLint block
bans engine/UI/grid/core/transforms/apps and dbt/SQLMesh/Dagster runtimes
(ADR 0031/0032). No telemetry, no engine/DOM access (the runner is p-3).
