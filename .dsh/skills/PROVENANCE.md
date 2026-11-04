# Skill provenance

The existing import note below records a 2026-10-27 shallow default-branch clone; it did not record the source commit, so an exact upstream revision cannot be established from these files. Integration was authorized by the user on 2026-11-04. These are optional development instructions subordinate to `AGENTS.md` and the live operating model, not application dependencies.

Both upstream repositories publish MIT-licensed skills. The notices retrieved from their public license endpoints on 2026-11-04 are retained verbatim:

- [DeepSeek Harness adaptation notice](licenses/dsh-mattpocock-skills.LICENSE) — source: <https://github.com/little3tar/dsh-mattpocock-skills/blob/main/LICENSE>.
- [Original Matt Pocock notice](licenses/mattpocock-skills.LICENSE) — source: <https://github.com/mattpocock/skills/blob/main/LICENSE>.

These MIT notices apply to the adapted `tdd/` and `diagnosing-bugs/` content, including the helper template. Assay-specific gate/fixture guidance is repository-authored. Local integration changes add precedence/privacy notes, expand the gate checklist to the real project gates, and apply repository formatting; no upstream update or exact-source equivalence is claimed.

- `tdd/` and `diagnosing-bugs/` are adapted from
  [little3tar/dsh-mattpocock-skills](https://github.com/little3tar/dsh-mattpocock-skills)
  (itself adapted from [mattpocock/skills](https://github.com/mattpocock/skills)),
  cloned 2026-10-27 (shallow, default branch).
- Adaptations (kept deliberately general, not repo-locked):
  - `tdd`: removed the `GLOSSARY.md` reference (generalized to "project domain vocabulary"),
    removed the `codebase-design` skill cross-reference, removed the `code-review`
    skill cross-reference.
  - `diagnosing-bugs`: the original import note reports a generalized `GLOSSARY.md` sentence
    and otherwise verbatim content. The later Assay integration added the helper template's
    privacy/placeholder comments and repository formatting, as described above; the current
    template is therefore adapted, not a byte-identical upstream copy.
- The other skills in that pack (flows like `grill-me`, `triage`, `implement-spec`, and the
  `codebase-design` vocabulary) were evaluated and deliberately not installed — see session
  discussion 2026-10-27. `code-review` is a candidate for later adoption with its
  spec/tracker sources rewired to this repo's handoff/ADR docs.
