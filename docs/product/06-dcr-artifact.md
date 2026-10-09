# DCR Artifact — v1 Scoping Proposal (M9)

**Status:** scoping proposal (queue row **m9-1**, 2026-10-02, authorized by ruling **D16**) —
**it proposes; it does not decide.** **RULED 2026-10-02 (D17): accepted as recommended; ADR 0046 is
now Accepted.** Companion: [ADR 0046](../adr/0046-dcr-artifact-format-v1.md).
The binding source for what a DCR _is_ is [ADR 0014](../adr/0014-dataset-change-request-model.md);
the M9 **format ruling was requested as D17** (§9) and has now been made. Everything ADR 0014 does
not settle is an explicitly-listed open question below — **nothing in this document binds until the
D17 ruling** (now passed), and ADR 0046 is flipped to Accepted only by that ruling (done).
(Operating-model §7.5 solo docs mode; queue [ptv-m9](../process/handoff/20261002-ptv-m9-queue.md) §3
D16 discipline.)

---

## 1. Why M9, and what this document is

M9 is **Local DCR generation** ([roadmap §3.1](03-execution-roadmap.md)): a candidate
DatasetVersion → change-request artifact (schema/quality/drift/privacy). It is the local
groundwork for **P3** (DCR integration, roadmap §3.2) and one of **G3**'s evidence items — G3's
list requires "DCR artifact format stable (M9 done)" before hosted-workspace build-out
([roadmap §5](03-execution-roadmap.md)).

This document is the scoping **proposal** D16 authorized. It:

- fixes the **v1 field selection** from ADR 0014's list against the local surfaces that already
  exist (M5 validation, M6 diff, P2 pipeline/lineage);
- records what is **explicitly out of v1** and why;
- describes the **format discipline** to follow (the `@assay/contracts` / pipeline-IR precedent,
  read from source — not invented);
- defines the **local candidate-DatasetVersion** a generated artifact references;
- proposes **generation entry points**;
- and collects the **D17 open questions** (all ruled 2026-10-02 — §9).

**Out of scope for this document:** anything that would bind the format. No P3 queue is authored
here; the P3 queue is authored only after D17 (queue §3 D16 discipline) — **D17 passed 2026-10-02,
so P3 authoring is unblocked.**

---

## 2. Binding inputs, and the boundary ADR 0014 draws

The authoritative model (quoted) is [ADR 0014](../adr/0014-dataset-change-request-model.md):

> Introduce DatasetChangeRequest comparing a base DatasetVersion with a candidate version and
> capturing schema/row/profile/distribution changes, validation, privacy findings, lineage,
> evaluations, comments, approvals, and policy checks.
>
> … creates a strong team-product primitive. **The local tool should still be able to generate a
> standalone DCR report without hosted services.**

Supporting model: [ADR 0011](../adr/0011-dataset-identity-and-versioning.md) separates stable
Dataset identity, immutable DatasetVersion, and PhysicalAsset representations; versions record
schema fingerprint, source references, hashes where feasible, row/partition metadata, provenance,
and transformation lineage. [ADR 0012](../adr/0012-edit-overlay-and-transaction-semantics.md)
represents edits as an **overlay over an immutable base**; "commit creates a new file/version"
and "stable row identity is required". The domain scaffold already carries a
`DatasetChangeRequest` aggregate (`packages/domain/src/index.ts`: `baseVersionId`,
`candidateVersionId`, `DcrSummary`) — M9's local artifact is the file form that aggregate will be
built from.

### 2.1 What ADR 0014 already settles (binding; not re-opened)

1. A DCR **compares a base DatasetVersion with a candidate** version.
2. It **captures** the named category list (schema/row/profile/distribution changes, validation,
   privacy findings, lineage, evaluations, comments, approvals, policy checks).
3. A **standalone local DCR report must be generatable without hosted services** — the
   standalone-report consequence.

### 2.2 What ADR 0014 leaves open (→ §9 D17 — ruled 2026-10-02)

