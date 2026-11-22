---
'@assay/telemetry': patch
---

fix(e01): the web disclosure body now states the honest in-flight limit. The
final sentence of `WEB_DISCLOSURE_BODY` — "Turning it off takes effect
immediately and nothing further is sent." — overstated the guarantee (an
already-started send could still complete after opt-out); it is replaced by
"Turning it off stops further attempts and attempts to abort in-flight
delivery; metadata already delivered is not recalled.", which claims no recall
and matches the cancellation behavior added to the web runtime/transport
(E01 option A). No other sentence of the constant changes, `DISCLOSURE_REVISION`
**stays `1`**, and `CLI_DISCLOSURE_COPY` is byte-identical: CLI parity is out of
scope (design §7), and since the revision marker is recorded for both surfaces, a
bump would attribute revision-2 consent to a CLI that still shows the old text.
The web/CLI copy divergence is therefore deliberate and named here. The §6.3
byte-exactness pin (design document + `copy.test.ts`) is updated in the same
change, so no surface paraphrases the consent artifact.
