# @assay/diff

The pure domain layer for Assay dataset comparison: schema drift
(added/removed columns, type and nullability changes), distribution deltas
(standardized mean/variance, quantile, categorical total-variation), the
histogram-bin seam (PSI / Jensen-Shannon over derived bins), and the key-based
row-diff plan (added/removed anti-joins, full-outer-join changes, bounded
samples). Every entry point is total over hostile input and deterministic, with
A = reference and B = current. The engine profile shape is mirrored
structurally, never imported (the lint-enforced purity boundary).

- **Status:** part of the Assay monorepo — publish-ready, not yet published; the npm org claim (M1) is pending (see the [repo docs](../../docs/README.md)).
- **API surface:** [`src/index.ts`](src/index.ts) is the public entry; see `row-diff-plan.ts` for the executor contract.
- **Repository:** [Assay monorepo](../../README.md).

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
