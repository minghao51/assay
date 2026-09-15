import js from '@eslint/js'
import tseslint from 'typescript-eslint'

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
                'Packages must not import applications (docs/engineering/05-repository-structure.md §3).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'The domain package must stay UI-free (docs 05 §3).' },
            { name: 'react-dom', message: 'The domain package must stay UI-free (docs 05 §3).' },
          ],
          patterns: [
            {
              group: ['@assay/ui', '@assay/grid', '@assay/engine-*'],
              message:
                'The domain package must not depend on UI or engine implementations (docs 05 §3).',
            },
          ],
        },
      ],
    },
  },
)
