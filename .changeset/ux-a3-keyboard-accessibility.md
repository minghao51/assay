---
'@assay/web': patch
---

fix(web): complete the two recorded keyboard paths (ux-a3).

- The first-run telemetry disclosure is now a real native modal dialog
  (`<dialog>` + `showModal()`) instead of a `role="dialog"` section: the page
  behind it is genuinely inert (no pointer, focus or Tab path back into it).
  Initial focus lands on the neutral title so reading comes before choosing;
  Tab/Shift+Tab cycle the two explicit actions. Escape is deliberately a no-op
  (the native `cancel` event is consumed): it never dismisses, never writes a
  preference and never acts as either choice, so consent remains explicit.
  Unmount closes the dialog and returns focus to the still-connected pre-open
  owner. Copy, testids, action labels/classes, the disclosure-shown bookkeeping
  and every preference/event/storage/transport behaviour are unchanged. The one
  scoped `.telemetry-disclosure` CSS adjustment is colour inheritance (a native
  dialog paints from the UA `canvastext` system colour, so the panel now pins
  the app's own text token) plus the UA centred modal placement — no token or
  global layout change.
- `RecordRequest` gains an optional `focusOnOpen` (default false). Only App's
  explicit grid row activation (Enter on a focused row or a row click) sets it:
  a fresh open of that request lands focus on the non-modal inspector container
  once the requested record is honestly rendered, so Escape closes the panel and
  restores the opening row instead of an 18-Tab walk. Validation/diff "Show
  row" jumps and the dock's Prev/Next step keep their existing focus policy
  (no flag), and a focus request never re-fires for a step, an overlay reload,
  a model notification or an expansion. A gesture made on a still-loading row
  still opens when the slot lands, but retires its focus request if the user
  deliberately moved focus meanwhile. No grid model/engine/protocol change.
