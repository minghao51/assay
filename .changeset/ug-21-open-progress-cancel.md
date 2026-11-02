---
'@assay/web': patch
---

feat(web): opening progress + cancel (ug-21).

The opening frame now pairs the existing `Opening…` status with a native,
genuinely indeterminate `<progress>` (no `value`/`max`, value-free accessible
name) and a visible `Cancel opening` control. Both render only while
`phase.kind === 'opening'`; idle, ready and error keep the previous frame, and
the Open control's disabled-while-opening behaviour is unchanged.

Cancel reuses the existing dataset-session guard: it calls
`datasetSession.beginSession()` (token bump plus every registered domain reset)
and returns the ordinary idle phase. There is no engine interrupt in the
protocol, so the in-flight open is not aborted; its post-await token
comparisons drop the late result (no phase flip, no error, no stale dataset).
A subsequent open behaves exactly as before. Copy is value-free (ADR 0025); no
telemetry, engine/protocol change or new dependency.
