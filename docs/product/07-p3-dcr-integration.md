# P3 — DCR Integration (Phase Document)

**Status:** ACTIVE — opened 2026-10-10 off rulings D16/D17; spec review RULED same day (**D19**,
2026-10-10); p3-1 landed (`dae8e83`); p3-2 landed (`72363b7`); queue six rows (p3-1b inserted
between p3-2 and p3-3); **p3-1b next**.
Execution queue: [P3 queue](../process/handoff/20261002-p3-queue.md) (scope/done-when/STOP per row).
Format rulings: [ADR 0046](../adr/0046-dcr-artifact-format-v1.md) + the ruled
[spec §9](06-dcr-artifact.md). This document proposes design and collects open questions; it does
not re-open any ruling.

---

## 1. Why this phase, and what this document is

P3 is the **DCR-integration stage of the pipeline track** — [roadmap §3.2](03-execution-roadmap.md):
"candidate DatasetVersion from pipeline runs, DCR generation", gated by
[ADR 0014](../adr/0014-dataset-change-request-model.md). The pipeline track (P1, P2) made runs real
end-to-end; M9/D17 fixed what a local DCR artifact _is_; P3 wires the two together: a gated or
completed run acquires a **candidate DatasetVersion reference** (Q4), a **pure builder** turns run
facts plus diff/validation surfaces into the **canonical artifact** (p3-1, landed), and both product
surfaces export it **byte-identically**.

Position in the document set: this file sits **above the queue file** —
[20261002-p3-queue.md](../process/handoff/20261002-p3-queue.md) owns execution mechanics, dispatch
order, per-row status, and closure counts — and **below the spec** —
[06-dcr-artifact.md](06-dcr-artifact.md) (with [ADR 0046](../adr/0046-dcr-artifact-format-v1.md))
owns the format rulings and is not amended here. What this document owns:

- the **phase purpose and outcome** (this section);
- a **per-row design expansion** of four of the five remaining queue rows (§4–§7 — p3-2…p3-5;
  the fifth, **p3-1b**, is designed in its queue cell) — rationale and grounding the queue cells
  deliberately omit, never a re-scope;
- **cross-cutting engineering notes** every row inherits (§8);
- and the **spec questions ruled 2026-10-10 (D19)** (§9) — eight questions the implementation
  surfaced where the D17 rulings bound but did not fully settle the answer. §9 is the honest-gap
  register for the phase; its outcomes are rulings or parked decisions — all eight now ruled
  (**D19**, outcomes inline).

## 2. Binding inputs

Nothing in this phase re-opens the D17 rulings (ruled 2026-10-02 — spec §9; ADR 0046 Accepted).
One-line digest of the twelve, each citable at the spec's §9 table:

1. **Q1** — canonical **YAML**, stamped `format: assay-dcr` + `version: 1`.
2. **Q2** — mirror M6's aspects (`schemaDrift` / `columnDeltas` / `rowDiff`); "profile delta" is
   satisfied by profile-derived nullability drift + distribution deltas; **no standalone profile
   diff**.
3. **Q3** — **embedded, bounded** payloads (M6 C1/K sample limits); **no reference mode**.
4. **Q4** — candidate identity = **logical id + schema fingerprint + provenance + a
   materialization reference**; **no full content hash**.
5. **Q5** — **both entry points** (CLI + web) off **one pure builder**; CLI first if capacity
   forces one.
6. **Q6a** — privacy findings deferred; the field slot carries an explicit **"not computed"
   disclosure**; no local producer is invented.
7. **Q7** — **explicit row-diff keys required** (typed located error otherwise); row delta
   explicitly absent without them; no silent inference.
8. **Q8** — evaluations **omitted entirely**, no reserved field (M8/G2 deferral recorded).
9. **Q9** — reserve the **`assay_dcr_*`** namespace.
10. **Q10** — **no artifact identity or status** — a standalone report file (the m5-3/m6-4 export
    precedent).
11. **Q11** — **no wall-clock** anywhere in canonical bytes.
12. **Q12** — **additive-only within v1**; non-additive = STOP-and-report; a version bump is a
    **maintainer-visible** decision.

