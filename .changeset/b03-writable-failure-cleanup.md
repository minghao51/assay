---
'@assay/web': patch
---

fix(b03): give the browser export writable one explicit failure boundary.
`writeExportCopy` wrote and closed a picked handle's writable sequentially with
no cleanup, and `SaveWritable` declared only `write`/`close`. It now exposes an
optional `abort?(reason?)` (the DOM `FileSystemWritableFileStream` operation;
existing structural fakes stay valid), wraps `write`+`close` in one failure
boundary after `createWritable` succeeds, and on either failure attempts
`abort` at most once with a value-free internal reason — ignoring an abort that
itself fails, so the primary rejection (original error identity) is what the
caller reports. A failed write never falls through to `close` as a success
path, a success closes exactly once and never aborts, a read or `createWritable`
failure never touches a writable, and nothing is retried (a retry would deliver
the export twice). Picker timing, same-source refusal, download fallback and the
resolved `SaveStrategy` are unchanged, and no Cancel UI was added. This is
best-effort cleanup, not a claim that abort restores a destination on every
browser or that a download is persistent.
