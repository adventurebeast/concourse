// Lean ESLint flat config — no preset dependency. Prettier owns formatting, so
// style rules stay off here; this layer only catches genuine correctness smells
// (duplicate keys, unreachable code, bad typeof, self-assignment, …). no-undef is
// off because the bundler resolves globals across the main/preload/renderer split
// and maintaining a globals allow-list buys little for a single-team codebase.
export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }
      ],
      'no-undef': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-finally': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-fallthrough': 'error'
    }
  },
  {
    ignores: ['out/**', 'release/**', 'node_modules/**', 'build/**', 'docs/**']
  }
]
