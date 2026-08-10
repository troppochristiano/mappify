import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 5273, not 5173 — the portfolio dev server owns 5173.
//
// /api is proxied to the local server so the browser never makes a cross-origin
// call, which is also why the session cookie works in development without any
// CORS involvement: to the browser it is all one origin.
//
// Both ports give way to the environment so a second copy can run beside the
// first — two agents, or a checkout of another branch — rather than failing on a
// port that is merely taken. tools/dev.js sets VITE_API_TARGET to wherever it
// actually put the API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5273),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:6942',
        changeOrigin: false,
      },
    },
  },
})
