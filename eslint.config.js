import js from '@eslint/js'
import importX from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// q-7: browser-only globals banned in the environment-neutral packages
// (`domain`, `grid`, `core`). `ui` is the React/DOM layer, so it is exempt
// from this list but still banned from `fetch`.
const BROWSER_ONLY_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'alert',
  'confirm',
  'prompt',
  'FileReader',
  'HTMLElement',
  'Image',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
]

// au2-3: packages must never import applications. The relative `**/apps/*`
// form catches path imports; the scoped package names catch the workspace
// app packages (`@assay/web`, `@assay/cli`) that the relative pattern alone
// misses. The `@assay/web/*` / `@assay/cli/*` entries close the
// subpath-import loophole. Kept as one shared object so the shared block and
// each package block that overrides `no-restricted-imports` (domain, grid)
// read identically.
const APP_IMPORT_BAN = {
  group: ['**/apps/*', '@assay/web', '@assay/cli', '@assay/web/*', '@assay/cli/*'],
  message:
    'Packages must not import applications (docs/engineering/03-repository-structure.md §3).',
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // au2-3: React Hooks rules across TS/TSX sources. Only the two classic
    // hook rules are enabled — NOT the plugin's `recommended` preset, which
    // also switches on the React Compiler rule family (static-components,
    // immutability, refs, set-state-in-effect, …); adopting that set is a
    // separate queued task. Both rules are errors: `rules-of-hooks` (a
    // violation is a real bug) and `exhaustive-deps`. f-3 closed the three
    // warnings au2-3 surfaced (DataGrid schema fallback + RecordInspector
    // latest overlay revision), so the binding rule can hold the line instead
    // of reporting.
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // f-8: type-aware async-safety rules over package/app source. `projectService`
    // uses the nearest tsconfig per file (the repo has one per package/app), so no
    // explicit `project` globbing and no per-directory blocks. Scoped to source
    // (not scripts, config, or tests outside the tsconfig programs, e.g. `tests/**`)
    // to keep the type program small.
    // Measured cost: lint ≈9.6s → ≈17.7s (+~8s, ~1.8×); zero existing violations.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [APP_IMPORT_BAN],
        },
      ],
    },
  },
  {
    // q-7: no console output in package/app source, tests included — tests
    // route through injectable output instead.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // q-7: explicit allowlist — Playwright specs print by design (harness
    // output) and repo scripts/config files are tooling, not product source.
    files: ['scripts/**', 'tests/**', '**/*.config.{js,mjs,cjs,ts}', 'eslint.config.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // q-7: import-cycle detection across packages and apps. `import-x` is the
    // maintained fork with explicit ESLint 10 flat-config support (upstream
    // `eslint-plugin-import` declares support only through ESLint 9); the
    // plugin is registered as `import` to keep rule names conventional.
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    plugins: { import: importX },
    settings: {
      // TypeScript sources are the primary graph nodes; without this the
      // plugin's ExportMap treats `.ts` as an invalid extension and skips them.
      'import-x/extensions': [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.json',
      ],
      'import-x/resolver-next': [
        importX.createNodeResolver({
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
          // Source imports use extensionful specifiers (`.js`) that map onto
          // TypeScript sources; map them so the cycle graph sees local edges.
          extensionAlias: {
            '.js': ['.ts', '.tsx', '.js'],
            '.mjs': ['.mts', '.mjs'],
            '.cjs': ['.cts', '.cjs'],
          },
        }),
      ],
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: Infinity }],
    },
  },
  {
    files: ['packages/validation/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The validation package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The validation package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: ['@assay/ui', '@assay/grid', '@assay/engine-*', '@assay/web', '@assay/cli'],
              message:
                'The validation package is pure: no UI/engine/app dependencies (docs/engineering/03-repository-structure.md §3, ADR 0026).',
            },
            // f-4: this block replaces the shared `no-restricted-imports` for
            // `packages/validation` (flat config: last matching options win),
            // so the app-import ban must be repeated here — a relative
            // `../../apps/*` import otherwise bypassed the scoped-name group
            // above (reviewer-proven probe, au2-3/f-4).
            APP_IMPORT_BAN,
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The contracts package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The contracts package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: ['@assay/*'],
              message:
                'The contracts package is a pure leaf: no @assay dependencies (docs/engineering/03-repository-structure.md §3, ADR 0013).',
            },
            // f-4: repeated from the shared block — see the validation block's
            // comment; the scoped group above does not catch relative
            // `../../apps/*` specifiers.
            APP_IMPORT_BAN,
          ],
        },
      ],
    },
  },
  {
    files: ['packages/diff/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The diff package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The diff package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: [
                '@assay/ui',
                '@assay/grid',
                '@assay/core',
                '@assay/data-sources',
                '@assay/security',
                '@assay/transforms',
                '@assay/ai',
                '@assay/pipeline',
                '@assay/engine',
                '@assay/engine-*',
                '@assay/testing',
                '@assay/web',
                '@assay/cli',
              ],
              message:
                'The diff package is pure: no UI/engine/app dependencies (docs/engineering/03-repository-structure.md §3). Allowed @assay deps: contracts, domain, validation (M6 queue, handoff §6 m6-0).',
            },
            // f-4: repeated from the shared block — see the validation block's
            // comment; the scoped group above does not catch relative
            // `../../apps/*` specifiers.
            APP_IMPORT_BAN,
          ],
        },
      ],
    },
  },
  {
    // q-7: domain is the portability floor — no React, no UI/engine packages,
    // no browser-only globals, no Node builtins (docs/engineering/03-repository-structure.md §3).
    files: ['packages/domain/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The domain package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The domain package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: ['@assay/ui', '@assay/grid', '@assay/engine-*'],
              message:
                'The domain package must not depend on UI or engine implementations (docs/engineering/03-repository-structure.md §3).',
            },
            // au2-3: this block's `no-restricted-imports` replaces the shared
            // one for `packages/domain` (flat config: last matching rule options
            // win), so the app-import ban must be repeated here to apply.
            APP_IMPORT_BAN,
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...BROWSER_ONLY_GLOBALS.map((name) => ({
          name,
          message:
            'The domain package must stay environment-neutral — browser APIs are banned (docs/engineering/03-repository-structure.md §3).',
        })),
      ],
    },
  },
  {
    // f-4: domain src is a DEPENDENCY-FREE ZONE — today it imports nothing
    // external at all (only relative modules; typescript + vitest are
    // dev-only and used by tests). Scoping `no-extraneous-dependencies` to
    // src with devDependencies disallowed encodes that policy: any future
    // external import — runtime or dev — errors here, and the only way
    // through is declaring it in package.json, which makes the dependency
    // growth itself the visible, reviewable event. (pnpm's isolation already
    // prevents phantom resolution; this rule is the durable encoding that
    // survives any linker-config change.) Test files opt back out below —
    // they legitimately import vitest. (Negation in `files` is avoided: a
    // leading `!` entry is applied as its own matcher, which matched the
    // whole repo in ESLint 10.)
    files: ['packages/domain/src/**/*.{ts,tsx}'],
    plugins: { import: importX },
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, peerDependencies: false, optionalDependencies: false },
      ],
    },
  },
  {
    // f-4: tests are the deliberate exception to the dependency-free zone.
    files: ['packages/domain/src/**/*.test.{ts,tsx}'],
    plugins: { import: importX },
    rules: {
      'import/no-extraneous-dependencies': 'off',
    },
  },
  {
    // t-1: telemetry is a pure, environment-neutral core — mirror domain's
    // portability floor (no React, no UI/engine packages, no browser-only
    // globals, no Node builtins) so the design's zero-network/fs/child_process
    // surface (R6/R12/R13) is encoded, not just documented.
    files: ['packages/telemetry/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The telemetry package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The telemetry package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: ['@assay/ui', '@assay/grid', '@assay/engine-*'],
              message:
                'The telemetry package must not depend on UI or engine implementations (docs/engineering/03-repository-structure.md §3).',
            },
            // f-4: this block's `no-restricted-imports` replaces the shared
            // one for `packages/telemetry` (flat config: last matching rule
            // options win), so the app-import ban must be repeated here.
            APP_IMPORT_BAN,
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...BROWSER_ONLY_GLOBALS.map((name) => ({
          name,
          message:
            'The telemetry package must stay environment-neutral — browser APIs are banned (docs/engineering/03-repository-structure.md §3).',
        })),
      ],
    },
  },
  {
    // t-1: telemetry src is a DEPENDENCY-FREE ZONE — the design's zero-network
    // surface requires that no external module is imported at all (only
    // relative modules; typescript + vitest are dev-only and used by tests).
    // Declaring a dependency in package.json is the only way through, making
    // dependency growth itself the visible, reviewable event.
    files: ['packages/telemetry/src/**/*.{ts,tsx}'],
    plugins: { import: importX },
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, peerDependencies: false, optionalDependencies: false },
      ],
    },
  },
  {
    // t-1: tests are the deliberate exception to the dependency-free zone.
    files: ['packages/telemetry/src/**/*.test.{ts,tsx}'],
    plugins: { import: importX },
    rules: {
      'import/no-extraneous-dependencies': 'off',
    },
  },
  {
    // q-7: grid is a headless model — mirror domain's bans exactly.
    files: ['packages/grid/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The grid package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The grid package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: ['@assay/ui', '@assay/grid', '@assay/engine-*'],
              message:
                'The grid package must not depend on UI or engine implementations (docs/engineering/03-repository-structure.md §3).',
            },
            // au2-3: this block's `no-restricted-imports` replaces the shared
            // one for `packages/grid` (flat config: last matching rule options
            // win), so the app-import ban must be repeated here to apply.
            APP_IMPORT_BAN,
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...BROWSER_ONLY_GLOBALS.map((name) => ({
          name,
          message:
            'The grid package must stay headless — browser APIs are banned (docs/engineering/03-repository-structure.md §3).',
        })),
      ],
    },
  },
  {
    // q-7: core is orchestration and stays portable like domain — no Node
    // builtins and no browser-only globals (parity with domain/grid).
    // f-4: import restrictions were missing entirely; core now carries the
    // same UI/engine/app bans as domain and grid so the layering is encoded,
    // not just documented.
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The core package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
            {
              name: 'react-dom',
              message:
                'The core package must stay UI-free (docs/engineering/03-repository-structure.md §3).',
            },
          ],
          patterns: [
            {
              group: ['@assay/ui', '@assay/grid', '@assay/engine-*'],
              message:
                'The core package must not depend on UI or engine implementations (docs/engineering/03-repository-structure.md §3).',
            },
            // f-4: repeated from the shared block — see the validation block's
            // comment (block-level `no-restricted-imports` replaces it).
            APP_IMPORT_BAN,
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...BROWSER_ONLY_GLOBALS.map((name) => ({
          name,
          message:
            'The core package must stay environment-neutral — browser APIs are banned (docs/engineering/03-repository-structure.md §3).',
        })),
      ],
    },
  },
  {
    // p-1: pipeline is a pure, environment-neutral IR package — mirror
    // domain/grid's portability floor (no React, no UI/engine/app packages,
    // no browser-only globals, no Node builtins) and encode the ADR 0031/0032
    // boundary: dbt/SQLMesh/Dagster are compatibility and execution adapters,
    // never core runtime dependencies. Allowed @assay deps per
    // docs/engineering/03-repository-structure.md §5: contracts, domain,
    // validation; `yaml` is the one external runtime dep (contracts precedent).
    files: ['packages/pipeline/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'The pipeline package must stay UI-free (docs/engineering/03-repository-structure.md §5).',
            },
            {
              name: 'react-dom',
              message:
                'The pipeline package must stay UI-free (docs/engineering/03-repository-structure.md §5).',
            },
          ],
          patterns: [
            {
              group: [
                '@assay/ui',
                '@assay/grid',
                '@assay/engine',
                '@assay/engine-*',
                '@assay/core',
                '@assay/data-sources',
                '@assay/security',
                '@assay/transforms',
                '@assay/ai',
                '@assay/testing',
              ],
              message:
                'The pipeline package is pure: no UI/engine/app dependencies (docs/engineering/03-repository-structure.md §5, ADR 0030). Allowed @assay deps: contracts, domain, validation.',
            },
            {
              group: [
                'dbt',
                'dbt-*',
                '@dbt/*',
                'sqlmesh',
                'sqlmesh-*',
                '@sqlmesh/*',
                'dagster',
                'dagster-*',
                '@dagster/*',
              ],
              message:
                'dbt/SQLMesh/Dagster are compatibility and execution adapters, never core runtime dependencies (ADR 0031/0032).',
            },
            // Repeated from the shared block — block-level `no-restricted-imports`
            // replaces it, so the app-import ban must be restated.
            APP_IMPORT_BAN,
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...BROWSER_ONLY_GLOBALS.map((name) => ({
          name,
          message:
            'The pipeline package must stay environment-neutral — browser APIs are banned (docs/engineering/03-repository-structure.md §5).',
        })),
      ],
    },
  },
  {
    // p-1: pipeline src declares only its real runtime deps (`yaml`,
    // `@assay/validation`); any undeclared external import errors here (the
    // domain/telemetry dependency-zone precedent).
    files: ['packages/pipeline/src/**/*.{ts,tsx}'],
    plugins: { import: importX },
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, peerDependencies: false, optionalDependencies: false },
      ],
    },
  },
  {
    // p-1: tests opt out of the dependency-free/node-builtin bans — they
    // legitimately import vitest and read the golden fixtures with node:fs.
    files: ['packages/pipeline/src/**/*.test.{ts,tsx}'],
    plugins: { import: importX },
    rules: {
      'import/no-extraneous-dependencies': 'off',
      'import/no-nodejs-modules': 'off',
    },
  },
  {
    // q-7: ui is the React/DOM layer (React + DOM allowed) but must not couple
    // to Node builtins or the network directly.
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'The ui package must not fetch directly — route through core/data-sources (docs/engineering/03-repository-structure.md §3).',
        },
      ],
    },
  },
)