ADR 0014 names **categories, not a schema**. It does not settle: the serialization format; the
concrete field names/shapes; embed-vs-reference for the per-aspect payloads; the local
candidate-DatasetVersion identity; the artifact's own identity/versioning; the generation entry
point(s); how "privacy findings" are produced locally; the fate of "evaluations" (M8/G2); or
forward-compatibility with the M10 hosted review. Every one of these was an explicit D17 question
in §9, and all are now ruled (2026-10-02).

---

## 3. v1 field selection

**Legend for "local derivation":** the surface that already exists in the repo today and could
feed the field without new engine capability. "In v1" means _ruled for v1_ by D17 (2026-10-02; §9).

| ADR 0014 field         | v1           | Local derivation surface (today)                                                                                                                                                                      | Grounding                                                                 |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Schema delta**       | **In**       | `@assay/diff` schema drift — `typeDriftFindings` / `nullabilityFindings` in `packages/diff/src/schema-drift.ts`; rendered by the m6-4 diff panel and `assay diff`                                     | ADR 0011; `packages/diff/src/report.ts` (`DiffReport.schemaDrift`)        |
| **Row delta**          | **In**       | `@assay/diff` row diff — `row-diff-plan.ts` / `row-diff-compile.ts`; engine aspect in m6-2 `executeDiffCore`; `assay diff`                                                                            | ADR 0011/0012; `packages/diff/src/report.ts`                              |
| **Profile delta**      | **In**       | profile-derived nullability drift (`packages/diff/src/schema-drift.ts`) and the profile summaries (`packages/diff/src/profile.ts`)                                                                    | ADR 0011; m6-0 model                                                      |
| **Distribution delta** | **In**       | `@assay/diff` `deltas.ts` — checkpoint-C1 metric set (numeric mean/variance/p50/p90 shifts; categorical TV distance + new/vanished lists)                                                             | ADR 0011; `packages/diff/src/deltas.ts`                                   |
| **Validation**         | **In**       | `@assay/contracts` + `@assay/validation` compiled plans; engine `validate` (m5-2); `assay validate` (m5-4) — already reused by P2 validate gates (p2-4)                                               | ADR 0013/0026; `apps/cli/src/report-validate.ts`                          |
| **Privacy findings**   | **In\***     | **No local producer exists today.** The vocabulary exists (domain `Classification`, `packages/domain/src/index.ts`; product 01 §10.1 labels), but no M5/M6/P2 surface emits findings. See **D17-Q6**. | ADR 0014; ADR 0013 (classifications); `docs/product/01-features.md` §10.1 |
| **Lineage**            | **In**       | P2 pipeline lineage derived from the IR DAG (`packages/pipeline/src/dag.ts`; p2-6 panel lineage) + engine `PipelineRunNodeResult` + ADR 0011 `Lineage`/`Provenance`                                   | ADR 0011/0030; `packages/domain/src/index.ts` (`Lineage`, `Provenance`)   |
| **Evaluations**        | **Deferred** | none locally — M8 AI dataset mode is G2-gated (roadmap §5)                                                                                                                                            | ADR 0009; roadmap §3.1 M8 row                                             |
| **Comments**           | **Out**      | hosted review concern (M10)                                                                                                                                                                           | ADR 0014; roadmap §3.1 M10 row                                            |
| **Approvals**          | **Out**      | hosted review concern (M10); domain `Review` is a hosted aggregate                                                                                                                                    | ADR 0014; `packages/domain/src/index.ts` (`Review`)                       |
| **Policy checks**      | **Out**      | enterprise governance (G3/G4); no local policy engine exists                                                                                                                                          | ADR 0014; ADR 0018/0006; roadmap §5 G3/G4                                 |

\* "In" for the field slot, with its local producer unresolved — the question was listed and ruled
(D17-Q6: deferred, carried as an explicit "not computed" disclosure; §9).

### 3.1 Schema / profile / distribution deltas

