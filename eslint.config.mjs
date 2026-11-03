import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'release/**', 'src-tauri/**']
  },
  js.configs.recommended,
  {
    rules: {
      // Catch parameters are intentionally named in this codebase so that
      // unexpected errors stay inspectable while debugging.
      'no-unused-vars': ['error', { caughtErrors: 'none' }]
    }
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: Object.assign({}, globals.browser)
    },
    rules: {
      eqeqeq: ['warn', 'smart']
    }
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: Object.assign({}, globals.serviceworker, globals.browser)
    },
    rules: {
      eqeqeq: ['warn', 'smart']
    }
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: Object.assign({}, globals.node)
    },
    rules: {
      eqeqeq: ['warn', 'smart']
    }
  }
];
