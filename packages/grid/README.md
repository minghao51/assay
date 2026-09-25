# @assay/grid

Assay's owned headless grid model: the grid is a view, never the dataset
(ADR 0003, ADR 0022). The model owns viewport coordinates, selection, sort and
filter state, editing state, keyboard commands, clipboard, and annotations,
while rendering stays replaceable behind it. It requests only visible or
nearby ranges and never materializes the full dataset in UI state — the LRU
window cache, in-flight dedup, and epoch tagging that make that observable.

- **Status:** part of the Assay monorepo — publish-ready, not yet published; the npm org claim (M1) is pending (see the [repo docs](../../docs/README.md)).
- **API surface:** [`src/index.ts`](src/index.ts) is the public entry; see `contracts.ts` for the structural page/provider types.
- **Repository:** [Assay monorepo](../../README.md).

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
