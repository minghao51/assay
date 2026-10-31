---
'@assay/web': minor
---

feat(web): state summaries on the shell-owned collapsed section toggles
(ug-17 / UG-27). `WorkbenchSection` accepts an optional `summary` slot, and App
fills it for exactly the three shell-owned sections from state it already holds:
`Validation · <N> failing` (the current verdict's failing-rule count, so one
failing rule that violates 25 rows still reads `1 failing`),
`Compare · <N> changed` (the current row-diff result's `changed.count`), and
`History · <N> pending` (`activeOps(history).length` — the same staged-operation
count R-16 labels). The summary renders inside the managed toggle's text column
under the R-14 purpose line, so it stays visible while the section body is
`hidden`; it renders only at N > 0 (`0 failing` / `0 changed` / `0 pending` is
never shown, and idle/running/cancelled/failed/binding-errors states show none).
The toggle's accessible name is unchanged (`Expand/Collapse <Title>`); the
summary joins `aria-describedby` after the purpose id only while it exists, and
a stale verdict/result keeps its count — the panels own the stale marking, so
the summary never claims freshness. Inner-disclosure sections (schema, filters,
profile) get no shell summary: Filters keeps its own `Filters · N active`
idiom. Copy is counts only — no rule, column, file or cell values (ADR 0025).
No DOM reorder (ADR 0044), no change to the `hidden` collapse mechanics
(ADR 0022), no engine/grid/session state, no polling, no telemetry. Pins: pure
copy/presence tests per source, App pins through the real composition root
(collapsed visibility, description order, name stability, zero-absence, and the
history/validation/comparison pass-through), the twelve R-14 purpose/name pins
unchanged, and an e2e spec proving the collapsed `Validation · 4 failing` and
`History · 1 pending` summaries against the real engine.
