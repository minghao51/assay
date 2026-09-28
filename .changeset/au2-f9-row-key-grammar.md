---
'@assay/domain': patch
'@assay/cli': patch
'@assay/web': patch
---

refactor(au2-f9): single row-key display grammar in `@assay/domain`. The anchor-free `displayRowKey` (`base #12` / `insert #3` / `unknown row`) and `exportRowKey` (`base:12` / `insert:3` / `unknown`) helpers were duplicated copy-exact between the CLI (`report-shared.ts`) and the web (`validation/report-model.ts`, reached by `diff/diff-model.ts`). Both now live beside `parseRowId` in `packages/domain/src/row-identity.ts` and are re-exported from each surface's existing module, so every public import path and every rendered/exported byte is unchanged. `@assay/domain` stays dependency-free (the helpers add no imports — they decompose `parseRowId`'s existing `ParsedRowId` result).
