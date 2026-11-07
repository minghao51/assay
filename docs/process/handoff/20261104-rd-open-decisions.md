# Redesign remainder — decisions pending on the maintainer (2026-11-04)

**RESOLVED 2026-11-04 — every item below is resolved to the recommended option** ([decisions record §12](20261104-rd-decisions-and-runtime-scope.md)). This sheet is kept as the record of what was considered and why; **no item on it is still open**. The options stay visible so a later reader can see the alternative that was rejected, not to invite a re-decision.

**Purpose:** one place for every decision that is **still open** after
rd-3 / rd-3b / rd-3c / rd-4 / rd-5 and hf-1 closed, with the options, the trade-offs and my
recommendation. Nothing here is authorized by reading it. This is a decision sheet, not a queue:
each item names the exact approval wording that would unblock dispatch.

**Closed and not re-openable here:** rd-3, rd-3b, rd-4, rd-5, hf-1 (merged and independently
reviewed); SV-D08 (route B), UI-RD-01, the approved copy table, and hf-1's tests-only scope.
**Not authorized in any case:** push, publication, visibility change, dependency change, ADR rewrite.

Read with the [live map](20261104-svg-implementation-map.md) §4 (decision register), the
[decisions record](20261104-rd-decisions-and-runtime-scope.md) and the
[design record §12](../../product/13-workbench-redesign-design-record.md).

## 0. If you only answer three

| Order | Decision                                                 | One-line recommendation                                                                                                        |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1     | **D-02 RD-T07** — human usability evidence               | Record an **explicit accepted limitation** now; run the participant protocol before any “intuitive/validated” claim.           |
| 2     | **D-03 + D-04** — rd-7 Help scope and performance budget | Minimal native-dialog Help (no new modal system) **and** pin the measured performance numbers instead of inventing thresholds. |
| 3     | **D-05** — web offline parity                            | Leave it documented for now; revisit only if launch copy claims the **web** app works offline.                                 |

## 1. Decision sheet

### D-01 — rd-6 scope: reuse, or reopen SV-D02 (DCR inspector)?

**Blocks:** rd-6 (pipeline and artifact context). **Today:** rd-6 would reuse the existing ordered
runner / gate / preview / lineage / delivery surfaces and need **no** new decision.

- **A. rd-6 as “reuse existing surfaces”** — present the shipped pipeline in the approved IA, add the
  journey evidence. No new string, no new lifetime, no new rendering.
- **B. rd-6 + SV-D02** — add a richer local-DCR inspector (summary + collapsed exact canonical YAML).
  Needs decisions on preview lifetime, invalidate triggers and retained data bounds, plus a
  canonical-fixture parity test.
- **C. Defer rd-6** until a real user asks for pipeline context.

**Recommendation: A, then revisit B only on demand.** The capability ships; B adds a surface with a
data-lifetime question attached, and “reuse” keeps the slice reversible. **Unblocks:** rd-6 scope.
**Not implied:** sv-8 (the conservative row) stays blocked under B unless separately chosen.

### D-02 — RD-T07: human usability evidence, or an accepted limitation?

**Blocks:** rd-7 (and any claim the redesign is easier/intuitive). **Facts:** no participant session has
been run for any slice; RD-T07 is unsatisfied; the protocol needs 5–8 participants, maintainer-organized
recruitment, and two synthetic study fixtures that are **not** committed yet (J2 contract+repair, J3
comparison pair).

- **A. Record an explicit accepted limitation** — “no human usability evidence; automated tests only”.
  Zero recruitment cost; forbids any “validated/intuitive” wording in docs and release notes.
- **B. Run the prepared protocol** (5–8 participants) on the built app, then record the aggregate table
  and limitations in the design record. Requires: recruitment, a compensation decision, and committing
  the two study fixtures (synthetic).
- **C. Internal walkthrough only** — useful for finding bugs, **not** evidence; must be labelled as
  non-evidence (the rd-2 heuristic walkthrough already is).

**Recommendation: A now, B before launch or any user-facing “easier” claim.** A is honest and free;
B is the only thing that can legitimately support a usability claim, and it is cheaper before launch
churn than after. **Unblocks:** rd-7 closure language. **Not implied:** A does not mean C counts as
evidence.

