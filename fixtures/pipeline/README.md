# Pipeline IR fixtures

Hand-authored Pipeline IR documents (p-1, ADR 0030). They back the round-trip,
totality, and DAG-validation pins in `@assay/pipeline` (see
`src/fixtures.test.ts` and `src/parse.test.ts`).

All fixtures are **canonical text** — each file satisfies
`text === serialize(parse(text))` byte for byte — except
`architecture-example.yaml`, which holds the architecture §5 example verbatim
(deliberate non-canonical spacing), and `reserved-namespace-refusal.yaml`,
which is a deliberate negative probe. A test asserts the §5 literal parses
cleanly and canonicalizes to `customer_portfolio.yaml`, so §5 coverage is
preserved without claiming the doc's formatting is canonical.

`manifest.json` carries SHA-256 checksums and a `canonical` flag; the fixture
test verifies the manifest **bidirectionally and recursively** — every listed
fixture (including the `contracts/` data-contract fixtures, listed separately
under `contracts`) exists with a matching checksum, and every `*.yaml` under
`fixtures/pipeline/` (subdirectories included) is listed. Regeneration is
therefore a deliberate, reviewed change: editing a contract fixture without
regenerating its checksum fails the suite. A fixture may carry
`"expect": "refuses"` plus an `errorCode` to pin a parse refusal (p-2's
`reserved-identifier` probe).

| File | Purpose |
| --- | --- |
| `architecture-example.yaml` | Architecture §5 example literal text (non-canonical); canonicalizes to `customer_portfolio.yaml`. p2-3: its filter uses the structured predicate grammar and its join the compiled `join` op, so the data subgraph compiles |
| `cli_run.yaml` | CLI-friendly runnable pipeline (p-4): file source over `fixtures/csv/customers.csv`, rename + filter transforms, and a verbatim sql aggregate — the `assay pipeline run` end-to-end fixture |
| `customer_portfolio.yaml` | Canonical form of the architecture §5 example — source/transform/sql plus the reserved validate/publish classes (p2-3: structured filter + compiled join) |
| `hostile-names.yaml` | Hostile node ids and config keys (quotes, spaces, unicode, `__proto__`) |
| `materialization-modes.yaml` | p2-2 materialization surface (ADR 0033): data nodes declaring `cache`/`ephemeral`/`table`/`export`/`incremental`, plus an absent-default (`view`) source |
| `reserved-namespace-refusal.yaml` | Negative probe: an `assay_*` node id is refused (`reserved-identifier`) |
| `reserved-nodes.yaml` | The reserved validate/diff/publish surface with the p2-2 settled shapes (`diff` = typed `input`+`against`; `validate` = `input`+`contract`; `publish` = `input`+`requires`) |
| `contracts/sg_min_rows_fail.yaml` | p2-5 data-contract fixture: `min-rows: 3` (fails against `cli_gated.yaml`'s 2-row relation) |
| `contracts/sg_min_rows_pass.yaml` | p2-5 data-contract fixture: `min-rows: 2` (passes against `cli_gated_pass.yaml`'s 2-row relation) |

Policy: synthetic data only — never commit real or sensitive data.
