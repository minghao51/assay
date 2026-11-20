---
'@assay/engine-duckdb': patch
---

refactor(d04a): extract the CSV preview/open dispatch handlers out of the
2,600-line engine executor into engine-local modules behind ONE explicit
context. `executor-context.ts` now owns the structural DB/session/deps seams,
the `EngineOpLane` interface and the `EngineHandlerContext` a handler receives
(`deps`, `registry`, `previews`, `lane`, `streamFirstBatch`, `post`);
`preview-registry.ts` holds `PreviewRegistry`/`viewNameForPreviewId`/
`StagedPreview` next to the existing `table-registry`/`comparison-registry`
peers; `csv-dispatch.ts` holds `captureCsvPreviewIntent`, `runOpenHandler`,
`runCsvPreviewHandler` and `releasePreviewSlot`; `errors.ts` holds the shared
`errorMessage` projection. There is no global service locator and no
module-level mutable state — the executor is still the single owner of both
registries and of the lane each op runs on.

**No behavior change**: the composed SQL, caps, error categories, refusal
text, supersession checkpoints, lane routing and the ENG-3 preview payload are
untouched — the moved bodies are token-identical after the `this.` → `ctx.`
prefix. Public specifiers are preserved: `engine-executor.ts` re-exports
`PreviewRegistry`, `viewNameForPreviewId`, `StagedPreview` and the structural
deps types, and `index.ts` keeps the same exports (only the module a re-export
points at moved). No public API addition or removal, so this is a `patch`,
matching the `au2-f1` internal-extraction precedent.

Invariants re-verified by mutation (worktree mutants, each reverted):
moving the CSV format refusal after the first engine touch fails
`refuses before ANY engine touch`; dropping the reader release in
`streamFirstBatch` fails the first-batch cancel/reader-release tests; altering
a composed SQL token (`DROP VIEW IF EXISTS`, or identifier quoting) fails the
slot-release golden and `drop-before-restage`. Gates: format:check, lint,
typecheck, test, build all pass; engine package suite and the pack-consumer
smoke pass.
