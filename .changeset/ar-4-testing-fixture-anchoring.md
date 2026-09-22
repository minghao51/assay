---
'@assay/testing': patch
---

fix(ar-4): fixture-helper hardening (AR-F2, AR-F3). `fixturePath` now resolves `<repo>/fixtures/` from the module's own URL (`resolveFixturesRoot`, correct for both the `src/` and built `dist/` layouts) instead of `process.cwd()`, so it works from any runner directory, and it asserts the fixtures root exists with a readable failure when the package is relocated (AR-F2). The committed parquet manifest check is now two-directional: the `.parquet` files actually present must be exactly the manifest's keys (an unlisted file is caught), with the listing/comparison factored so a unit proves the converse direction, plus the existing manifest→file checksum direction kept intact (AR-F3). No `fixtures/` content changes.
