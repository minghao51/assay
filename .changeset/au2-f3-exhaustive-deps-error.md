---
'@assay/web': patch
---

Fix the last three react-hooks/exhaustive-deps warnings and promote the rule to an error (f-3)

DataGrid now memoizes the `model.schema ?? []` fallback (stable identity for the parsed-types/header memos), and RecordInspector reads the overlay revision through a genuine latest-value ref — fixing the missed assignment that caused a spurious freshness reload (double tree build + transient stale announcement) on every record re-open after an edit. `react-hooks/exhaustive-deps` is now an error, so new violations fail CI.