M6 is the local diff surface. `diffDatasets` (`packages/diff/src/report.ts`) is the front door and
returns a plain, JSON-stable `DiffReport` with documented aspect order — **schema drift first, then
column deltas** (the docs-07 honesty rule made structural). The report carries
`schemaDrift` (`SchemaDriftFinding[]`), `columnDeltas` (`ColumnDistributionDelta[]`), and collected
`issues` (`DiffIssue[]`). The DCR artifact is a natural consumer of exactly this model, plus the
row-diff aspects (`row-diff-plan.ts`, engine `executeDiffCore`).

Two honesty notes carried into the DCR field schema (and ruled by D17):

- ADR 0014's four delta categories do **not** map 1:1 onto M6's two model aspects (schema drift +
  distribution deltas) plus the row-diff aspect. How "profile delta" decomposes from M6's output
  is a schema question — ruled by **D17-Q2** (mirror M6's aspects; §9).
- M6's row diff takes an **explicit key set and never infers it silently** (checkpoint C2;
  `--infer` is an explicit opt-in). A locally generated DCR inherits that discipline — see
  **D17-Q7** (ruled: explicit keys required, row delta absent without them; §9).

### 3.2 Validation

`@assay/contracts` fixes the portable vocabulary and shape
(`packages/contracts/src/ast.ts`); `@assay/validation` compiles rules to deterministic plans
(`packages/validation/src/compile.ts`); the engine executes them and the CLI renders a byte-stable
envelope (`apps/cli/src/report-validate.ts`). P2 already reuses this machinery for pipeline
`validate` gates (`packages/engine-duckdb/src/pipeline-runner/`), so a DCR's validation field can
reuse the **proven value-free verdict shape** (verdict + violated-rule count) rather than invent
one.

### 3.3 Privacy findings (the honest gap)

ADR 0014 lists privacy findings; ADR 0013's decision includes "classifications"; the domain model
has a `Classification` union and `Dataset.classification`; product 01 §10.1 lists labels
(`public`/`internal`/`confidential`/`restricted`/`PII`/`PHI`/financial-sensitive). **But no landed
M5/M6/P2 surface produces privacy findings** — the v1 Contract AST rule set is
type/required/unique/min/max/allowed-values/regex/max-null-share/min-distinct-share/rows, with no
classification rule. This document does **not** invent a producer. The field is proposed in v1
with an explicit caveat, and the producer question is **D17-Q6** (ruled: deferred with a
"not computed" disclosure; §9).

### 3.4 Lineage

P2 gives local lineage: p2-6 derives dataset- and node-level lineage from the pipeline plan
(ordered topological lists, no graph editor), and the runner returns per-node
`PipelineRunNodeResult`s. ADR 0011 defines the `Lineage`/`Provenance` domain shapes
(`inputVersionIds`, `parentVersionIds`, `transformationRecipe`). A DCR generated off a gated run
can reference that lineage rather than re-derive it — the "what produced the candidate" half of the
review.

---

## 4. Explicitly out of v1

**Comments, approvals, and policy checks are out of v1 — they are hosted concerns (M10, behind
G3).** This follows directly from ADR 0014's standalone-report consequence: the local tool
generates a **standalone report without hosted services**, so review-state fields that only exist
once a hosted workspace does (threads, reviewers, decisions, RBAC/ABAC policy evaluation) cannot be
produced locally and must not be faked. The domain `Review` aggregate
(`packages/domain/src/index.ts`) and ADR 0018/0006 policy machinery are the eventual homes; they
are **M10/G3+** per [roadmap §3.1/§5](03-execution-roadmap.md).

**Evaluations are deferred** (not "out" permanently): ADR 0014 lists them, but they belong to the
gated M8 AI dataset mode (G2), so v1 has no local producer. This is a deferral recorded in D17,
not a silent drop — see **D17-Q8** (ruled: omitted entirely; no reserved field).

---

