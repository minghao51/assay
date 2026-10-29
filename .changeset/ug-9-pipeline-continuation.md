---
'@assay/web': patch
---

feat(web): continue the pipeline journey from App-held artifacts (R-15 / ug-9)

Binding no longer restarts the journey. The open flow retains the opened `File`
as App-held session state (`openSourceRef`, reference-only, never rendered or
logged — ADR 0025) and clears it on every epoch reset. A pipeline `source` node
now offers the primary **"Use the open dataset"** (only while a dataset is
open) beside the existing picker as **"Choose a different file…"**; a
`validate` node offers **"Use the loaded contract"** (only while Validation
holds a parsed contract) beside **"Choose a different contract…"**. Both
primaries bind from existing state with no OS picker, reuse the honest binding
shapes (`bind-failed` etc.) and the session-token discipline, and keep the
existing no-guess refusal path. The validation session gains a parsed-contract
load seam (`handleContractDocument`) that applies the same
new-contract-invalidates-the-verdict rule and bumps `validationSeq`; loading is
not validating, so validation stays an explicit click.

A failed validate gate now offers **"Inspect this contract in Validation"**
(also when the run actually stopped at a blocked publish gate while a validate
gate failed). It loads the run's bound contract into the validation session with
no picker, reveals/expands the Validation section through the existing nav
seam, and focuses it, so the next Validate names the failing ruleIds instead of
re-picking artifacts.

The first DCR mention is now the export legend **"Export the Dataset Change
Request (DCR)"** plus the purpose sentence "A Dataset Change Request packages a
proposed dataset change for review — like a pull request for data."; later
mentions may abbreviate to "DCR" (the export button and post-action status line
keep the short form).

Pins: focused panel pins for primary/secondary visibility and copy, the
cross-link's presence posture and the no-bare-DCR text pin; App-level pins
proving the picker fake is never called by either primary, the exact loaded
contract object reaches the runner, and the cross-link loads the run's contract
without auto-running validation; Playwright journeys (a) and (b) armed with a
file-chooser spy that fails if an OS dialog appears, plus the DCR text pin on
the rendered panel. No engine/pipeline-IR/protocol change, no new dependency, no
telemetry, no storage, no DOM reorder (ADR 0044/q-15).
