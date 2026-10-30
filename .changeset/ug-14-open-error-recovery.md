---
'@assay/web': patch
---

fix(web): recover from open failures and unify engine error copy (ug-14).

**UG-5 — open-failure recovery.** A failed open no longer renders the raw
engine string as its message. The `open-error` alert now pairs a one-line
human cause (classified as unsupported format / unreadable file / cause-neutral
fallback) with a `Choose a different file…` retry that re-enters the same
guarded `openDataFile` path as the Open control, and the full multi-line engine
diagnostic moves behind a collapsed `Technical detail` `<details>` disclosure
(text-only rendering). The fallback is deliberately neutral: the open chain
also catches schema, row-count, view and panel-import failures, and the opaque
WASM glue error is not file evidence, so neither is described as an unreadable
file. The existing Open control keeps its behaviour and a failed open still
never renders the welcome copy. Pinned with a new synthetic
`fixtures/invalid/corrupt.parquet` fixture (component pins plus a real-browser
recovery journey).

**UG-30/UG-25 — one error-copy convention.** `apps/web/src/edit/session.ts`
gains a shared first-line-reducing summary (`engineErrorLine`, guaranteeing a
single line for every break shape) and per-operation framing
(`engineErrorMessage`) that names both what failed and what did not change. It
is adopted by the open alert, both SQL pane error paths, the profile error
state, the filter apply/rollback error (the apply+restore double failure now
says the previous filters could not be restored instead of asserting they are
still in effect), and the validation and diff session call sites. The read-only
sessions no longer reuse the edit-domain rejection copy, so validation/diff
messages never contain the word "edit" and state that the previous
validation/comparison view is unchanged — pinned on the rendered panel output,
not just the hook state.
