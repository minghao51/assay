---
'@assay/web': patch
---

fix(au3-9): ignore Escape in the export dialog while an export is in flight (S6). The document-level Escape handler used to close (unmount) the dialog during the `working` phase even though every control was disabled, so an in-flight export still wrote its file with no visible result line. Escape now waits for settlement, matching the disabled Close/Export affordance; the existing `role="status"` progress line keeps announcing the busy state, and Escape still closes immediately when no export is running.
