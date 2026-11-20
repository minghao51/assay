---
'@assay/vscode': patch
---

refactor(d03a): the desktop export transfer lifecycle (`export-request` →
`export-ready` → `export-start` → `export-chunk`… → `export-finish` →
`export-complete`/`export-cancelled`, plus the single create-only writer it
owns) moves out of the panel bridge into a desktop-local controller with
explicit dependencies (post-to-webview, destination acquisition, writer
factory, source paths). The bridge (`src/dataset.ts`) now only routes those
five frames. Frame shape, payload/sequence/offset/generation bounds, the
format vocabulary and the response vocabulary stay owned by the pure contract
(`export-transfer.ts` — the duplicated format literal is now the shared
`SAFE_EXPORT_FORMATS` tuple); the envelope id/generation checks are the
pre-existing ingress checks, moved, and nothing validates an export frame
twice. Refusals are unchanged: malformed, stale, duplicate, out-of-order and
oversized chunks refuse before the writer sees bytes, the destination is
checked for `file` scheme and source aliasing before the writer exists, and
delivery is create-only. Four edge paths tighten to the invariants the
protocol already declared: a second request while a destination picker is open
answers `export-busy` instead of opening a second dialog, a duplicate
`export-start` refuses instead of rewinding the sequence bounds, disposing
the panel/session cancels the owned transfer (including a writer created by a
continuation that raced the disposal, which previously left its file behind),
with no response posted after disposal, and a `close()` that settles after a
matching `export-cancel` posts nothing further (the ownership epoch, not just
the disposal flag, guards finish/close) so a cancelled transfer never reports
`export-complete`/`export-failed` and a late close cannot release a newer
transfer. No wire/format/support change, no new
dependency, no extension telemetry; validation/diff report handling and the
report-export flow are untouched.
