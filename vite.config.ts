import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev: SPA calls /api/* and /baton/* → Baton BFF (holds the gateway session + policy engine)
      '/api': { target: 'http://localhost:4400', changeOrigin: true },
      '/baton': { target: 'http://localhost:4400', changeOrigin: true },
    },
  },
})
