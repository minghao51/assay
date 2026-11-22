---
'@assay/cli': minor
'@assay/contracts': minor
'@assay/data-sources': minor
'@assay/diff': minor
'@assay/domain': minor
'@assay/engine-duckdb': minor
'@assay/grid': minor
'@assay/pipeline': minor
'@assay/telemetry': minor
'@assay/validation': minor
'@assay/web': minor
---

chore(c4): narrow the product Node floor from `>=22` to `>=24`.

The `>=22` floor was a product claim that no gate could exercise: this environment has only Node
24.13.0, so the declared minimum was never run and the node support contract recorded that limitation
explicitly. The maintainer asked whether Node 22 support is still required; it is not — nothing in the
product depends on 22-only behaviour and no consumer is known to run it. Every app and library
manifest now declares the line every gate actually runs on (`node: ">=24"`), so the claim is exercised
in CI and locally instead of being an unverifiable statement.

`>=24` keeps the previous _floor_ shape (a minimum line, not a tested-version pin): 24.13.0 is the
tested runtime, other 24.x patches/minors and later majors are not individually claimed — exactly the
claim shape the development policy (`^24.0.0`) already makes. The development policy and
`.node-version` are unchanged.

Semver: nothing is published yet (publication is still an open maintainer decision), so no released
artifact is retroactively narrowed and a major bump would only manufacture a 1.0.0. Recorded as minor
for the pre-1.0 packages; when the first release is cut, the floor it ships with is 24. If a version
had already shipped, this change would have been a major.
