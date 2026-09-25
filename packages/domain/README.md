# @assay/domain

Pure, portable domain entities and types for Assay — security
classifications, owners, physical dataset assets, dataset versions, logical row
identity, and the immutable edit-operation/overlay model (ADR 0004, ADR 0011,
ADR 0012). The package has no React, browser-API, or engine dependencies (the
lint-enforced portability boundary), so its shapes are the shared vocabulary
the engine, web app, grid, contracts, and CLI all build on.

- **Status:** part of the Assay monorepo — publish-ready, not yet published; the npm org claim (M1) is pending (see the [repo docs](../../docs/README.md)).
- **API surface:** [`src/index.ts`](src/index.ts) is the public entry; see [architecture](../../docs/architecture/01-architecture.md) §5.
- **Repository:** [Assay monorepo](../../README.md).

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
