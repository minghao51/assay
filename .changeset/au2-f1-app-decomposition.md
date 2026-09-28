---
'@assay/web': patch
---

refactor(au2-f1): decompose `App.tsx` (slice 1) into per-domain session hooks. The editing/history, validation, and diff/comparison state machines move to `sessions/useEditingSession.ts`, `sessions/useValidationSession.ts`, and `sessions/useDiffSession.ts`; a shared `sessions/session-reset.ts` registry replaces the hand-written ~14-slot reset in `openDataFile` with one `beginSession()` call (token bumped first, then each hook's reset in registration order). The au3-12 module-state panel preload moves verbatim to `lib/bottom-panels.ts` and q-1's `useModelSlice` to `lib/use-model-slice.ts`. **No behavior change**: all four App test files pass unchanged, the module-state panel preload stays synchronous before `ready`, and the undo/redo `historyRef`, session-token, and value-free error semantics are preserved (1959 unit / 145+1 e2e).
