# @assay/validation

Rule planning and execution for Assay. A validated `@assay/contracts`
contract plus a target engine schema compile into a deterministic,
serializable `ValidationPlan` — one SQL query per rule plus a summary query —
or typed `BindingError`s (unknown columns, rules inapplicable to a column's
type family, unclassifiable engine type spellings, regex outside the
documented RE2 subset). Binding happens before execution, never at runtime;
`@assay/diff` reuses the type-family classifier.

- **Status:** part of the Assay monorepo — publish-ready, not yet published; the npm org claim (M1) is pending (see the [repo docs](../../docs/README.md)).
- **API surface:** [`src/index.ts`](src/index.ts) is the public entry; see `compile.ts` for binding semantics and `plan.ts` for the result contracts.
- **Repository:** [Assay monorepo](../../README.md).

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