## 5. Format discipline (the `@assay/contracts` / pipeline-IR precedent)

The repo has a proven canonical-serialization discipline, established by the M5 contract format
(ADR 0013/0026) and the P1/P2 pipeline IR (ADR 0030). The DCR artifact v1 **proposes to follow the
same discipline**; the concrete choices went to D17 (all ruled — §9). Described from source:

1. **Canonical, byte-stable serialization.** One AST → exactly one text. The contract serializer
   (`packages/contracts/src/serialize.ts`) fixes root/column/dataset key order, flow-vs-block
   style, 2-space indent, `lineWidth: 0` (no folding), a single trailing newline, and canonical
   scalar quoting; absent-but-empty rules stay absent. The pipeline serializer
   (`packages/pipeline/src/serialize.ts`) fixes root key order, **sorts node mappings by id**, sorts
   generic mapping keys recursively, and writes `materialization` only when non-default. For the
   DCR this implies: fixed key order, sorted collections where order is not meaning, no
   wall-clock, and **one exact byte sequence per logical artifact**. Whether "no wall-clock" is
   compatible with `Provenance.createdAt` was **D17-Q11** (ruled: no wall-clock in canonical bytes).

2. **Total, located-error parser.** The contract parser never throws
   (`packages/contracts/src/errors.ts`): malformed input yields `ContractError[]`, each with a
   machine-readable `code`, an actionable `message`, a document `path`
   (`columns[2].max-null-share`), and 1-based `line`/`column`, with a canonical one-line rendering
   (`describeContractError`). The pipeline parser mirrors this
   (`packages/pipeline/src/errors.ts`, `parse.ts`). A DCR parser must be total with the same
   located-error shape — including the exact-or-rejected number rule.

3. **One shape per meaning.** Empty/default/empty-collection values normalize to one canonical
   shape (contract: `required: false` ≡ absent, empty `columns` ≡ absent; pipeline: explicit
   `view` normalizes to absent; `publish.requires` omitted when empty). A DCR must not carry two
   spellings of "no change".

4. **`assay_*` reserved namespace.** The Pipeline IR reserves `assay_*` node ids
   (`packages/pipeline/src/validate.ts`, enforced in both parse and `validatePipeline` since p2-1),
   and the engine reserves `assay_*` relation/alias names (e.g. `assay_row_id`,
   `assay_overlay_ord`). A DCR format should reserve an analogous prefix for its own generated
   identifiers/fields rather than colliding with dataset column names — the exact prefix is
   **D17-Q9** (ruled: reserve `assay_dcr_*`).

**Privacy (ADR 0025) is a hard constraint on all of the above:** the artifact must be
**value-free** by construction — it carries schema/drift/count/verdict data, never dataset cell
values, raw SQL results, or filenames-where-sensitive. Sample row keys, where present, stay in the
anchor-free `base:<ordinal>` / `insert:<seq>` / `b:<ordinal>` forms the web surfaces already use
(`apps/web/src/diff/diff-export.ts`); the CLI's report envelopes already echo authored paths only.

---

## 6. Local candidate-DatasetVersion (what a gated run references)

ADR 0011 says identity is **logical, not file-based** and an immutable DatasetVersion records a
schema fingerprint, source references, hashes where feasible, row/partition metadata, provenance,
and transformation lineage. ADR 0012 says edits are an **overlay over an immutable base** and that
"commit creates a new file/version".

Proposed v1 reading (ruled by D17): a locally generated DCR's **candidate DatasetVersion** is the
**effective candidate state** — base immutable asset + the applied overlay of logical edit ops
(`packages/domain/src/overlay.ts`, `edit-ops.ts`), or a gated pipeline run's **materialized
output** (`PipelineRunNodeResult` `table`/`export`/`view`, with the runner's value-free
`exportPath` for export nodes). The DCR references that candidate by (a) the base side's logical
identity and (b) the candidate side's logical identity + provenance/lineage, not by a mutable file
path. Because the pipeline's `publish`-mode materialization is the **P3/DCR boundary** and refuses
explicitly today (ADR 0033/0035; `packages/pipeline/src/compile/`, runner
`unsupported-materialization`), a v1 DCR naturally attaches to a **completed or gated** run's
materialized output, never to a silently-published one.

