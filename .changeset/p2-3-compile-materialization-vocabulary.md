---
'@assay/pipeline': minor
---

feat(p2-3): compile — materialization → local SQL mapping + join/aggregate/window vocabulary

`compilePipeline` now carries the ADR 0033 **mode → local statement** mapping
(architecture §8) additively: every compiled entry exposes its effective
`materialization` mode, the `statement` the local runner executes, and its
`statementKind`. `sql`/`relation` semantics are unchanged, so the P1 runner and
CLI keep working unmodified.

- `view` (and the absent default): `CREATE OR REPLACE VIEW "<rel>" AS <query>`
- `ephemeral`: the view mechanism (DuckDB views are lazy/session-bound, which
  preserves ephemeral's no-persistent-storage intent locally at zero structural
  cost; CTE folding would restructure the DAG SQL per consumer)
- `table`: `CREATE OR REPLACE TABLE "<rel>" AS <query>`
- `export`: `COPY (<query>) TO '<path>' (FORMAT PARQUET, COMPRESSION ZSTD,
ROW_GROUP_SIZE 122880)` with a deterministic `assay-exports/` destination
  derived from the node id (path-safe, collision-free encoding)
- `cache` / `incremental` / `publish`: typed `unsupported-materialization`
  refusals citing ADR 0033's no-silent-changes rule (OPFS cache/incremental are
  future slices; publish-mode materialization is the P3/DCR boundary)

The compiled transform vocabulary grows from four to seven operations:
`join` (`{ left, right, on }`, binary, rendered as `INNER JOIN … USING (…)`),
`aggregate` (`{ group_by, aggregations: [{ op, column, as }] }` with
`sum`/`count`/`min`/`max`/`avg`, `COUNT(*)` when `count` omits `column`, explicit
aliases), and `window` (`{ function: row_number|rank|dense_rank, order_by,
partition_by?, as }`). Everything else still stays escape-hatch SQL, and every
new categorical refusal points at that path.

The architecture §5 example fixtures are updated to the structured filter
grammar and the compiled join op (closing the recorded §5-example divergence)
with re-checksummed manifest entries. New byte-stable golden pins per mode and
per op, mode-refusal pins, hostile-name injection probes through the new ops
and the export path, extended property suites, and real-`@duckdb/node-api`
execution pins for the new statements.
