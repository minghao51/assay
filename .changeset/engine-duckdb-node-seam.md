---
'@assay/engine-duckdb': minor
---

feat(m5-4): environment-neutral `./node` subpath export — the pure, host-free half of the validate-execution machinery (view composition, engine-clamped rule-query wrapper, strict plan wire gate, result readers/normalizers, frozen exact `failPercent`, containment transaction constants, and the format/view registration SQL helpers) re-exported for non-browser hosts. Additive re-exports only (`src/node.ts` + the exports map entry): no behavioral source changes, and the browser worker client/protocol surface is deliberately NOT part of this entry. The m5-4 CLI executes plan SQL through these helpers instead of re-deriving engine semantics — cross-surface agreement by construction.
