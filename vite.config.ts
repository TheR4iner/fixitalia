import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // Bind on all interfaces so the dev container's port publish works,
    // and so phones/tablets on the LAN can reach the dev server.
    host: true,
    port: 5173,
    // Proxy /api to the backend so the browser sees a single origin.
    // The frontend can use relative URLs like `/api/...` everywhere.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_BACKEND_PORT || 3001}`,
        changeOrigin: true,
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // `import.meta.dirname`, not `__dirname`: Vite 8 warns that the
      // native config loader it is moving to cannot provide the CommonJS
      // globals, and that loader becomes the default in a future major.
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Function form, not the object form. Vite 8 bundles with Rolldown,
        // which accepts only a function here and fails the build with
        // "manualChunks is not a function" otherwise. Same two chunks as
        // before: React and the router together, recharts on its own so the
        // charting code is not pulled into the initial payload.
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return 'vendor'
          }
          if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) return 'charts'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Only frontend tests live here. Server tests (server/**/*.test.ts) run
    // under the BACKEND vitest (cd server && npm run test:run) where the
    // surrealdb / express deps are installed. Without this filter the
    // frontend vitest tries to load server/lib/scheduler.test.ts and crashes
    // because it can't resolve `surrealdb` from server/lib/db.ts.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
