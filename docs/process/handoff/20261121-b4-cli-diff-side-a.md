# B4 — CLI `runDiffPlan` side A: explicit parameter (spec + implementation record)

**Date:** 2026-11-21. **Status:** `CLOSED` (spec written first, then implemented in `82e9973`).
**Row:** PT-H carry-over B4, [post-MVP §6](../../product/04-post-mvp-track.md#6-pt-h--hardening--backlog-inventory-recorded-carry-overs).

## 1. The recorded defect (verified)

`runDiffPlan` executed an already-prepared M6 plan against a base view named by its fifth
argument, but that argument defaulted to `DATASET_VIEW`:

```ts
baseViewName: string = DATASET_VIEW
```

The p2-5 pipeline gate ops already passed their own node relation explicitly
(`createPipelineRunOps().diff` → `runDiffPlan(conn, plan, schemaA, againstRelation, inputRelation)`),
so the pipeline path was correct. The defect was the **default**: a caller that omitted the argument
silently diffed the CLI's dataset view (`assay_t1`) instead of the relation it meant, and the CLI
`diff` command itself relied on that default rather than stating its side A. A silent fallback on a
row-identity-defining input is exactly the class of bug the rest of this file refuses loudly
(`assertRowDiffPlanBinding` is called adjacent to execution precisely to re-check the static gate).

## 2. The choice

Two options were recorded: parameterize, or assert with a self-explanatory error. **Chosen:
parameterize and make the parameter required.** Rationale:

- The parameterization already existed (p2-5); the residual risk was the default, so the smallest
  honest fix is to remove the default rather than add a runtime assertion that re-states it.
- A required argument is enforced by the type system at every call site — a new caller cannot
  forget it, and the compiler error names the missing argument. A runtime assertion only catches the
  mistake after the fact.
- No wire, plan or result shape changes: the parameter selects the _source_ view name; the plan's own
  relation names, the row-identity grammar (`base:#<ordinal>`), the containment transaction and the
  value-free failure classes are untouched.

## 3. What the implementation guarantees

- `runDiffPlan(conn, plan, schemaA, stagedViewB, baseViewName)` — `baseViewName` has **no default**.
  Call sites: `diff.ts` passes `DATASET_VIEW` explicitly; `createPipelineRunOps().diff` passes the
  input node relation; the Node-path integration test passes `DATASET_VIEW`.
- The base view name is the only thing the parameter changes. Side B remains `stagedViewB`, and the
  existing binding gate (`assertRowDiffPlanBinding`) still refuses a plan whose relation names
  collide with a registered view or whose compiler FROM shape is wrong.
- A base view that does not exist is a fixed, value-free class
  (`the row-diff side A binding view could not be materialized`) — no engine text, no dataset value
  crosses the boundary (ADR 0025).

## 4. Tests

`apps/cli/src/diff.integration.test.ts`:

- the existing Node-path vs spawned-CLI agreement test now passes side A explicitly;
- **new:** side A is registered under `assay_b4_renamed_base` and the diff is computed over it
  (row counts and per-aspect keys unchanged), which fails if side A is hardcoded back to
  `DATASET_VIEW`;
- **new:** the same plan executed with a base view that does not exist rejects with the fixed
  materialization class.

Mutation drill: restoring `= DATASET_VIEW` and dropping the argument at the renamed-base call site
makes the new test diff the wrong view (or fail to compile), so the pin is load-bearing.

## 5. Not claimed

- No new cross-surface byte-identity claim beyond the existing agreement test (Node path vs spawned
  CLI, per-aspect `{count, samples}`).
- No change to diff semantics, sample limits, registry lifecycle (`assay_tN` accumulation stays
  B3's row) or the row-identity grammar.
