/**
 * Data Workbench CLI — pre-MVP scaffold.
 *
 * Planned commands (docs/product/07-mvp-scope-and-acceptance.md §2):
 *   assay profile <path>
 *   assay validate <path> [--contract <file>]
 *   assay diff <base> <candidate>
 *
 * The CLI shares the same core packages as web and VS Code (ADR 0008).
 * Binary distribution approach is open decision D10 in the execution roadmap.
 */

const VERSION = '0.0.0'
const PLANNED_COMMANDS = ['profile', 'validate', 'diff'] as const

export function main(): void {
  console.log(`assay ${VERSION} — pre-MVP scaffold`)
  console.log(`Planned commands (M5+): ${PLANNED_COMMANDS.join(', ')}`)
  console.log('See docs/product/10-execution-roadmap.md for sequencing.')
}

main()
