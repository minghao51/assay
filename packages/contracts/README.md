# @assay/contracts

The native Assay data-contract format (ADR 0013, ADR 0026): the canonical v1
Contract AST, a total (never-throwing) YAML parser with typed line/column
errors, the canonical serializer, the documented declared-type and rule
vocabulary, and the JSON Schema adapter. A pure package — no React, no browser
APIs, no engine or other `@assay/*` imports — with one runtime dependency, the
`yaml` parser. Downstream, `@assay/validation` compiles the parsed contract
into deterministic execution plans.

- **Status:** part of the Assay monorepo — publish-ready, not yet published; the npm org claim (M1) is pending (see the [repo docs](../../docs/README.md)).
- **API surface:** [`src/index.ts`](src/index.ts) is the public entry (format + parse/serialize + JSON Schema adapter; test-support generators stay internal).
- **Repository:** [Assay monorepo](../../README.md).

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
