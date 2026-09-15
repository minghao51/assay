# ADR 0039: The Product Name Is Assay

## Status

Accepted

## Context

Decision D6: "Data Workbench" is a descriptive, generic name — weak for trademark, hard to search, and widely used by unrelated products. A candidate shortlist was prepared in the project handoff (Assay, Touchstone, Datalint, Datascope, Specimen); the maintainer selected **Assay** on 2026-09-14.

"To assay" means to test the quality or composition of a substance — precisely the product's core act: examining a dataset's quality, structure, and drift before it is trusted.

Registry reality (checked 2026-09-14): the unscoped npm package `assay` exists (v1.0.0, unrelated); the `@assay` scope appears unclaimed.

## Decision

- Product/display name: **Assay**.
- Category descriptor kept as the tagline: "the local-first data workbench".
- Workspace npm scope: `@assay/*` (rename from `@dataworkbench/*` completed in the same change).
- CLI binary name: `assay`.
- Local workspace metadata directory: `.assay/` (was `.dataworkbench/`).
- Telemetry opt-out environment variable: `ASSAY_NO_TELEMETRY` (supersedes the placeholder name in ADR 0037, which predates this rename and is otherwise unchanged).
- Historical documents and ADRs 0001–0038 keep their original wording ("Data Workbench", `.dataworkbench/`); the naming-convention note in `docs/README.md` maps old names to new.

## Consequences

### Positive

- Distinctive, ownable, verb-able name matching the product's core metaphor.
- Rename executed pre-release while packages are private — zero external breakage.

### Negative / risks

- The npm org `assay` must be **claimed before first publish**; if unavailable, adopt an alternative scope (e.g., `@assay-dev`) and codemod — internal-only impact.
- The unscoped `assay` package occupying the plain name means the CLI must publish under the scope (`@assay/cli`) with bin `assay`; document this in install instructions.
- Trademark/domain clearance search still required before branding investment (residual D6 tail, due at gate G0).

## Alternatives considered

Touchstone (common word, more collisions), Datalint (leans descriptive), Datascope (existing small projects), Specimen (clinical tone), keeping "Data Workbench" (weak protectability).
