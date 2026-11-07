---
'@assay/vscode': patch
---

fix(d10): remove Arrow-family **input** claims from the VS Code surface.

The extension's custom read-only editor is contributed for, and the surface
advertises, only the four formats the real engine reads (Parquet, CSV,
JSONL/NDJSON, JSON). The engine's `detectFileFormat` returns `null` for
`.arrow`/`.feather`/`.ipc`, so VS Code no longer offers the dataset editor for
files it cannot open:

- the `assay.datasetViewer` selector drops `*.arrow`, `*.feather`, `*.ipc`;
- the manifest description and the README open-set line name the four proven
  formats instead of “Arrow”;
- the open/compare dialog filters and their labels follow the same four
  formats, and the webview's `unsupported-format` text no longer lists
  Arrow/Feather/IPC as supported input;
- manifest, module-alias and error-text truth tests fail if an Arrow-family
  input claim returns to those surfaces (the README and dialog labels are not
  machine-checked).

No engine or data-source change: Arrow input remains deferred (SV-F07).
Arrow IPC stays an export format and internal transport, and Arrow
decimal/128-bit word-array result types stay read-only — those statements are
unchanged.
