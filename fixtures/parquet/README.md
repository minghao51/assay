# Parquet fixtures — generated, small ones committed

Golden Parquet fixtures are produced by **`generate.sh`** using the DuckDB CLI
(ADR 0038). The SQL is fully deterministic — no unseeded randomness, no
current-time functions.

## Regenerate

```bash
bash fixtures/parquet/generate.sh          # duckdb on PATH
DUCKDB=/path/to/duckdb bash fixtures/parquet/generate.sh
```

This produces:

| File | Purpose |
| --- | --- |
| `customers.parquet` | typed CSV import incl. NULL income value |
| `nested.parquet` | nested structs/lists with nullable inner fields |
| `llm.parquet` | LLM chat/eval records (list-of-structs), incl. a conversation missing a system turn |
| `wide.parquet` | multi-row-group (10 x 100 rows), nulls, low-cardinality column |

plus `manifest.json` with SHA-256 checksums, the DuckDB version used, and the
policy. Tests (`packages/testing/src/fixtures.test.ts`) verify the manifest
**bidirectionally** — every manifest-listed file exists with a matching
checksum, and every generated Parquet file in the directory is listed — so
regeneration is always a deliberate, reviewed change that updates the
manifest in the same commit.

## Policy

- Small canonical fixtures are committed (they must stay small).
- Large performance fixtures (multi-GB, M1 benchmarks) are generated **on
  demand** and never committed.
- Never commit real or sensitive data — synthetic data only.
