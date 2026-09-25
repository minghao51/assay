# assay — the local-first data workbench CLI

The `assay` command-line surface (D10, npm-only; compiled per ADR 0042). It
shares the core packages with the browser app (ADR 0008) and executes
validation, profile, and row-diff plans against raw dataset files over the
engine's `./node` seam (ADR 0041). It opens Parquet, CSV, JSONL, and JSON, and
it reports the raw file — a CLI run has no editing session.

- **Status:** part of the Assay monorepo — publish-ready, not yet published; the npm org claim (M1) is pending (see the [repo docs](../../docs/README.md)).
- **API surface:** [`src/index.ts`](src/index.ts) is the compiled `dist/index.js` entry; commands dispatch lazily so `--help`/`--version` never load the engine.
- **Repository:** [Assay monorepo](../../README.md).

## Usage

```bash
assay validate <path> --contract <file> [options]
assay diff <a> <b> (--key <column>… | --infer) [options]
assay profile <path> [options]
```

`validate` checks a dataset against a contract; `diff` reports schema drift,
profile deltas, then the key-based row diff; `profile` reports per-column
null/distinct counts, numeric stats and quantiles, and categorical top-k. All
three accept `--format json` for a byte-stable report.

Exit codes: `0` success (validate: valid; profile: produced), `1` differences
found, `2` usage, path, inference, or binding error.

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
