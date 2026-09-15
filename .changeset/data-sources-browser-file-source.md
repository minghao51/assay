---
'@assay/data-sources': minor
---

feat(m1-3): add `BrowserFileSource`, a `DataSource` for one local browser file, constructed from either a `FileSystemFileHandle` (File System Access API) or a `File` (`<input type="file">` fallback). `open()` is idempotent per instance and returns an opaque, frozen `DataHandle`; `metadata()` reports format (file-name extension: parquet/jsonl/json/csv/arrow/feather) and `sizeBytes` without reading dataset bytes. Also adds a capability-detection layer (`detectFileSystemCapabilities`) and a `pickDataFile` helper that uses the File System Access picker when available and falls back to a hidden input otherwise (per-browser matrix in the package README). Local-first (ADR 0001): references only, no reads here, nothing logged (ADR 0025).
