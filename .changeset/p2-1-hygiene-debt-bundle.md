---
'@assay/pipeline': minor
'@assay/engine-duckdb': minor
'@assay/testing': patch
'@assay/cli': patch
'@assay/web': patch
---

feat(p2-1): hygiene + PT-P carry-over debt bundle. Nine items: (a) the C0/C1
control-char sanitizer moves to one shared pure home in `@assay/pipeline`
(`sanitize.ts`) with the CLI and web re-pointed to it (one escape-set pin);
(b) an additive engine op `engine/pipeline-handle` + client method
`registerPipelineRelation` registers an existing session view (a pipeline
node's materialized output) as a grid-facing dataset handle, so
schema/range/rowCount/export address it without a SQL-result detour
(value-free failure when the relation is absent), pinned by a new
pipeline-runner conformance scenario; (c) the CLI loads
`@assay/engine-duckdb/node` lazily on the run path only, so `pipeline
validate` never loads the native lib (structural load pin); (d) the node-seam
`PipelineRunEngineOps`/`PipelineRunSource` are generic over the source type,
removing the CLI's defensive cast and typing `PipelineFileSource`;
(e) eslint's adapter ban gains the `@dagster-io/*` scope; (f) `resolveNode`
re-throws a resolver `RangeError` instead of silently accepting it;
(g) the fixtures test pins that `architecture-example.yaml` is the only
`canonical:false` manifest entry that parses; (h) the hostile-names fixture
test pins the parsed AST of its most hostile construct; (i) `validatePipeline`
enforces the reserved `assay_*` node-id rule for programmatic ASTs with the
same case/trim semantics as the parse path. Additive-only v1 IR; no behavior
change beyond the documented ones.
