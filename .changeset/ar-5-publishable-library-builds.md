---
'@assay/contracts': patch
'@assay/domain': patch
'@assay/diff': patch
'@assay/grid': patch
'@assay/validation': patch
---

Publishability foundation (ADR 0042): each pure package now has a
`composite: true` `tsc --build` that emits per-file ESM JavaScript,
declarations, declaration maps, and source maps to `dist/`, and carries the
metadata an npm artifact needs — `publishConfig.exports` (dist-pointing),
`types`, `files` (dist-only), `license` (AGPL-3.0-or-later, ADR 0036),
`repository`, and `engines` (Node ≥ 22). Workspace `exports` deliberately stay
on `src/`, so internal DX (web, vitest, harnesses) is unchanged; `private` is
removed only from packages meant to publish. Emitted relative imports carry
explicit `.js` extensions so every packed `dist/` graph loads under plain Node
(no loader/tsx); the `pnpm pack` → clean-consumer harness (ar-5) is the
enforcement that what ships is the `tsc` output.
