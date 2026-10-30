---
'@assay/web': patch
---

feat(web): open a dropped data file through the normal chain (ug-15 / UG-6)

The idle shell is now a drop target: a `dragover`/`drop` listener on the window
cancels the browser's default in every phase (so a stray file drop can never
navigate away from the workbench) but only acts while idle. A dropped `File` is
parked as a one-shot source and consumed by the SAME `openDataFile` path the
picker uses — same session-token guard after every await, same
`sourceIdentityRef`/`openSourceRef` resets, same `opening` → `ready`/classified
`open-error` transitions, same `dataset_opened`/`dataset_open_failed` telemetry —
and the picker is never invoked. A drop carrying no `File` shows readable,
value-free inline copy and never reaches the engine; a dropped
unsupported/corrupt file lands in the existing classified `open-error` surface.
The idle state gains a visible, value-free drop affordance (one scoped CSS
block), rendered only outside `opening`/`ready`/`error`.

Pins: five App-level tests (idle drop opens with the dropped file and zero
picker calls; drops while ready/opening are inert; no-file drop shows copy and
stays idle; an unsupported drop uses the one classified error surface) plus a
Playwright `DataTransfer` journey that drops the real `customers.parquet` bytes
(`data-phase="ready"`, 5 rows, no `filechooser`) and a non-file payload leg.
No new dependency, no engine/grid protocol change, no telemetry change, no
filenames or dataset values in copy/logs.
