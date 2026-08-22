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
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
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