What exactly identifies a candidate locally — a content hash, a logical version id, a
materialization reference, or a combination — was **not settled by ADR 0011/0012** and is
**D17-Q4** (ruled: logical id + schema fingerprint + provenance + a materialization reference; no
full content hash).

---

## 7. Generation entry points (D17-ruled)

The two candidate local surfaces:

- **CLI subcommand** — e.g. `assay dcr <base> <candidate> [--keys …] [--contract …]`, or a flag on
  the existing `assay pipeline run`/`assay diff`. The CLI already owns byte-stable JSON envelopes
  (`report-shared.ts` `REPORT_VERSION`) and the P2 gated-run/gate-refusal exit classes
  (`apps/cli/src/pipeline.ts`). This is the natural CI/offline path.
- **Web panel action off a gated run** — a button in the pipeline panel (p2-6) after a run reaches
  `completed` or `gated`, exporting a sanitized new-file artifact, mirroring the m5-3/m6-4
  report-export delivery discipline (always a NEW file; never a rewrite — ADR 0012;
  `apps/web/src/diff/diff-export.ts`, `apps/web/src/validation/report-export.ts`).

This document originally **did not pick**; **D17 ruled (c) both** — CLI subcommand and web panel
action — sharing one pure artifact builder, with CLI first if capacity forces one (**D17-Q5**; §9).
The note here is that both surfaces already exist and neither requires new engine capability, only
glue.

---

## 8. Non-goals (v1)

- **No hosted review semantics.** Comments, approvals, reviewer assignment, review state machine —
  M10/G3 (§4).
- **No policy/RBAC/ABAC enforcement.** Policy checks are enterprise governance (ADR 0018/0006;
  G3/G4).
- **No AI evaluations.** M8/G2 (§4).
- **No publish-mode materialization / no silent publish.** The P3 boundary stays explicit
  (ADR 0033/0035); this spec does not wire it.
- **No new engine capability.** v1 consumes M5/M6/P2 outputs as they exist.
- **No graph-editor lineage.** P2's ordered-list lineage rendering is the precedent (p2-6).
- **No telemetry, no dataset values, no filenames-where-sensitive** anywhere in the artifact
  (ADR 0025).
- **No re-decision of ADR 0011/0012/0014.** Where they were silent, the question went to D17 (now
  ruled — §9).

---

## 9. Open questions for the maintainer — the D17 list

> **Ruled 2026-10-02 by D17** (ADR 0046 → Accepted; see the
> [maintainer-rulings file](../process/handoff/20260926-maintainer-rulings.md)). Each question
> below keeps its original context/options/recommendation and carries the maintainer's
> `**Ruled (D17, 2026-10-02):**` outcome.

Each question: context → viable options → recommendation (where evidence supports one). **All 12
were ruled by D17 on 2026-10-02 — each carries its outcome line below.**

**D17-Q1 — Serialization choice and the `format`/version stamp.**
_Context:_ contracts use canonical **YAML** with `format: v1` (`packages/contracts/src/ast.ts`);
the pipeline IR uses canonical **YAML** with `version: 1` (`packages/pipeline/src/serialize.ts`);
CLI report envelopes use **JSON** with `reportVersion`. A DCR is both a reviewable document
(YAML-friendly) and a machine payload (JSON-friendly).
_Options:_ (a) canonical YAML like contracts/IR; (b) canonical JSON like the CLI envelopes;
(c) YAML document with an embedded JSON payload.
_Recommendation:_ **(a) canonical YAML**, matching the two human-authored formats, with a
`format: assay-dcr` + `version: 1` (or equivalent) stamp — unless the maintainer wants the CLI
JSON envelope as the canonical form.
**Ruled (D17, 2026-10-02): (a)** — canonical YAML stamped `format: assay-dcr` + `version: 1`.

