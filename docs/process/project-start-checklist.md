# Project Start Checklist — ADR-gate map

**Purpose:** the evergreen map of ADR review gates. Before implementing editing, validation,
hosted collaboration, enterprise data access, or pipeline work, review the ADRs listed below —
they prevent re-litigating settled decisions in code. The bootstrap "Before First Feature PR"
checklist (all items completed during M1) was pruned when this file became the gate map; process
history lives in the [handoff changelog](handoff/archive/changelog-202609.md). Referenced by
[contributing.md](contributing.md) as "the ADR-gate map".

**Last updated:** 2026-09-23 (pruned to the ADR-gate map; bootstrap section dropped).

## First Architecture Review

Before implementing editing, review:

- ADR 0011,
- ADR 0012,
- ADR 0020,
- ADR 0022.

Before implementing validation, review:

- ADR 0013,
- ADR 0026.

Before implementing hosted collaboration, review:

- ADR 0010,
- ADR 0014,
- ADR 0027.

Before implementing enterprise data access, review:

- ADR 0005,
- ADR 0006,
- ADR 0007,
- ADR 0018,
- ADR 0023,
- ADR 0024.

## Pipeline Architecture Review

Before implementing the visual pipeline, review:

- ADR 0029,
- ADR 0030,
- ADR 0032,
- ADR 0033,
- ADR 0035.

Before implementing dbt/SQLMesh integration, review ADR 0031.

Before implementing external ingestion or orchestration, review ADR 0034 and ADR 0032.
