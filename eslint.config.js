import js from '@eslint/js'
import importX from 'eslint-plugin-import-x'
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
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/*'],
              message:
                'Packages must not import applications (docs/engineering/03-repository-structure.md §3).',
            },
          ],
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
    files: ['packages/validation/**/*.ts'],
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
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
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
          ],
        },
      ],
    },
  },
  {
    files: ['packages/diff/**/*.ts'],
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
          ],
        },
      ],
    },
  },
  {
    // q-7: domain is the portability floor — no React, no UI/engine packages,
    // no browser-only globals, no Node builtins (docs/engineering/03-repository-structure.md §3).
    files: ['packages/domain/**/*.ts'],
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
    // q-7: grid is a headless model — mirror domain's bans exactly.
    files: ['packages/grid/**/*.ts'],
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
    files: ['packages/core/**/*.ts'],
    rules: {
      'import/no-nodejs-modules': 'error',
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
