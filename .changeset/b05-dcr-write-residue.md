---
'@assay/cli': patch
---

fix(b05): make a failed `assay dcr` write honest about its residue. The
exclusive new-file write now opens with `wx`, writes the UTF-8 bytes fully
(short writes loop, nonpositive progress fails), closes the handle and returns
the exact byte count actually written; the public `{ok:false,
reason:'path-exists'}` result, the exit classes and the report bytes are
unchanged. On a write or close failure the handle is closed and the partial file
is removed only with a verified ownership identity (dev/ino/nlink matched by a
best-effort `lstat`), preserving the primary authored failure. When the identity
cannot be verified or no longer matches, the residue is left in place and the
authored message says the requested new artifact may be incomplete — it never
claims nothing was written. The identity check and the unlink are not atomic:
the same check-then-unlink replacement race as the desktop writer is documented
and not advertised as replacement safety, and no temporary-file/rename
publishing is used. Tests inject a private fs seam for write/close/cleanup
faults, short and zero-progress writes, a concurrently created output, a
replacement visible before the identity check and an unverifiable identity,
plus real temp-filesystem CLI integration for the unwritable-directory refusal
and the on-disk byte count.
