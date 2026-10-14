---
'@assay/cli': patch
'@assay/engine-duckdb': patch
'@assay/pipeline': patch
---

Build and locally pack the complete CLI runtime dependency closure as plain
Node ESM, including pipeline and telemetry. The consumer smoke exercises
pipeline execution and canonical DCR generation without a TypeScript loader.
