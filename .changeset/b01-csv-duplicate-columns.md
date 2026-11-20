---
'@assay/web': patch
---

fix(b01): refuse a repeated declared column name in the CSV review's types box
instead of overwriting the earlier declaration. The parser assigned
`columns[name] = type` per line, so `id: BIGINT` followed by `id: VARCHAR`
silently declared only the last line — a declared type was lost with no notice.
Each repeated parsed name (same or different type, after the existing trim) is
now refused before dispatch with a typed, value-free internal refusal
(`{code:'duplicate-column', line}`) and its own user sentence; names stay
case-sensitive, blank lines keep their numbering, and the failed form dispatches
no preview/adoption request, so the settled sample is untouched. Malformed lines
now carry `{code:'malformed-line', line}` with unchanged copy. The columns map is
built with a null prototype, so `constructor`/`toString` are literal column names
end to end (including the structured-clone request boundary); `__proto__` — the
one name that a plain-object map cannot own, and which the engine's validated
copy would drop silently — gets an explicit value-free refusal rather than a
silent loss. No wire bytes change for an ordinary declaration.
