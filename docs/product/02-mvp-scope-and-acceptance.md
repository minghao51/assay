# Data Workbench MVP Scope and Acceptance Criteria

> **2026-09-21 (post-MVP note):** the MVP shipped as **M0–M6** (web + CLI surfaces; see
> `03-execution-roadmap.md` §4). By maintainer decision D11 the VS Code surface moved to the
> **post-MVP track** (`04-post-mvp-track.md` §5) — this document keeps its original wording;
> the VS Code inclusion below and scenario 11 are now PT-V acceptance criteria, not MVP gaps.
> Historical name note: documents written before 2026-09-14 say "Data Workbench" — same
> product (ADR 0039, now **Assay**).

## 1. MVP Objective

Prove that developers prefer Data Workbench over notebooks, raw editors, and one-off viewers for recurring inspection and validation of local structured datasets.

---

## 2. Included

### Formats

- Parquet
- JSONL / NDJSON
- CSV

### Explore

- schema
- virtualized table
- nested values
- filtering
- sorting
- search
- SQL
- profiling

### Change

- cell edits
- rename columns
- type casts
- simple row insertion/deletion
- export

### Verify

- basic validation rules
- invalid-row view
- schema diff
- dataset profile diff
- key-based row diff

### Surfaces

- Web
- VS Code

### CLI

At minimum:

```bash
dataworkbench profile
dataworkbench validate
dataworkbench diff
```

---

## 3. Excluded from MVP

- hosted workspaces,
- SSO,
- remote data gateway,
- RLS,
- ABAC,
- KMS,
- enterprise connectors,
- team comments,
- approvals,
- AI model integration,
- full dataset catalog,
- lineage graph,
- Tauri desktop.

These remain architectural targets, not launch blockers.

---

## 4. Acceptance Criteria

### Large-file behavior

The application must not require full JavaScript-object materialization of the source dataset.

### Privacy

A user can use the core Web product without uploading the dataset to Data Workbench servers.

### Responsiveness

Long-running query/profile/diff tasks must not block the main UI thread.

### Reproducibility

Non-trivial visual transformations must produce a reproducible operation or recipe.

### Editing

Parquet edits must be represented as logical edits and result in explicit rewrite/export.

### Validation

The same contract rule should behave consistently in Web, VS Code, and CLI.

### Diff

Dataset comparison must provide useful schema/profile change information before full row-level comparison.

### Accessibility

Core grid navigation and editing must be operable by keyboard.

---

## 5. Demo Scenario

A strong MVP demo should be able to show:

1. Drop a 1+ GB Parquet dataset into the browser.
2. View rows quickly without upload.
3. Inspect nested columns and schema.
4. Run SQL.
5. Profile a suspicious column.
6. Define or load a validation rule.
7. Show failing rows.
8. Apply a repair/edit.
9. Export a new version.
10. Compare old vs new.
11. Open the same workflow in VS Code.
12. Run validation/diff from CLI.

This demonstrates the product thesis without requiring enterprise infrastructure.
