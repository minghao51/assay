---
'@assay/telemetry': minor
'@assay/web': minor
'@assay/cli': minor
---

feat(t-2): telemetry emission surfaces + opt-out/disclosure UX.

Wire the landed t-1 pure core into the web and CLI surfaces (design
`docs/engineering/06-telemetry-design.md` §2/§5.2/§6/§8, ADR 0037/0025/0045).
The pure package gains three app-agnostic additions (all still timer/network/
fs/env-free): a bounded event buffer + batch splitter (§5.2/§8.3), a
per-session tracker (monotonic seq, first-query exception, 50-per-session
`dataset_opened` cap), and the byte-exact §6.3 disclosure copy. The web app
emits `app_boot`, `disclosure_shown`, `dataset_opened`/`_failed`,
`validation_run`, `diff_run`, `profile_run`, `query_run` (SQL/nested/paging
from the SQL pane; filter/sort `query_run` is deliberately deferred until a
genuine settle seam exists — the request-time seam fabricated its duration and
outcome) and `export_run`; it adds
the first-run disclosure (modal, byte-exact §6.3 revision 1), a minimal
Settings toggle persisted in `localStorage['assay.telemetry']`, and Vite
build-time `define`s for `ASSAY_TELEMETRY_ENDPOINT`/`_TOKEN` and a hard off
from `ASSAY_NO_TELEMETRY` (stock build inert, zero network). The CLI gains
`--no-telemetry` plus `ASSAY_NO_TELEMETRY`/`DATAWORKBENCH_NO_TELEMETRY` with
the §6.1 precedence and a `~/.config/assay` preference, the disclosure to
stderr only once per install, and `app_boot`/`disclosure_shown`/
`dataset_opened`/`_failed`/`validation_run`/`diff_run`. Both surfaces inject
the transport (default HTTP `fetch`, constructed only after the endpoint
gate), re-check the preference before every send (§6.4), clear the buffer
synchronously on mid-session opt-out (§6.5), clamp `client_day` (§6.6), bound
the CLI exit flush, and swallow every failure (R9).
