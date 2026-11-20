---
'@assay/testing': patch
---

test(c05): make the `predicate-error-reuse` conformance scenario's benign anchor assert the declared
window _values and order_, not only the row count. The anchor previously checked `expectRowCount`,
the readiness and the registered-view count, so an engine that preserved all three while serving one
altered cell value passed — the new `corruptsAnchorValue` mutation (which changes exactly one
filtered row's `id`) exposed the hole. The scenario now compares the anchor window against the
subject's declared `expectValues` with the suite's existing `expectColumnValues` comparator: an
unchanged baseline before the probes (so a later mismatch is attributable to the probes), after
each contained breakout probe, and after the full probe run. The window request is bounded by
`min(expectRowCount, maxWindowRows)` and the declared list is compared as that same slice, so a
tighter engine cap is never equated with a smaller batch; loud subject preconditions (the anchor
fits one window, one declared value per expected row) make a misconfigured subject fail loudly
instead of passing. Nothing about the package's surface changes: scenario names, result shape, fact
names and sample bounds are untouched (no new scenario, no new fact), the value normalizer's
Date/Map/array semantics are not modified, and every existing assertion is kept. The only
observable difference is that a count-preserving non-compliant engine that used to pass this
scenario now fails it (with an `id[0]` value mismatch).
