# ADR editorial clarifications and errata — 2026-11-20

**Status:** clarification record (A01 item 5 of the
[improvement-plan execution](../process/handoff/20261120-improvement-plan-execution.md)). This file
explains editorial drift found in accepted ADRs — stale line anchors and a stale status marker. It
**does not rewrite any accepted decision text** and is **not an ADR** (it is outside the
`0NNN-` numbering the [index generator](README.md) collects). A durable changed decision goes
through the normal ADR process; existing dated amendments inside ADRs remain authoritative. Line
numbers below are observations at the 2026-11-20 baseline (`0150699`); use the linked headings and
symbols, which are stable.

| ADR  | Observed editorial drift (unchanged by this record)                                                                                                                                                 | Stable anchor to cite instead                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0044 | `## Deciders` still reads "ruling D14 pending" although `## Status` records **Accepted (ruling D14, 2026-09-29)** and `## Date` records the acceptance. The Deciders line is a pre-ruling leftover. | ADR 0044 `## Status` / `## Date`; ruling **D14** in [maintainer-rulings](../process/handoff/20260926-maintainer-rulings.md)                                                 |
| 0049 | Proposal-time anchor `apps/web/src/csv/CsvReviewDialog.tsx:442-452` (Stop generation bump) no longer lands on the bump after the dialog grew.                                                       | the `abandon` callback in `apps/web/src/csv/CsvReviewDialog.tsx` (bumps `generationRef.current`) and the `abandonRef` registration                                          |
| 0050 | Proposal-time anchors `history.ts:56-60, :95-130, :134-152, :155-160` drift as the module is edited.                                                                                                | `packages/domain/src/history.ts` — `appendOp` (stores the derived `inverse`; `column-repair` entries carry `inverse: []` + the `'undo-by-refold'` note) and `stateAtCursor` |
| 0051 | `overlay-query.ts:70-95` lands on module documentation; the realisation cited at `:1180`/`:1134` moves with edits.                                                                                  | `composeEffectiveSourceSql` in `packages/engine-duckdb/src/overlay-query.ts` (ADR 0051 § already names the symbol)                                                          |

Related accepted-ADR editorial observations (same rule — decision text stands; recorded here so the
audit's findings have one home):

- **ADR 0002** names `parquet-wasm` for lower-level Parquet work; no manifest or `pnpm-lock.yaml`
  entry for `parquet-wasm` exists at this baseline (checked 2026-11-20) and `packages/engine-parquet`
  is a scaffold. The DuckDB/Arrow clauses are live. Changing the clause is a decision, not an erratum.
- **ADR 0037** lists a visible opt-out toggle on web, VS Code and CLI; web and CLI implement one,
  while the VS Code extension carries no telemetry at all (so nothing to toggle; recorded at
  `apps/vscode/src/dataset.ts`). Two of three named
  surfaces exist; no egress is implied by this note.

What this record does **not** claim: that any cited symbol is bug-free, that line numbers here stay
current, or that an editorial fix was applied to an accepted ADR.
