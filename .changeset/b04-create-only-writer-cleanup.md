---
'@assay/vscode': patch
---

fix(b04): close the create-only export handle on every failure after `open`, and
stop cleanup from deleting a delivered file. The desktop export writer is now
explicitly phased `not-open → opened-unverified → owned → writing → closed`:
every post-open acquisition step is cleanup-protected, a `stat` failure still
closes the handle but never unlinks a path whose dev/ino/nlink identity was not
established, and once the identity IS established one narrow best-effort
cleanup routine owns both the cancel path and a failed `close` (a failed close
no longer skips the cleanup decision, it no longer leaves unreported debris).
`close()` and `cleanup()` each memoize one in-flight promise, so concurrent
callers observe one verdict and the handle is never closed twice; a cleanup
after a verified close is a no-op instead of removing the delivered artifact,
and a `close()` after a cancel reports `destination-raced` instead of pretending
no sync happened. Short-write looping, nonpositive-progress rejection, source
canonicalization, `wx`, `0600` and the refusal categories
(`destination-refused`/`destination-raced`/`write-failed`) are unchanged. No
atomic-delivery claim is made: identity-check-then-unlink is still two syscalls,
so an unverifiable or replaced path may be left as documented residue. Tests
inject a private fs seam for stat/sync/first-and-final-lstat/close/unlink
failures plus short and zero-progress writes, and the real temp-directory suite
covers existing destination, source alias, completed close, repeated cleanup,
replacement-before-identity-check and an unchanged source.