**STOP boundaries (verbatim from the queue §2.3):** any publish-mode wiring (ADR
0033/0035 — the boundary stays explicit); any non-additive format change (D17-Q12 — additive-only
within v1 is a ruling constraint; a perceived need = STOP and report); any hosted-concern field
(comments/approvals/policy — ADR 0014's M10/G3 concerns); any boundary crossing outside the row's
scope column.

**Serialized lane (queue §2.2, shared with the PT-V slice-1 queue):** both queues touch
`packages/engine-duckdb`, so they run on ONE serialized dispatch lane — one queue at a time, one
row at a time; **P3 first by default**; a PT-V row touching only `apps/vscode/**` may interleave if
P3's in-flight row does not touch `engine-duckdb`.

**Publish boundary:** closed for the whole phase. Publish-mode materialization still refuses
([ADR 0033](../adr/0033-materialization-is-logical-and-backend-mapped.md) /
[ADR 0035](../adr/0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md)); no row wires
it, and the p3-2 refused-publish pin keeps that refusal load-bearing.

## 3. Phase surface and data flow

The chain, end to end:

```text
gated/completed pipeline run
  (engine-duckdb pipeline-runner: executePipeline → PipelineRunNodeResult[table/export/view])
        │
        ▼  p3-2 — candidate DatasetVersion reference (next)
DcrVersionRef: logical id + schema fingerprint + provenance + materialization ref  (Q4)
        │
        ▼  p3-1 — pure builder (LANDED, dae8e83)
buildDcrArtifact → canonical YAML bytes (format: assay-dcr / version: 1)
   packages/pipeline: dcr-{ast,errors,build,serialize,validate,parse,property-testing}.ts
   fixtures/dcr: gated-run / minimal / gated-run-alternate + refuses-* corpus (own manifest)
        │
        ▼  p3-1b — truncation/bounding disclosure keys (D19 OQ-4; after p3-2, before p3-3)
   additive optional disclosure key(s) on bounded payloads
        │
        ├──►  p3-3 — CLI `assay dcr`          ──┐
        └──►  p3-4 — web panel export action  ──┴─► byte-identical artifact bytes
                (LOAD-BEARING PIN: web ≡ CLI; M5/M6 exact-agreement precedent)
        │
        ▼  p3-5 — conformance + honesty sweep (closes the queue)
```

The queue is **six rows** since D19 (2026-10-10): **p3-1b** (truncation/bounding disclosure) runs
after p3-2, before p3-3 — p3-3's golden artifact is minted after it.

Where things live:

- **Runner:** `packages/engine-duckdb/src/pipeline-runner/{runner,plan,guard,errors}.ts` — key
  exports `executePipeline` and `PipelineRunNodeResult` (`runner.ts`; the per-node
  `relation`/`rowCount`/`materialization`/`exportPath`/`gate` surface),
  `LOCAL_RUN_MATERIALIZATION_MODES` = `['view', 'ephemeral', 'table', 'export']` (`plan.ts`), and
  `PipelineRunRefusalError` (`errors.ts`, re-exported through the runner `index.ts`).
- **Landed artifact core (p3-1):** `packages/pipeline/src/dcr-ast.ts` (the v1 grammar + canonical
  constants), `dcr-build.ts` (`buildDcrArtifact`), `dcr-serialize.ts` (byte-stable canonical
  YAML), `dcr-parse.ts` + `dcr-errors.ts` (total parser; located typed errors), `dcr-validate.ts`
  (cross-field rules), `dcr-property-testing.ts`; the committed corpus under `fixtures/dcr/`
  (golden artifacts + `refuses-*` rejection variants, checksummed by its own `manifest.json`).
- **CLI disciplines:** `apps/cli/src/report-shared.ts` (byte-stable JSON report envelopes,
  `REPORT_VERSION`) and `apps/cli/src/pipeline.ts` (the P2 gate-refusal exit classes).
- **Web export discipline:** the m5-3/m6-4 precedents `apps/web/src/diff/diff-export.ts` and
  `apps/web/src/validation/report-export.ts` — always a NEW sanitized file, never a rewrite
  ([ADR 0012](../adr/0012-edit-overlay-and-transaction-semantics.md)).

## 4. p3-2 — candidate DatasetVersion from gated runs

Queue row, verbatim:

> `packages/engine-duckdb/src/pipeline-runner/**` + `packages/pipeline/**`. Derive the candidate
> reference (Q4) from a completed/gated run's materialized output (`PipelineRunNodeResult`
> `table`/`export`/`view`; the runner's value-free `exportPath` — ADR 0025: no sensitive paths).
> The publish boundary stays explicit: publish-mode materialization still refuses (ADR 0033/0035)
> — do NOT wire publish. Done-when: the runner produces the candidate reference for
> completed/gated runs; refused/absent outputs → typed located errors; unit pins incl. a
> failing-before-fix pin for the refused-publish path; value-free checks. `feat(p3-2):` +
> changeset (`@assay/engine-duckdb`, `@assay/pipeline` as touched). **Second.**

Design notes:

- **Input mapping (the Q4 quartet ← runner data).** The landed reference shape is
  `DcrVersionRef` (`packages/pipeline/src/dcr-ast.ts`): `datasetId` + `versionId` +
  `schemaFingerprint {algorithm, value}` + optional `provenance {transformationRecipe?,
parentVersionIds?}` + a `materialization` of `{node} | {export}`. Mapping: the **logical id**
  comes from the run's dataset identity (not a file path); the **schema fingerprint** comes from
  engine introspection of the materialized view/ephemeral/table relation the producing node left
  behind (the runner's native modes are view/ephemeral/table/export — export goes via the export
  form; reviewer note, 2026-10-10: the queue's `table`/`export`/`view` phrasing was loose,
  `ephemeral` added here); the
  **provenance** carries the run + node identity (the plan as `transformationRecipe`, the input
  datasets as `parentVersionIds` — no wall-clock, per Q11); the **materialization reference** uses
  the node form or the export form, with the runner's value-free `exportPath` (`pipelineExportPath`
  → the OPFS scratch convention; ADR 0025 — no sensitive paths).