**D17-Q2 — Concrete field schema, and how ADR 0014's four delta categories map to M6's aspects.**
_Context:_ ADR 0014 names schema/row/profile/distribution changes; M6 lands schema drift +
distribution deltas + row diff. The mapping is not 1:1 (§3.1).
_Options:_ (a) mirror M6's aspects verbatim (schemaDrift / columnDeltas / rowDiff) and map ADR
0014's four names onto them; (b) define a new four-way DCR grouping; (c) embed the existing
`DiffReport` JSON as an opaque sub-object.
_Recommendation:_ **(a)**, so the DCR never disagrees with the surfaces that produced it — but the
maintainer must confirm that "profile delta" is satisfied by profile-derived nullability drift +
distribution deltas, or name the missing standalone profile diff.
**Ruled (D17, 2026-10-02): (a)** — mirror M6's `schemaDrift` / `columnDeltas` / `rowDiff`;
"profile delta" is satisfied by profile-derived nullability drift + distribution deltas, with
**no standalone profile diff in v1**.

**D17-Q3 — Embed vs reference the per-aspect payloads.**
_Context:_ the standalone-report consequence (ADR 0014) argues for self-containment; large row-diff
samples argue for references.
_Options:_ (a) fully embed (self-contained artifact); (b) reference external report files by
authored path; (c) embed bounded summaries + reference full samples.
_Recommendation:_ **(a) for the bounded v1 fields**, with sample limits inherited from M6's C1/K
discipline — a standalone report that cannot be read without the producing machine defeats the
consequence. Confirm whether a reference mode is needed at all in v1.
**Ruled (D17, 2026-10-02): (a)** — fully embed the bounded v1 payloads (M6 C1/K sample limits);
**no reference mode in v1**.

**D17-Q4 — Local candidate-DatasetVersion identity.**
_Context:_ ADR 0011 lists what a version records but not the local minimal identity; ADR 0012 makes
the candidate an effective (overlay-applied) state.
_Options:_ (a) content hash of the effective materialized output; (b) logical id + schema
fingerprint + provenance (no full hash); (c) a materialization reference (pipeline run node /
export path) plus provenance.
_Recommendation:_ **(b)+(c)** — logical id + schema fingerprint + provenance + the materialization
reference, since a full content hash is a connector-specific strategy ADR 0011 leaves open and may
be infeasible for large/lazy outputs. This is the load-bearing definition P3 will consume.
**Ruled (D17, 2026-10-02): (b)+(c)** — logical id + schema fingerprint + provenance plus the
materialization reference; **no full content hash in v1**.

**D17-Q5 — Generation entry point(s).**
_Context:_ §7.
_Options:_ (a) CLI subcommand only; (b) web panel action only; (c) both.
_Recommendation:_ **(c) both, sharing one pure artifact builder** — both surfaces exist and the
repo's precedent is exact web≡CLI agreement (M5/M6 exit journeys). If capacity forces one, CLI
first (CI/offline path; web export can follow).
**Ruled (D17, 2026-10-02): (c)** — both entry points off one pure artifact builder; **CLI first if
capacity forces one**.

**D17-Q6 — How are "privacy findings" produced locally?**
_Context:_ ADR 0014 lists them; no local producer exists (§3.3). Options must not invent an engine.
_Options:_ (a) defer the field to a later version (v1 carries an explicit "not computed"
disclosure); (b) add a classification rule to the contract vocabulary (expands ADR 0013/0026 —
non-additive to the landed v1 rule set); (c) derive findings from existing contract classifications
if/when they land; (d) emit the domain `Classification` of base/candidate as a declared label
without a "finding".
_Recommendation:_ **confirm (a) or (d) for v1** and record the deferral; (b)/(c) are follow-on
format decisions that should not be smuggled in — this is the single biggest honesty gap in the
ADR 0014 field list.
**Ruled (D17, 2026-10-02): (a)** — the field is deferred; v1 carries an explicit "not computed"
disclosure (no local producer is invented).

