---
name: assay-fixtures
description: Regenerate and verify Parquet golden fixtures and manifest checksums for the Assay repo
whenToUse: When validation/diff logic changed in a way that affects dataset shapes, or when fixture checksum mismatches appear
---

# Parquet fixture regeneration

1. Regenerate deliberately, never incidentally: `bash fixtures/parquet/generate.sh` (requires the DuckDB CLI).
2. Verify `fixtures/parquet/manifest.json` checksums match after regeneration.
3. Never commit real or sensitive data; fixtures must be minimal and synthetic.
4. If regeneration changes outputs, the change is a behavior change: it needs a test update and a changeset (`pnpm changeset`), and the ADR/doc implications checked.
