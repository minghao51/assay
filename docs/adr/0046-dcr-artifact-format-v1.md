# ADR 0046: Define a Canonical Local DCR Artifact Format (v1)

## Status

Accepted (ruling D17, 2026-10-02 — the 12 spec-§9 questions ruled as recorded in the Decision
section below)

## Date

Proposed 2026-10-02; Accepted 2026-10-02 (ruling D17) —
[maintainer-rulings queue](../process/handoff/20260926-maintainer-rulings.md).

## Deciders

- Maintainer (ruling D17 — DCR artifact format v1; D18 for the PT-V track start)

## Context

[ADR 0014](0014-dataset-change-request-model.md) makes the Dataset Change Request the primary
review artifact: it compares a base DatasetVersion with a candidate version and captures
schema/row/profile/distribution changes, validation, privacy findings, lineage, evaluations,
comments, approvals, and policy checks. Its key consequence is that **the local tool should still
be able to generate a standalone DCR report without hosted services**.

That consequence is unbuilt, and it gates two dependent items:

- **P3 (DCR integration)** — "candidate DatasetVersion from pipeline runs, DCR generation"
  ([roadmap §3.2](../product/03-execution-roadmap.md)) — is blocked on M9.
- **G3** requires "DCR artifact format stable (M9 done)" before hosted-workspace build-out
  ([roadmap §5](../product/03-execution-roadmap.md)).

The local surfaces that ADR 0014's field list needs already exist: M5 validation
(`@assay/contracts` + `@assay/validation`, ADR 0013/0026), M6 diff (`@assay/diff`, ADR 0011), and
P2 pipeline lineage and gates (`@assay/pipeline` + the engine runner, ADR 0030/0033/0035). What is
missing is a **format** — a canonical, reviewable, value-free artifact a local surface can emit
standalone and a hosted review (M10) can later extend.

The repo already has a proven format discipline to follow: the contract format ADR 0013/0026 and
the pipeline IR ADR 0030 both use **canonical byte-stable serialization, total located-error
parsers, one-shape-per-meaning normalization, and a reserved `assay_*` namespace**.

Ruling **D16** (2026-10-02) authorized this as a **scoping proposal, not a decision**: the M9
scoping spec ([`docs/product/06-dcr-artifact.md`](../product/06-dcr-artifact.md), queue row m9-1)
proposed v1, and the format was decided by the subsequent **D17** ruling (2026-10-02) — see
Decision.

## Decision

Accepted (ruling D17, 2026-10-02): define a **versioned, canonical, value-free local DCR
artifact format** (“v1”) that a local surface can generate standalone, following the
contract/pipeline-IR discipline.

