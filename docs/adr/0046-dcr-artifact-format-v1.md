# ADR 0046: Define a Canonical Local DCR Artifact Format (v1)

## Status

Proposed

## Date

Proposed 2026-10-02

## Deciders

- Maintainer (ruling **D17** — the format ruling requested by this proposal; not yet made)

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
proposes v1, and the format is decided by the subsequent **D17** ruling. This ADR is therefore
**Proposed** and binds nothing until that ruling.

## Decision

Proposed (pending D17): define a **versioned, canonical, value-free local DCR artifact format**
(“v1”) that a local surface can generate standalone, following the contract/pipeline-IR discipline.

1. **Scope.** v1 carries the local-derivable subset of ADR 0014's field list: schema, row, profile,
   and distribution deltas (M6), validation (M5, reused as in P2), lineage (P2 / ADR 0011), and a
   privacy-findings slot whose local producer is unresolved. **Comments, approvals, and policy
   checks are out of v1** (hosted, M10/G3, per ADR 0014's standalone-report consequence);
   **evaluations are deferred** (M8 is G2-gated).
2. **Candidate version.** A DCR references a **local candidate DatasetVersion** whose identity is
   logical, not file-based (ADR 0011), built from the effective candidate state (base asset +
   applied edit overlay per ADR 0012) or a gated pipeline run's materialized output — never from a
   silently-published one (the publish boundary stays explicit, ADR 0033/0035).
3. **Format discipline.** Canonical byte-stable serialization (one AST → one exact text, fixed key
   order, sorted collections where order is not meaning, no wall-clock in canonical bytes), a
   **total** parser that returns located typed errors and never throws, one-shape-per-meaning
   normalization, and a reserved `assay_*`-style namespace. **Value-free throughout** (ADR 0025):
   no dataset cell values, raw SQL results, or filenames-where-sensitive.
4. **Non-binding detail.** The concrete serialization choice, field schema, embed-vs-reference,
   candidate identity, entry point(s), artifact identity/status, timestamp policy, privacy-finding
   producer, reserved prefix, and hosted forward-compatibility are **open questions listed for D17
   in the scoping spec §9** — they are **not decided by this ADR**.

The format is **additive-only within `v1`** (the Pipeline IR precedent: a non-additive change is a
STOP-and-report; a version bump is a maintainer-visible decision).

## Consequences

### Positive

- Gives P3 a concrete, reviewable artifact to integrate against once D17 lands.
- Reuses M5/M6/P2 outputs instead of inventing a parallel model, so the local DCR cannot disagree
  with the surfaces that produced it.
- Follows a proven, testable discipline (byte-stability, total parsing), so cross-surface web≡CLI
  agreement is achievable as it was for M5/M6.
- Keeps hosted review (M10) additive: v1 is a strict local subset, not a competing format.

### Negative / risks

- The privacy-findings field has **no local producer today**; v1 must carry an explicit disclosure
  or defer the field (D17-Q6) — a stated honesty gap, not a silent one.
- ADR 0014's four delta categories do not map 1:1 onto M6's aspects; the chosen mapping must be
  documented and pinned (D17-Q2).
- A second canonical format adds maintenance surface, mitigated by sharing the serializer/parser
  patterns with contracts/pipeline (not the code, which is domain-specific).

### Neutral

- The format is a local report, not a workflow object: review state stays in the hosted aggregate
  (M10) and the domain `DatasetChangeRequest` scaffold.
- D17 is the single decision point; this ADR flips to Accepted only through it.

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
