// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The first-run disclosure copy, byte-exact to design §6.3 (revision `1`).
 *
 * These constants live in the pure package so the web and CLI surfaces render
 * the **same** bytes; a surface may wrap them but must not paraphrase them
 * (ADR 0037: the disclosure is the consent artifact). The web body excludes
 * only the interactive button row, whose labels are separate constants so the
 * dialog can render real controls; the CLI copy is a single stderr block.
 *
 * No environment, clock, storage, or network is read here.
 */

/** The disclosure copy revision recorded in `disclosure_shown` (design §3.3). */
export const DISCLOSURE_REVISION = 1

/** The web disclosure body (design §6.3, excluding the button affordances). */
export const WEB_DISCLOSURE_BODY = `Help improve Assay — anonymously

Assay is local-first: your data stays on your machine. With your permission,
Assay sends a small amount of anonymous usage metadata to a server run by the
Assay project.

What is sent: which features you use (for example, "validation ran"), coarse
counts and size ranges, how long operations took, and whether they succeeded —
plus the app version and your OS family.

What is never sent: your data, cell values, file names or paths, SQL text or
query results, contract contents, column names, or anything that identifies you.

Anonymous usage metadata is on by default. Turn it off any time in Settings, or
set ASSAY_NO_TELEMETRY=1 before launching Assay. Turning it off takes effect
immediately and nothing further is sent.`

/** The web "keep on" button label (design §6.3). */
export const WEB_DISCLOSURE_KEEP_ON_LABEL = 'Keep anonymous usage on (default)'

/** The web "turn it off" button label (design §6.3). */
export const WEB_DISCLOSURE_TURN_OFF_LABEL = 'Turn it off'

/** The CLI disclosure, written to stderr only (design §6.3). */
export const CLI_DISCLOSURE_COPY = `Assay sends anonymous usage metadata by default: which commands you run, coarse
counts and durations, success/failure, and the app/engine version. It never
sends your data, file names, SQL, or cell values. Disable with
ASSAY_NO_TELEMETRY=1 (or \`assay --no-telemetry\`). This notice is shown once.
See docs/engineering/06-telemetry-design.md.`