### D-03 — rd-7 Help: what gets built?

**Blocks:** rd-7. **Constraint:** core tasks must be completable **without** Help (already the
acceptance rule), so Help is secondary guidance, not a crutch.

- **A. Minimal native-dialog Help** — one global guide in a native `<dialog>`, app-local modal
  ownership arbitrated with Export / Telemetry / Settings, plus the axe/keyboard cases.
- **B. Contextual Help per task** — a help affordance in each task frame. More surface, more copy, more
  modal collisions.
- **C. No new Help** — rely on R-14 purposes, section summaries and existing hints; record the
  decision.

**Recommendation: A.** It satisfies RD-T05's Help case with one owned modal and no new system; B is
scope creep without evidence it is needed (see D-02). **Unblocks:** rd-7 Help part.

### D-04 — rd-7 performance budget: pin measured numbers or invent thresholds?

**Blocks:** rd-7 (RD-T08 expects per-slice performance evidence).

- **A. Pin the measured baseline** (first-paint, task-switch cost, query/render counts already asserted)
  as documented numbers with the existing tests as the guard — no new thresholds, no flaky timing gate.
- **B. Add explicit budget thresholds** (e.g. p95 switch time) — real gate, but needs a stable harness
  and a threshold you are willing to maintain.
- **C. Record “no performance claim”** and skip the gate.

**Recommendation: A.** The suite already pins render/query/worker counts; a wall-clock threshold on
shared CI hardware would be noise, and B should only follow a measured regression. **Unblocks:** rd-7
performance part.

### D-05 — web-side DuckDB-WASM extensions: bundle them for offline parity?

**Facts (measured):** the **web** app cannot open Parquet/JSONL cold without reaching
`extensions.duckdb.org`; CSV is unaffected. The **desktop** surface vendors the same pinned binaries and
blocks the host. `product/09` R-05 already documents “cold-cache offline opening is not promised”. hf-1
made the **test** harness deterministic without changing the product.

- **A. Leave as documented** — web keeps the CDN autoload; no bundle growth; the limitation stays in
  R-05 and the rehearsal.
- **B. Bundle the pinned extensions into the web build** — offline-capable web app; ≈3.6 MB growth
  (parquet 2.87 MB + json 0.72 MB), plus CSP/`connect-src` and supply-chain review, and a cache-busting
  question for returning users.
- **C. Bundle on demand** — keep CSV-only in the initial bundle, fetch/install the extension lazily from
  the same origin (a small local static route), falling back to the CDN only if the local file is absent.

**Recommendation: A for now; B/C only if launch copy claims offline web use.** The web app’s promise is
“data doesn’t leave the machine”, which holds; C is the best compromise if you want offline guarantees
without the initial-bundle cost. **Unblocks:** nothing today; it is a product-positioning decision.

### D-06 — rd-5’s recorded D2 gap: bar cannot see “comparison staged, not run”

**Facts:** `deriveNextAction` receives the run state only, so after staging B with a current valid
verdict the bar still offers the previous action. Recorded as a limitation in design record §12.

- **A. Leave it recorded** (current decision).
- **B. Add one approved state** `Comparisons staged — no comparison has run yet` → `Review comparison`,
  derived from `comparisonState === 'staged' && diffRun.kind === 'idle'` (new string, new input,
  truth-table + bar tests).

**Recommendation: A until the journey or a study shows it bites; then B.** B is small and safe but adds
copy and a derivation branch for a case the panel already handles. **Unblocks:** nothing.

### D-07 — SV-D03: guard dirty dataset replacement?

- **A. Defer** (current). **B. Implement** replacement-only Stay / Export / explicit Discard-and-choose,
  with a pending-draft decision (commit or cancel) and a picker/export sequence.

**Recommendation: A.** It is a real footgun but adds a modal flow and a draft-state rule; nothing this
programme has measured asks for it. Revisit with demand evidence (D-02 feeds this).

### D-08 — SV-D04: SQL sizing?

- **A. Defer** (current, unchanged since uxv-6). **B. Reopen**: specify sizing/placement and outcome
  focus, then implement.