1. **Scope.** v1 carries the local-derivable subset of ADR 0014's field list: schema, row, profile,
   and distribution deltas (M6), validation (M5, reused as in P2), lineage (P2 / ADR 0011), and a
   privacy-findings slot carrying an explicit "not computed" disclosure (D17-Q6, deferred — no
   local producer). **Comments, approvals, and policy checks are out of v1** (hosted, M10/G3, per
   ADR 0014's standalone-report consequence); **evaluations are deferred** (M8 is G2-gated).
2. **Candidate version.** A DCR references a **local candidate DatasetVersion** whose identity is
   logical, not file-based (ADR 0011), built from the effective candidate state (base asset +
   applied edit overlay per ADR 0012) or a gated pipeline run's materialized output — never from a
   silently-published one (the publish boundary stays explicit, ADR 0033/0035).
3. **Format discipline.** Canonical byte-stable serialization (one AST → one exact text, fixed key
   order, sorted collections where order is not meaning, no wall-clock in canonical bytes), a
   **total** parser that returns located typed errors and never throws, one-shape-per-meaning
   normalization, and a reserved `assay_*`-style namespace. **Value-free throughout** (ADR 0025):
   no dataset cell values, raw SQL results, or filenames-where-sensitive.
4. **Ruled detail (D17, 2026-10-02).** The 12 scoping-spec §9 questions are decided; this ADR is
   self-contained and carries the answers:
   1. **Serialization/stamp (Q1):** canonical **YAML** (the contracts/IR precedent), stamped
      `format: assay-dcr` + `version: 1`.
   2. **Field schema / delta mapping (Q2):** mirror M6's aspects verbatim — `schemaDrift` /
      `columnDeltas` / `rowDiff` — with ADR 0014's four delta names mapped onto them. **Explicitly
      confirmed:** "profile delta" is satisfied by profile-derived nullability drift + distribution
      deltas; **no standalone profile diff in v1**.
   3. **Embed vs reference (Q3):** fully **embed** the bounded v1 payloads (sample limits inherited
      from M6's C1/K discipline); **no reference mode in v1**.
   4. **Candidate identity (Q4):** logical id + schema fingerprint + provenance **plus** a
      materialization reference (pipeline run node / export path); **no full content hash in v1**
      (connector-specific, infeasible for large/lazy outputs).
   5. **Entry point(s) (Q5):** **both** — CLI subcommand and web panel action off a gated run —
      sharing one pure artifact builder; if capacity forces one, **CLI first**.
   6. **Privacy findings (Q6):** **deferred** — v1 carries an explicit "not computed" disclosure for
      the field (no local producer exists; nothing invented).
   7. **Row-diff keys (Q7):** requires explicit keys (typed located error otherwise) and is
      **explicitly absent** when no keys were supplied; **no silent inference inside a DCR** (the
      diff surfaces' inference-disclosure carry is rejected).
   8. **Evaluations (Q8):** omitted entirely from v1 (no reserved field); deferral to M8 (G2)
      recorded.
   9. **Reserved namespace (Q9):** reserve `assay_dcr_*` — a **delegated selection** by the
      orchestrator under the maintainer's "go with your suggestion" delegation (the existing
      `assay_*`-style reservation in the format-discipline clause made it cost-free).
   10. **Artifact identity/status (Q10):** **none** — the artifact is a standalone report file (the
       m5-3/m6-4 export precedent); hosted M10 owns workflow state. **Confirmed:** the local
       artifact is not expected to be byte-identical to the future hosted DCR.
   11. **Timestamps (Q11):** no wall-clock anywhere in canonical bytes; provenance timestamps, if
       needed, live outside the canonical core.
   12. **Forward compatibility (Q12):** v1 is an extensible superset the hosted layer extends;
       **additive-only within `v1` is an explicit constraint of this ruling** (non-additive change =
       STOP-and-report; version bump = maintainer-visible).

The format is **additive-only within `v1`** — an explicit **constraint of the D17 ruling** (the
Pipeline IR precedent: a non-additive change is a STOP-and-report; a version bump is a
maintainer-visible decision).

## Consequences

### Positive

- Gives P3 a concrete, reviewable artifact to integrate against (D17 landed 2026-10-02).
- Reuses M5/M6/P2 outputs instead of inventing a parallel model, so the local DCR cannot disagree
  with the surfaces that produced it.
- Follows a proven, testable discipline (byte-stability, total parsing), so cross-surface web≡CLI
  agreement is achievable as it was for M5/M6.
- Keeps hosted review (M10) additive: v1 is a strict local subset, not a competing format.

### Negative / risks

- The privacy-findings field has **no local producer today**; by ruling D17 it carries an explicit
  "not computed" disclosure (D17-Q6) — a stated honesty gap, not a silent one.
- ADR 0014's four delta categories do not map 1:1 onto M6's aspects; the chosen mapping (D17-Q2) is
  pinned above and must remain documented.
- A second canonical format adds maintenance surface, mitigated by sharing the serializer/parser
  patterns with contracts/pipeline (not the code, which is domain-specific).

### Neutral

- The format is a local report, not a workflow object: review state stays in the hosted aggregate
  (M10) and the domain `DatasetChangeRequest` scaffold.
- D17 was the single decision point; this ADR flipped to Accepted through it (2026-10-02).

## Alternatives considered

- **Reuse `assay diff --format json` as the DCR.** Insufficient: drops the base/candidate
  DatasetVersion framing, lineage, and validation aspects ADR 0014 requires (it may become a
  sub-payload).
- **Decide the format inside the M9 scoping spec.** Rejected by D16: the spec proposes and D17
  decides; silent decisions are the failure mode being guarded against.
- **Defer M9 until G3.** Rejected: P3 is blocked on it, and scoping the format now is cheap.
- **Include hosted review fields for completeness.** Rejected: ADR 0014's standalone-report
  consequence and M10/G3 gating make them unproducible locally; faking them would be a privacy and
  honesty failure.

## References

- [`docs/product/06-dcr-artifact.md`](../product/06-dcr-artifact.md) — the M9 v1 scoping spec and
  the numbered D17 open-questions list.
- [ADR 0011](0011-dataset-identity-and-versioning.md), [ADR 0012](0012-edit-overlay-and-transaction-semantics.md),
  [ADR 0013](0013-native-data-contract-format.md), [ADR 0014](0014-dataset-change-request-model.md),
  [ADR 0025](0025-telemetry-and-data-privacy-boundary.md), [ADR 0026](0026-validation-engine-and-contract-compilation.md),
  [ADR 0030](0030-owned-pipeline-ir.md), [ADR 0033](0033-materialization-is-logical-and-backend-mapped.md),
  [ADR 0035](0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md).
