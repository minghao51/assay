// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shared pipeline-text sanitizer (p2-1): one pure, dependency-free home
 * for the C0/C1 control-character escape. The CLI
 * (`apps/cli/src/report-pipeline.ts`) and the web panel
 * (`apps/web/src/pipeline/sanitize.ts`) previously carried byte-identical
 * private copies; both now re-point here (p2-1 item (a)).
 *
 * Every pipeline-derived string — node ids, relation names, pipeline names,
 * source paths, and `describePipelineError` one-liners (whose parse-error
 * messages embed raw YAML excerpts) — is untrusted *authored content*
 * (ADR 0007 spirit / ADR 0025 discipline). React text nodes escape HTML by
 * default, and the CLI renders to a terminal; in both cases a raw U+001B or
 * C1 byte would render invisibly (or act on capable terminals). This helper
 * rewrites every C0/C1 control character as a visible lowercase `\uXXXX`
 * escape, so the rendered text is honest about what the document contains.
 *
 * Escape set: U+0000–U+001F and U+007F–U+009F, each as `\uXXXX` (4 hex
 * digits, lowercase, zero-padded). Ordinary text (and backslashes) passes
 * through verbatim — the escapes are inert text, so a literal `\u001b`
 * sequence already in the document stays byte-stable.
 *
 * Purity: string → string only; no imports, no React, no browser APIs, no
 * engine (the `packages/pipeline` dependency-free zone).
 */
export function sanitizePipelineText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += char
    }
  }
  return out
}
