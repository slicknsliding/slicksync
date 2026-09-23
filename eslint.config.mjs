// Lint config for the server tree. `npm run lint` pointed at server/ for a
// long time with no config anywhere above it, so the command failed outright
// rather than reporting anything. The client has its own config next door.
//
// Deliberately narrow: this is a large, working codebase, so the rules here
// are the ones that catch real mistakes - a name that does not exist, a
// promise nobody waits on - rather than style opinions that would bury those
// findings under thousands of complaints.
import js from '@eslint/js';

export default [
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', module: 'writable',
        require: 'readonly', exports: 'writable', global: 'writable',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', queueMicrotask: 'readonly',
        fetch: 'readonly', AbortController: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', TextEncoder: 'readonly',
        TextDecoder: 'readonly', structuredClone: 'readonly',
        crypto: 'readonly', performance: 'readonly',
        AbortSignal: 'readonly', Intl: 'readonly', Response: 'readonly',
        Request: 'readonly', Headers: 'readonly', Blob: 'readonly',
        ReadableStream: 'readonly', WritableStream: 'readonly',
        TransformStream: 'readonly', FormData: 'readonly', atob: 'readonly',
        btoa: 'readonly', WebSocket: 'readonly', Event: 'readonly',
        EventTarget: 'readonly', MessageChannel: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Reporting every unused argument in a codebase this size would drown
      // the real findings; an unused local variable is still worth knowing.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // The ones that have actually bitten: a typo'd name, a call that can
      // never work, a promise nobody waits on.
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'require-atomic-updates': 'warn',
      'no-async-promise-executor': 'error',
      // `while (true)` is how every worker and poll loop in here is written,
      // including the shared concurrency helper. The rule is about accidental
      // constants in an `if`, not deliberate loops.
      'no-constant-condition': ['error', { checkLoops: false }],
      // Legal since ES6 and used on purpose in a few places; worth seeing,
      // not worth failing a release over.
      'no-inner-declarations': 'warn',
      'no-useless-catch': 'warn',
    },
  },
];
