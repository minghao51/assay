---
'@assay/cli': patch
---

refactor(au2-f5): split the 978-line `report.ts` monolith along its three independent renderers. The m5-4 validation report model/renderers move to `report-validate.ts`, the ar-5 profile renderers to `report-profile.ts`, and the m6-3 diff model/renderers to `report-diff.ts`; the contract-visible helpers they share (the `reportVersion` stamp every JSON envelope carries, the anchor-free row-key grammar, and the basename-only dataset display helper) move to `report-shared.ts`. `report.ts` remains as a compatibility barrel re-exporting the historical `./report.js` surface, so command modules and tests are unchanged. **No behavior change: every `--format json` / human output remains byte-identical**, pinned unchanged by the validate/profile/diff integration test byte pins.
