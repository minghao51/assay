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
test verifies the manifest **bidirectionally** — every listed file exists with
a matching checksum, and every `*.yaml` in this directory is listed.
Regeneration is therefore a deliberate, reviewed change. A fixture may carry
`"expect": "refuses"` plus an `errorCode` to pin a parse refusal (p-2's
`reserved-identifier` probe).

| File | Purpose |
| --- | --- |
| `architecture-example.yaml` | Architecture §5 example literal text (non-canonical); canonicalizes to `customer_portfolio.yaml` |
| `customer_portfolio.yaml` | Canonical form of the architecture §5 example — source/transform/sql plus the reserved validate/publish classes |
| `hostile-names.yaml` | Hostile node ids and config keys (quotes, spaces, unicode, `__proto__`) |
| `reserved-namespace-refusal.yaml` | Negative probe: an `assay_*` node id is refused (`reserved-identifier`) |
| `reserved-nodes.yaml` | The reserved validate/diff/publish surface; `diff`'s body is carried opaquely and spread at the node level |

Policy: synthetic data only — never commit real or sensitive data.
