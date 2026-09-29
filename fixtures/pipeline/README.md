# Pipeline IR fixtures

Hand-authored, canonical-text Pipeline IR documents (p-1, ADR 0030). They back
the round-trip, totality, and DAG-validation pins in
`@assay/pipeline` (see `src/fixtures.test.ts` and `src/parse.test.ts`).

`manifest.json` carries SHA-256 checksums; the fixture test verifies the
manifest **bidirectionally** — every listed file exists with a matching
checksum, and every `*.yaml` in this directory is listed. Regeneration is
therefore a deliberate, reviewed change.

| File | Purpose |
| --- | --- |
| `customer_portfolio.yaml` | The architecture §5 example verbatim — source/transform/sql plus the reserved validate/publish classes |
| `hostile-names.yaml` | Hostile node ids and config keys (quotes, spaces, unicode, `__proto__`, the reserved `assay_*` namespace) |
| `reserved-nodes.yaml` | The reserved validate/diff/publish surface; `diff`'s body is carried opaquely |

Policy: synthetic data only — never commit real or sensitive data.