**D17-Q7 — Row-diff key discipline in the DCR.**
_Context:_ M6 requires an explicit key set and never silently infers (C2). A DCR that omits keys
would either be keyless (no row delta) or would need inference.
_Options:_ (a) DCR requires explicit keys and refuses without them (typed located error); (b) DCR
carries the C2 inference disclosure and its result, like `assay diff --infer`; (c) row delta is
optional and absent when no keys were supplied.
_Recommendation:_ **(a)+(c)** — never silent inference inside a review artifact; a DCR without keys
is still valid with an explicit absent row-delta, but auto-inference requires the same explicit
opt-in + disclosure the diff surfaces already use.
**Ruled (D17, 2026-10-02): (a)+(c)** — explicit keys required (typed located error otherwise);
row delta **explicitly absent** when none were supplied; **no silent inference in a DCR**
((b) rejected).

**D17-Q8 — Evaluations: defer, or reserve a field?**
_Context:_ ADR 0014 lists evaluations; M8 is G2-gated.
_Options:_ (a) omit entirely from v1; (b) reserve an empty `evaluations` field for forward
compatibility.
_Recommendation:_ **(a) omit** — a reserved field invites faking and the v1-vs-v2 boundary is
cleaner; record the deferral for M8.
**Ruled (D17, 2026-10-02): (a)** — omitted from v1 with no reserved field; deferral to M8 (G2)
recorded.

**D17-Q9 — Reserved identifier/namespace prefix.**
_Context:_ the IR reserves `assay_*` node ids; the engine reserves `assay_*` aliases (§5).
_Options:_ (a) reuse `assay_*`; (b) reserve a DCR-scoped prefix (e.g. `assay_dcr_*`); (c) no
reserved prefix (the DCR has no dataset-column-namespace collision).
_Recommendation:_ **confirm (b) or (c) after the field schema (Q2) is fixed** — the DCR is a
document, not a SQL relation, so a collision may not arise; the point is to decide it, not to have
it fall out of the serializer.
**Ruled (D17, 2026-10-02): (b)** — reserve `assay_dcr_*`. **[Delegated selection:]** the maintainer
delegated the un-answered items; the orchestrator selected (b) over (c) because the
format-discipline clause already states a reserved `assay_*`-style namespace (no ADR amendment) and
it costs nothing while v1 has no user-keyed maps.

**D17-Q10 — The DCR artifact's own identity and status.**
_Context:_ the domain `DatasetChangeRequest` has `id` and `status: 'draft' | 'open' | 'approved' |
'rejected'`; a local standalone report could be a draft.
_Options:_ (a) local artifact carries an id + `status: draft` only; (b) id only, no status; (c)
no identity (a report file, like the m5-3/m6-4 exports).
_Recommendation:_ **(b) or (c)** — the local artifact is a report, not a workflow object; the
hosted aggregate (M10) owns status. Confirm that the local file is not expected to be the same
bytes as the future hosted DCR.
**Ruled (D17, 2026-10-02): (c)** — no identity/status; a standalone report file (the m5-3/m6-4
export precedent). **Confirmed:** the local artifact is not expected to be byte-identical to the
future hosted DCR.

**D17-Q11 — Timestamps vs byte-stability.**
_Context:_ canonical byte-stable serialization (contracts/IR) contains no wall-clock; ADR 0011's
`Provenance.createdAt` is a wall-clock.
_Options:_ (a) omit all timestamps from canonical bytes; (b) carry `createdAt` in a
non-canonical/non-serialized layer; (c) include a caller-supplied canonical timestamp.
_Recommendation:_ **(a)** — byte-stability is the precedent's core promise and the review value is
in the deltas; if provenance timestamps are required, put them outside the canonical core.
**Ruled (D17, 2026-10-02): (a)** — no wall-clock in canonical bytes; provenance timestamps, if
needed, live outside the canonical core.

