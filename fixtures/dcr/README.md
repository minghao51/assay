# DCR artifact fixtures (p3-1; ADR 0046)

Golden documents for the DCR artifact format v1 (`format: assay-dcr` /
`version: 1`), consumed by `packages/pipeline/src/dcr-fixtures.test.ts`.

- `minimal.yaml`, `gated-run.yaml` — canonical text (`text === serialize(parse(text))`).
- `gated-run-alternate.yaml` — a valid but deliberately non-canonical
  rendering (JSON form) pinned to canonicalize byte-for-byte to `gated-run.yaml`.
- `refuses-*.yaml` — negative probes; each must fail with exactly the pinned
  error code.

Everything here is synthetic and value-free (ADR 0025): schema names, counts,
ordinal row keys (`base:<n>` / `b:<n>`), and the canonical "not computed"
privacy disclosure — never dataset cell values, SQL, timestamps, or sensitive
paths. Any fixture change is a deliberate, reviewed manifest regeneration.
