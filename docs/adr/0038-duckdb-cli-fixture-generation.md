# ADR 0038: Golden Parquet Fixtures Are Generated with the DuckDB CLI

## Status

Accepted

## Context

Conformance and diff tests need Parquet golden fixtures (nested columns, dictionary encoding, multiple row groups, schema drift — docs `engineering/06-testing-security-quality.md` §3). Decision D3 required choosing generation tooling: committed binaries alone are opaque and non-reproducible; a Python/pyarrow generator adds a Python runtime to a TypeScript repo; a Rust helper adds build cost.

The product already standardizes on DuckDB as its local engine (ADR 0002), and the DuckDB CLI can write Parquet with full control over structure (`COPY … TO … (FORMAT PARQUET)`).

## Decision

Golden Parquet fixtures are produced by `fixtures/parquet/generate.sh`, which invokes the DuckDB CLI and executes deterministic SQL (seeded/no `random()` without seed, no timestamps without fixed values).

Policy:

- **Small canonical fixtures are committed** together with `manifest.json` (filenames + SHA-256 checksums + descriptions) so tests can run without DuckDB installed.
- **Large performance fixtures are generated on demand** and never committed.
- CI wiring of the generator is deferred to M1, where the first Parquet-consuming tests land.

## Consequences

### Positive

- One engine dependency for product and fixtures; SQL is reviewable and deterministic.
- Fixtures remain reproducible and diffable via checksums.

### Negative / risks

- Requires the DuckDB CLI locally to regenerate (documented in the script and README).
- DuckDB CLI Parquet output characteristics may change across versions; the manifest pins checksums, so regeneration must be a deliberate, reviewed action.