**D17-Q12 — Hosted round-trip / forward compatibility.**
_Context:_ G3 requires the format to be "stable" before hosted build-out; M10 adds comments and
approvals (M10/G3 per ADR 0014/roadmap §5).
_Options:_ (a) design v1 as an extensible superset the hosted layer adds fields to; (b) treat the
hosted format as separate and map.
_Recommendation:_ **(a)** with `v1` additive-only discipline (the IR precedent: non-additive
changes are a STOP-and-report, version bump is maintainer-visible). Confirm the additive-only
constraint is part of the D17 ruling.
**Ruled (D17, 2026-10-02): (a)** — v1 is an extensible superset; **additive-only within `v1` is an
explicit constraint of this ruling** (non-additive = STOP-and-report; version bump =
maintainer-visible). **Confirmed.**

---

## 10. Relationship to P3 and G3

- **P3 (DCR integration, roadmap §3.2)** is the pipeline stage that wires "candidate DatasetVersion
  from pipeline runs, DCR generation". It was **blocked on M9/D17**; **D17 passed 2026-10-02**, so
  authoring the P3 queue is now unblocked. This document deliberately stops before authoring the P3
  queue (D16 discipline).
- **G3** ([roadmap §5](03-execution-roadmap.md)) requires "DCR artifact format stable (M9 done)".
  D17 was the ruling that made M9's format decision; M9's code slice (if any) follows the P3 queue
  authoring.
- The publish boundary (ADR 0033/0035) remains explicit and untouched: publish-mode materialization
  refuses today, and this spec does not wire it.

---

## 11. Alternatives considered

- **Make the DCR a thin wrapper around `assay diff --format json`.** Rejected as the _whole_
  answer: it drops the base/candidate DatasetVersion framing, lineage, and validation aspects ADR
  0014 requires. It may still be the `schema/row/profile/distribution` sub-payload (Q3).
- **Decide the format in this document.** Rejected — D16 explicitly makes this a proposal; the
  format ruling comes back as D17.
- **Defer M9 entirely until G3.** Rejected by D16: P3 is blocked on it and the format decision is
  cheap to scope now.
- **Include hosted review fields (comments/approvals/policy) "for completeness".** Rejected: ADR
  0014's standalone-report consequence plus M10/G3 gating make them unproducible locally; faking
  them would be the honesty failure the repo's discipline forbids.

---

## References

- [ADR 0011 — Dataset identity and versioning](../adr/0011-dataset-identity-and-versioning.md)
- [ADR 0012 — Edit overlay and transaction semantics](../adr/0012-edit-overlay-and-transaction-semantics.md)
- [ADR 0013 — Native data contract format](../adr/0013-native-data-contract-format.md)
- [ADR 0014 — Dataset change request model](../adr/0014-dataset-change-request-model.md)
- [ADR 0026 — Validation engine and contract compilation](../adr/0026-validation-engine-and-contract-compilation.md)
- [ADR 0030 — Owned pipeline IR](../adr/0030-owned-pipeline-ir.md)
- [ADR 0033 — Materialization is logical and backend-mapped](../adr/0033-materialization-is-logical-and-backend-mapped.md)
- [ADR 0035 — Validation and publish gates are first-class DAG nodes](../adr/0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md)
- [Proposed ADR 0046 — DCR artifact format v1](../adr/0046-dcr-artifact-format-v1.md)
- [Roadmap §3.1 M9 / §3.2 P3 / §5 G3](03-execution-roadmap.md)
- [Post-MVP track](04-post-mvp-track.md)
- [MVP scope and acceptance](02-mvp-scope-and-acceptance.md)
- [PT-P2 queue (P2 code-complete)](../process/handoff/20260930-ptp2-queue.md)
- [ptv-m9 queue (row m9-1)](../process/handoff/20261002-ptv-m9-queue.md)
