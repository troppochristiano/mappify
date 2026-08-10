import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 5273, not 5173 — the portfolio dev server owns 5173.
// /api is proxied to the local server so the browser never makes a cross-origin call.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
})
