import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/web'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // `vite` serves the interface with hot reload while `wrangler dev` runs the
  // Worker beside it, so the API, sessions and D1 are the real ones.
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8789',
      '/s': 'http://127.0.0.1:8789',
    },
  },
})
