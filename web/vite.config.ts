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
    // 127.0.0.1 rather than Vite's default `localhost`, which on Windows resolves
    // to ::1 and so binds an address the API's session cookie can never reach.
    //
    // The proxy below keeps /api same-origin, but sign-in does not go through it:
    // Spotify redirects the browser to the *API's* own callback, which is where
    // the cookie is set. A cookie has no port — but it does have a host, and
    // `localhost` and `127.0.0.1` are two of them. Landing back on the other one
    // means the cookie is never sent and the app still offers Connect Spotify.
    //
    // Not `host: true`: that binds every interface, and the loopback checks
    // guarding /api/config/client-id read MAPPIFY_HOST rather than the peer
    // address, so anyone on the network could repoint this at their own Spotify
    // app.
    host: '127.0.0.1',
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
