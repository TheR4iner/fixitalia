import { defineConfig } from 'vitest/config'

// Explicit vitest config in server/ so that running `vitest run` from this
// directory does NOT walk up the tree and pick up the frontend's
// vite.config.ts (which depends on `vite`, not installed in server's
// node_modules). With this file in place, vitest treats server/ as the
// root and only loads server's own deps.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['lib/**/*.test.ts', 'routes/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