- **Refusal discipline.** A run without a usable materialized output (refused publish, absent
  node, unmappable mode) yields typed located errors in the existing `PipelineRunRefusalError`
  class family — never a silent fallback and never a thrown raw error across the seam.
- **The refused-publish pin.** The publish boundary is enforced by a failing-before-fix unit pin:
  a publish-mode run asked for a candidate reference refuses; wiring it would have to delete the
  pin (STOP boundary §2).
- **Risks.** The materialization reference points at mutable runner state and the fingerprint
  algorithm's stability was unpinned — both were formally open and are now ruled (**D19**,
  2026-10-10): §9 OQ-5 (export-time liveness refusal; parse stays dangling-tolerant) and §9 OQ-6
  (fingerprint-stability fixture in p3-5's sweep).
- Done-when is the second half of the quoted cell; gates per §8; commit `feat(p3-2):` +
  changesets `@assay/engine-duckdb` and `@assay/pipeline` as touched.

## 5. p3-3 — CLI entry point `assay dcr`

Queue row, verbatim:

> `apps/cli/**` (+ the p3-1 builder, the p3-2 candidate reference). Generate the artifact off a
> gated/completed run (and/or explicit base/candidate refs), writing a NEW file (never rewrite —
> ADR 0012); match the CLI exit-code/error-envelope disciplines (`report-shared.ts`, the
> `pipeline.ts` gate-refusal classes); honest no-verdict handling for gated runs (the p2-5
> precedent). Done-when: `assay dcr` end-to-end on a golden gated run; a committed golden YAML
> artifact (synthetic, value-free) + byte-stability pin; an integration test per the `pipeline.*`
> pattern; a changeset per repo precedent. `feat(p3-3):` + changeset (`@assay/cli`). **Third.**
> **D19 OQ-5:** export refuses loudly on dangling materialization refs (typed error, refusal
> discipline); parse stays dangling-tolerant. Goldens minted after p3-1b.

Design notes:

- **Two invocation shapes, one builder.** The subcommand can source its inputs from a gated or
  completed run and/or from explicit base/candidate references; both paths call the same
  `buildDcrArtifact` — no second construction code path exists (Q5's one-builder ruling is what
  makes §6's byte pin achievable at all).
- **File discipline.** The artifact is written as a NEW file, never a rewrite of an existing path
  ([ADR 0012](../adr/0012-edit-overlay-and-transaction-semantics.md) — immutable formats are
  overlay/append, never in-place mutation).
- **Exit codes and error envelopes.** Refusals reuse the `pipeline.ts` gate-refusal exit classes;
  parse/build failures render through the located-error discipline (machine-readable `code`,
  actionable message, document `path`, `line`/`column`) rather than ad-hoc stderr prose; envelope
  metadata follows `report-shared.ts`.
- **Honest no-verdict handling.** A gated run whose verdicts are absent (the p2-5 carry-over
  class) exports honestly — the artifact carries what exists and the CLI says what does not, per
  the repo's no-faked-verdict rule.
- **Golden artifact + byte pin.** A committed, synthetic, value-free golden YAML with a
  byte-stability pin (regenerating it must be a no-op), and an integration test following the
  `pipeline.*` CLI pattern.
- **Flag surface is worker freedom.** The exact flags (`--keys`, ref syntax, output path
  handling) are not ruled here — any surface is acceptable that stays inside the disciplines
  above.

## 6. p3-4 — web panel action off a gated run

Queue row, verbatim:

> `apps/web/src/pipeline/**` (+ the shared builder). Export action on completed/gated runs
> delivering a new sanitized file (the m5-3/m6-4 export discipline:
> `diff-export.ts`/`report-export.ts`); a11y + keyboard parity with the panel (the p2-6
> patterns); value-free. Done-when: a web export e2e (playwright, existing panel style) asserting
> delivery + a value-free content pin; dual-scheme axe clean; **LOAD-BEARING PIN: web≡CLI
> byte-agreement** — the same golden gated run exports byte-identical artifact bytes from CLI and
> web (the M5/M6 exact-agreement precedent). `feat(p3-4):` + changeset (`@assay/web`). **Fourth.**
> **D19 OQ-5:** same export-time liveness refusal on the web path.

Design notes:

- **Export action, sanitized, new file.** The pipeline panel (p2-6 surface) gains an export
  action available once a run reaches `completed` or `gated`; delivery mirrors the m5-3/m6-4
  discipline — a new sanitized file, never a rewrite, never dataset values.
- **Accessibility is part of done.** Keyboard parity with the panel's interactions (the p2-6
  journey patterns) and a clean dual-scheme axe scan with the allowlist still empty.
- **The load-bearing pin.** The same golden gated run must export **byte-identical artifact
  bytes** from CLI and web — the M5/M6 exact-agreement precedent made a pin. This is the phase's
  one product-level promise that the artifact is a _format_, not a per-surface rendering, and it
  is the only queue row whose gate set includes e2e.
- **Risk note (honest).** The pin is only as strong as the serializer being environment-independent
  pure TypeScript: both surfaces consume the same `@assay/pipeline` builder and serializer, so the
  pin holds within a build by construction. What it does **not** pin is stability across releases
  (a dependency upgrade changing YAML escaping would move both surfaces together, preserving the
  pin while changing the bytes) — that is §9 OQ-3, now ruled (**D19**, 2026-10-10): cross-release
  byte-stability is the fixture-corpus policy (serializer drift = fixture failures); the
  tool-version stamp was rejected.

## 7. p3-5 — conformance + honesty bundle

Queue row, verbatim:

> `packages/pipeline/**`, `apps/cli/**`, `apps/web/**` (test-only + small discovered fixes).
> Round-trip sweep (every committed fixture parse→serialize→byte-identical; corrupt variants →
> located errors, never throws); an additive-only guard test (unknown keys → version-stamped
> rejection, per Q12); a reserved-namespace sweep; fixes only for sweep-exposed defects (each
> with a fixture + regression test per AGENTS.md). Done-when: sweep green; no new features
> smuggled in. `test(p3-5):`/`fix(p3-5):` + changeset only if packages changed. **Last — closes
> the queue.** **D19 OQ-6(b):** fingerprint-stability fixture (schema set → expected fingerprints)
> joins the sweep.

Design notes:

- **Round-trip over the whole corpus.** Every committed `fixtures/dcr/` artifact parses,
  re-serializes byte-identically; every `refuses-*` variant yields located typed errors and never
  a throw.
- **Additive-only is tested, not asserted.** Unknown top-level and nested keys are rejected with
  the version-stamped error (Q12) — the guard test proves the parser refuses what a future
  producer might add, which is what makes "additive-only" a real constraint rather than a doc
  line.
- **Reserved-namespace sweep.** `assay_dcr_*` stays out of user-content id positions in both
  directions (build and parse).
- **Fixes are scoped by the sweep.** Only defects the sweep exposes are fixed, each with a
  minimal golden fixture + regression test (AGENTS.md fixture rule); anything that smells like a
  feature is a STOP.

## 8. Cross-cutting engineering notes

- **Gates per row:** the standing seven (`format:check` / `lint` / `typecheck` / `test` /
  `test:coverage` / `build` / `docs:links:check`), **plus e2e for p3-4 only** (web-visible).
- **Standing invariants:** value-free everywhere per
  [ADR 0025](../adr/0025-telemetry-and-data-privacy-boundary.md) — dataset contents, raw SQL
  results, sensitive paths, **including fixtures and the committed golden artifacts**; `domain`
  stays dependency-free; `pipeline` stays free of dbt/SQLMesh/Dagster runtimes
  ([ADR 0031](../adr/0031-dbt-sqlmesh-as-compatibility-and-execution-adapters.md) /
  [ADR 0032](../adr/0032-separate-transformation-dag-from-orchestration.md)); packages never
  import apps; one Conventional Commit + changeset per row; workers never touch `docs/**` (the
  orchestrator owns paperwork).
- **Flake watch:** the known host-load class (`row-diff-agreement`, `contracts/round-trip`,
  `validation/re2`, `validation/duckdb-agreement`, `ux.integration.test`, e2e abort-under-load) —
  re-run the affected spec in isolation, note the outcome, escalate only on pattern (queue §4).
- **Serialized lane:** shared with the PT-V slice-1 queue (queue §2.2). **Roster flag (live):**
  the pinned Go lanes returned 429 GoUsageLimitError at p3-1; the **rotated roster is active**
  (handoff §9 eh) — restore/rotate the Go lane before the next pinned dispatch or continue on the
  rotated roster, per the queue row note.

## 9. Open spec questions — the v1 adversarial review

**Status: RULED (D19, 2026-10-10).** Opened with this document (2026-10-10); all eight questions
were ruled the same day by **D19**
([rulings file](../process/handoff/20260926-maintainer-rulings.md)) — each question carries its
outcome inline below. Nothing here re-opens D17. Each question states context, why it
matters, options, and which ruling bounds it. Every outcome must land as **additive-within-v1**
(Q12) or be parked for v2/hosted; durable answers get [ADR 0047](../adr/README.md)+ or a roadmap §7
backlog entry, and answers fold back into this section. Nothing changes the landed v1 grammar
without a ruling.

**OQ-1 — Enum closure vs additive-only.** _Context:_ the landed v1 grammar is built on closed
string-literal unions — `DCR_SCHEMA_DRIFT_KINDS` (six members), `DCR_ROW_DIFF_ASPECTS`
(`added`/`removed`/`changed`), `DCR_COLUMN_FAMILIES` (eight members), and
`DcrPrivacyFindings.status` (one member, `not-computed`); the strict parser rejects unknown
members, and the `refuses-*` fixtures prove the refusal discipline. _Why it matters:_ Q12's
"additive-only" reads naturally as "new keys may appear", but a new **discriminator value** (a
fifth drift kind, a new verdict status, a new row-key kind) is an unknown-enum rejection in every
strict v1 parser — so additive-only de facto means **record-shape-only**, and any enum extension
is a v2 bump (maintainer-visible per Q12). That makes v1's enum spaces **permanently closed**,
which is a stronger promise than the ruling's words. _Options:_ (a) confirm the strict reading
(record-shape-only; enums closed for v1's life); (b) loosen parsers to tolerate unknown enum
values (breaks strictness; effectively a format weakening). _Bounds:_ Q12 (additive-only),
Q1 (the strict total-parser discipline). The recommendation is (a); it needs an explicit
confirmation because it narrows Q12.

**Ruled (D19, 2026-10-10):** "optional keys is alright, however yes, any enum keys will need version
bump, also the hash we need for prompts version needt o have the optinal keys in as well" — new
**optional record keys are additive within v1**; **ANY new enum/discriminator member is a version
bump** (maintainer-visible per Q12) — v1's enum spaces are closed. Supplementary clause recorded
VERBATIM (the quote's final segment), interpretation **confirmed by maintainer 2026-10-10**: any
digest computed over a DCR artifact (e.g., future prompt-version pinning) runs over the FULL
canonical serialization including optional keys — optional keys are never stripped from hashed
content.

**OQ-2 — The disclosure-shape trap (`privacyFindings`).** _Context:_ the landed slot is **not** a
bare string — it is a tagged object (`packages/pipeline/src/dcr-ast.ts`):

```typescript
/** The privacyFindings slot: the one canonical "not computed" spelling (D17-Q6a). */
export interface DcrPrivacyFindings {
  readonly status: 'not-computed'
  readonly disclosure: string
}
```

with `disclosure` pinned to the exact constant
`'Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046,
ruling D17-Q6).'` — any other spelling is a parse/build error, so two artifacts of the same facts
stay byte-identical. The naive scalar→union trap is therefore already avoided; the **sharper** trap
remains: `status` is a closed **single-member** union and `disclosure` is a required
exact-string field, so evolving to computed findings later needs a new `status` value (closed-enum
→ OQ-1) **and** a `disclosure` that can no longer carry its pinned constant meaningfully — i.e. a
required field must be removed or repurposed, which is non-additive = v2. _Why it matters:_ this
is the one field whose v1 shape was chosen _for_ an absent producer (Q6a); if a producer lands in
M8/G2's orbit, the migration cost is fixed now or paid then. _Options:_ (a) accept — the honest
"not computed" disclosure is worth exactly this, and a v2 migration happens when a real producer
exists; (b) re-shape **now** within v1 authoring (e.g. widen `status`, make `disclosure`
conditional) the way the bins omission was a v1-authoring scope decision — but note Q6a ruled the
_exact-string_ disclosure as the byte-identity mechanism, so any reshaping is a change to the
landed v1 grammar and needs an explicit ruling, not an authoring choice. _Bounds:_ Q6a (exact
disclosure), Q12 (additive-only), Q8 (the no-reserved-fields precedent argues (a)). The sharpest
structural question in this list.

**Ruled (D19, 2026-10-10): (a) — accept.** The tagged shape stands as landed; a future "computed"
evolution is a v2 union member that replaces the disclosure — a v2 concern only.

**OQ-3 — Byte-agreement scope across tool versions.** _Context:_ p3-4 pins web≡CLI
byte-agreement **within a build**. Cross-release byte-stability — the same logical DCR serialized
by two different tool versions yielding identical bytes — is pinned nowhere. The serializer is
pure TS over a fixed canonical form, but it rides the `yaml` dependency (exactly pinned
`2.9.1` in `packages/pipeline/package.json`, confirmed) with `lineWidth: 0` and fixed flow/block
styles; an upstream upgrade can change escaping or quoting, moving the bytes of every surface at
once. _Why it matters:_ byte-stability is the format's core promise (Q11's rationale); "stable"
is what G3 requires the format to be. _Options:_ (a) golden cross-version fixtures + a release
gate that serializes the corpus and compares against committed bytes (catches an upgrade-induced
drift before publish); (b) scope byte-agreement to within-release and document cross-release
non-promise. _Related borderline:_ a **tool-version stamp** in the artifact would make drift
diagnosable, but it brushes Q10 (no artifact identity) and Q11 (no wall-clock — a version stamp is
neither identity nor wall-clock, strictly, but it is identity-adjacent); it needs a ruling if
chosen. _Bounds:_ Q1/Q11 (canonical bytes), Q10 (no identity), Q12 (additive-only — a stamp would
be additive, but its semantics are not ruled).

**Ruled (D19, 2026-10-10): proceed as recommended — (a), enforced by the golden fixture corpus.**
Cross-release byte-stability holds because serializer changes surface as `fixtures/dcr/` fixture
failures (regeneration deliberate + changeset). The **tool-version stamp is REJECTED** (Q10
adjacency).

**OQ-4 — Truncation disclosure for bounded payloads.** _Context:_ Q3 embeds bounded payloads at
M6's limits. The row-diff block already discloses its bound by construction — `sampleLimit` (the
K), `rowCountA`/`rowCountB`, and per-aspect exact counts "over the full relations (never the
sample bound)" — so a reader can always see samples were bounded. The distribution deltas' top-k
categorical entries carry no equivalent in-artifact marker of their bound; exceeding a limit
bounds the payload **silently** unless the schema says otherwise. _Why it matters:_ the repo's
honesty discipline (C2's verbatim inference disclosure, `--infer` opt-in) argues a review artifact
should not silently elide; but the count-vs-samples pattern may be judged sufficient for the
remaining fields. _Options:_ (a) an in-artifact disclosure/bound field per bounded payload
(additive within v1 — arguably v1-authoring scope like the bins decision, but honesty-relevant
enough to surface rather than decide silently); (b) silent bounding, documented only in the spec
(§3 current posture). _Bounds:_ Q3 (embedded bounded payloads), Q2 (M6 aspect mirror — a disclosure
field must not fork the mirrored shapes). Leaning (a) per the honest-gap pattern; needs a ruling
because it adds surface.

**Ruled (D19, 2026-10-10): "yup add the disclosure field."** Truncation/bounding disclosure
authorized as **v1-authoring** — additive optional key(s) disclosing when an embedded payload
aspect hits its M6 bound (the bins precedent). Executed as new queue row **p3-1b** (runs after
p3-2, before p3-3 — p3-3's golden artifact depends on it).

**OQ-5 — Materialization-reference mutability.** _Context:_ the Q4 materialization reference
(`{node} | {export}`) points at runner state — a DuckDB table/view the run left behind, or the
OPFS `assay-exports/` scratch path — which can be dropped, re-materialized, or garbage-collected
while the artifact survives. The artifact's evidence chain can rot **silently**: nothing in the
format records whether the referenced materialization still exists. _Why it matters:_ a DCR whose
candidate cannot be re-opened is still an honest _report_ (Q10 — a report file), but a consumer
that follows the reference needs to know it may dangle. _Options:_ (a) liveness check at export
time (p3-3/p3-4 refuse or warn when the reference is already dangling); (b) dangling-tolerant
parse with an out-of-band disclosure (consumer-side check, format unchanged); (c) content-addressed
materialization (v2/hosted — the Q4 no-content-hash ruling deliberately excluded it from v1).
_Bounds:_ Q4 (the reference form), Q10 (no status in the artifact — rules out an in-artifact
"live/dead" flag without a ruling), ADR 0025 (any liveness UX stays value-free). Leaning (a)+(b)
for v1, (c) parked.

**Ruled (D19, 2026-10-10): "refuse Loudly" — (a) at export; parse stays dangling-tolerant.**
Exporting a DCR off a dangling materialization reference REFUSES with a typed error (refusal
discipline); parse remains dangling-tolerant — the artifact is an evidence snapshot (unchanged v1
behavior; Q10). Pinned in p3-3 and p3-4.

**OQ-6 — Schema-fingerprint stability.** _Context:_ the candidate reference carries
`schemaFingerprint {algorithm, value}`; the `algorithm` field is a free-form string and **nothing
landed pins which algorithm produces it or that its semantics never change** — p3-2 will source it
from engine introspection of the materialized relation. _Why it matters:_ candidate matching
across releases (and the G3 "stable format" claim) quietly depends on the fingerprint being the
_same function over time_; a silent algorithm change would make cross-version artifacts
incomparable without any error ever firing. _Options:_ (a) p3-5 pins it: a fingerprint-stability
fixture (fixed relation shape → fixed `algorithm`+`value` pair) + a documented algorithm name;
(b) leave it as producer freedom (the artifact records what was used, comparability is the
producer's problem). _Bounds:_ Q4 (fingerprint in identity), Q12 (pinning is additive/test-only).
Leaning (a); cheap to land inside p3-5's sweep.

**Ruled (D19, 2026-10-10): "b)" — fixture only, no frozen-name policy.** The fingerprint-stability
fixture joins p3-5's sweep; the algorithm-names-frozen policy is NOT adopted — the maintainer
picked only (b): the artifact records what was used, and cross-version comparability remains the
producer's concern.

**OQ-7 — Row-key re-diff stability.** _Context:_ `DcrRowDiffSample.rowKey` values live in the
anchor-free export grammar `base:<n>` / `insert:<n>` / `b:<n>` — **sample ordinals**, not content
keys. Re-diffing the same dataset pair with a different diff-engine version (or different plan
parameters) can yield different ordinal assignments and even different sample sets. Keys are
stable **per artifact generation**, not across re-generation. _Why it matters:_ an artifact
consumer that treats row keys as stable identifiers across artifacts would silently mis-join;
the alternative — pinning diff determinism across engine versions — is an engine-level guarantee
P3 does not own. _Options:_ (a) accept: the artifact is an **evidence snapshot, not an identity
system** (consistent with Q10's no-identity ruling); document the per-generation scope;
(b) pin diff determinism (an engine conformance commitment beyond this phase's scope, likely
v2/hosted). _Bounds:_ Q7 (explicit keys, anchor-free grammar), ADR 0011/0012 (logical identity
lives in the version reference, not in sample keys). Leaning (a).

**Ruled (D19, 2026-10-10): (a) — accept.** Row-keys are stable per-generation only
(evidence-snapshot semantics, consistent with Q10); re-diff determinism is the diff engine's
contract (M6), not the artifact format's.

**OQ-8 — Old-tool loud-fail on additive fields.** _Context:_ the strict unknown-key refusal is
correct for format hygiene, but it means an artifact written by a **newer** tool carrying an
additive v1 field is **rejected outright** by an **older** tool. A local-first user holding
artifacts across an upgrade hits a hard parse failure, not a degraded read. _Why it matters:_
"extensible superset" (Q12) can be read two ways: newer tools write supersets that older tools
tolerate-and-ignore, or older tools loudly refuse what they do not know. The landed parser and
the Q12 "unknown keys → version-stamped rejection" discipline imply **loud-fail**. _Options:_
(a) confirm loud-fail as intended product behavior, and require the rejection to be
version-stamped and actionable (the error names the artifact's `version: 1` vs the tool's
supported set — upgrade guidance, not a bare code); (b) tolerate-and-ignore unknown keys in v1
(weakened strictness; makes typos silently pass, contradicts the refusal discipline). _Bounds:_
Q12 (whose wording — "extensible superset" + version-stamped rejection — already leans (a)),
Q1 (the total strict parser). Leaning (a) with the messaging requirement; needs an explicit
confirmation because it is a product-behavior call, not just a format one.

**Ruled (D19, 2026-10-10): "yup" — (a) loud-fail confirmed as intended product behavior.** Strict
unknown-key refusal + version-stamped rejection (the error names the artifact's `version: 1` vs the
tool's supported set); never silently softened.

## 10. Out of scope (this phase and v1)

- **Publish mode** — the boundary stays explicit and refused
  ([ADR 0033](../adr/0033-materialization-is-logical-and-backend-mapped.md) /
  [ADR 0035](../adr/0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md)).
- **Hosted-concern fields** (comments/approvals/policy) — M10/G3 per ADR 0014.
- **vscode-web** — D18 keeps it RE-SCOPE; no P3 row touches it.
- **Non-additive format changes** — Q12; a perceived need is a STOP (§9 outcomes are the only
  lawful path).
- **Reference-mode payloads** — Q3 ruled embedding only.
- **Full content hash** in the version reference — Q4.
- **Standalone profile diff** — Q2.
- **Evaluations** — Q8 (M8/G2 deferral).
- **Any G-gated hosted/enterprise work** — G3/G4 gates do not pass on this phase.

## 11. Closure criteria

- All six queue rows landed (p3-1 ✅, p3-1b, p3-2…p3-5) with the p3-5 sweep green and counts
  recorded
  (queue §5 closure block: per-row outcomes, counts at close, the **G3 evidence note** — "DCR
  artifact format stable (M9 done)", [roadmap §5](03-execution-roadmap.md)).
- §9 dispositions recorded: each open question either answered (folded here + roadmap §7) or
  explicitly parked, with any durable outcome in ADR 0047+.
- Re-points completed: handoff §6 closed-table row, roadmap §4 checkboxes,
  [product/04](04-post-mvp-track.md) track status.

## 12. References

- [ADR 0011 — Dataset identity and versioning](../adr/0011-dataset-identity-and-versioning.md)
- [ADR 0012 — Edit overlay and transaction semantics](../adr/0012-edit-overlay-and-transaction-semantics.md)
- [ADR 0014 — Dataset change request model](../adr/0014-dataset-change-request-model.md)
- [ADR 0025 — Telemetry and data privacy boundary](../adr/0025-telemetry-and-data-privacy-boundary.md)
- [ADR 0033 — Materialization is logical and backend-mapped](../adr/0033-materialization-is-logical-and-backend-mapped.md)
- [ADR 0035 — Validation and publish gates are first-class DAG nodes](../adr/0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md)
- [ADR 0046 — DCR artifact format v1](../adr/0046-dcr-artifact-format-v1.md)
- [Spec 06 — DCR artifact, ruled §9](06-dcr-artifact.md)
- [P3 queue — execution + status](../process/handoff/20261002-p3-queue.md)
- [Roadmap 03 — §3.2 P3 / §5 G3 / §7 backlog](03-execution-roadmap.md)
- [Post-MVP track](04-post-mvp-track.md)
- [Operating model](../process/handoff/operating-model.md)
- [Handoff](../process/handoff.md)
