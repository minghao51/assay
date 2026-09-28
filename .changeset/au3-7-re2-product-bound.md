---
'@assay/validation': patch
'@assay/contracts': patch
---

fix(au3-7): guard the RE2 nested-repetition **product** bound (S7)

The two mirrored RE2-subset checkers enforced only the per-quantifier limit
(`{n}`, `{n,m}` ≤ 1000), but DuckDB 1.5.5 (RE2) also caps the **product** of
nested repeat counts at 1000 along any one atom's path. Live pinned-CLI
evidence: `(a{100}){10}` (= 1000) runs while `(a{32}){32}` (= 1024) throws
`Invalid Input Error: invalid repetition size: {32}`, and `(a{1000}){1000}`
throws — yet `checkRe2Pattern('(a{1000}){1000}')` previously returned
`valid: true`, so a contract/validation regex could pass the checker and then
throw at engine execution.

Both checkers now track each atom's accumulated repeat expansion during parse
and refuse when a quantifier pushes the product past 1000, using the existing
repetition-limit rejection shape
(`nested repetition product 1024 exceeds the RE2 limit of 1000`). The factor a
quantifier contributes is its `max` for a bounded `{n,m}`, `n` for `{n}` and
for an unbounded `{n,}` (an unbounded max contributes its minimum), and 1 for
`* + ?`.

The checker-vs-engine agreement pool gains the boundary patterns
(`(a{40}){25}`, `((a{10}){10}){10}`, `(a{1000}){1}`, `(a{31}){32}` accepted;
`(a{32}){32}`, `(a{1000}){1000}`, `(((a{10}){10}){10}){10}`, `(a{400,600}){2,}`
refused), and the gated real-DuckDB suite now cross-checks the boundary in
both directions. No accepted non-nested pattern changes behavior.