**Recommendation: A.** No evidence; the deferral is deliberate.

### D-09 — SV-D05: overlay-aware profiling?

- **A. Defer** (current; file-as-opened profile is authoritative). **B. Specify** engine/client/state/
  consistency contract first, then implement.

**Recommendation: A.** This is not a label change; it changes what a number means.

### D-10 — SV-D07: VS Code format truth

**Facts:** VS Code declarations/docs mention Arrow-family extensions while the real engine input rejects
them; the web app advertises four formats only.

- **A. Documentation/manifest truth fix** (small, removes a false capability claim).
- **B. Implement Arrow input** (engine/data-source work, gated, separate row).

**Recommendation: A** as a small docs/manifest correction; **B** only under an explicit engine track.
**Unblocks:** an accurate capability statement; no runtime change under A.

### D-11 — run-origin metadata

- **A. Leave open** (current). **B. Scope readonly run metadata** (revision/origin) captured atomically
  in web session types, never in report/wire formats.

**Recommendation: A** unless a user needs to distinguish runs of different origins; the current
truthful stale wording already avoids implying origin.

### D-12 — release / publication / remote operations

**Facts:** nothing is pushed or published; the workstation branch is ahead of nowhere. The handoff
lists a private-dependency registry policy and a human release as remaining.

- **A. Keep local** (current). **B. Authorize a push** to a named remote/branch. **C. Authorize a
  release cut** (needs the changeset count re-checked and the registry policy decided first).

**Recommendation: A until you want the work shared**; if B, say the remote and branch explicitly, and
expect the remote-CI observation to be a separate record.

### D-13 — RECORDED FINDING: “Completed before the stop” includes the gate-blocked node

**Found by** the rd-6 review. `packages/engine-duckdb/src/pipeline-runner/runner.ts` records the
gate-blocked node's refusal in its outcomes before returning `gated`, and `PipelinePanel` labels every
recorded outcome “Completed before the stop”. So a node that was **stopped by the gate** is presented
under a “completed” heading. Pre-existing; out of scope for D-01 (fixing it needs copy and/or a
derivation change).

**Recommendation: record it, do not fix it now.** The rd-6 journey asserts node-level facts (status
`gated`, downstream `Pending`, no gate verdict/preview) and no longer codifies the misleading set as a
correct prefix. A later scoped slice should either relabel the section or exclude blocked outcomes.

### D-14 — RECORDED FINDING: “N outputs” counts gate/publish nodes

**Found by** the rd-6 review. `pipeline-model.ts` defines `isOutput = !consumed`, so terminal **gate** and
**publish** nodes count as “outputs” in the panel summary (a five-node plan can read “3 outputs”).
Defensible as “terminal plan node”, misleading if read as data outputs.

**Recommendation: record it; do not pin the count.** The journey deliberately does not assert the number.
Decide the meaning (label only, or a different derivation) in a later slice.

## 2. What is **not** pending (so it is not re-litigated)

- Route/IA (SV-D08 = B), UI-RD-01, the approved copy table, the slice-1 deferral, hf-1’s tests-only
  boundary, and the D1 labels — all decided.
- The e2e extension determinism: solved in the harness, not by changing the product.
- rd-3/rd-3b/rd-4/rd-5 closure states and their evidence.

## 3. Paste-ready authorization lines

```text
D-01: rd-6 as option A (reuse the existing pipeline surfaces; no DCR inspector).
D-02: RD-T07 option A — record an explicit accepted limitation, no usability claim.
D-03: rd-7 Help as option A (one native-dialog guide, arbitrated with Export/Telemetry/Settings).
D-04: rd-7 performance as option A (pin the measured numbers; no new time thresholds).
D-05: web offline parity option A — leave the documented CDN autoload; no bundling.
D-06: rd-5 D2 option A — leave the bar gap recorded.
D-07/D-08/D-09: keep SV-D03/SV-D04/SV-D05 deferred.
D-10: SV-D07 option A — documentation/manifest truth fix only.
D-11: leave run-origin metadata open.
D-12: keep local — no push, no publication.
```

Any single line can be answered alone; nothing else is inferred from it.
