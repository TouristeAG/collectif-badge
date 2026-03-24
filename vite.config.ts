import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Relative base is required for Electron `loadFile(dist/index.html)`: absolute "/assets/..."
// would resolve to the filesystem root and the app bundle would never load (blank window).
export default defineConfig({
  base: "./",
  plugins: [react()],
  assetsInclude: ['**/*.wasm'],
  // Listen on LAN (0.0.0.0) so other devices can reach the dev server; use with firewall rule on `node`.
  server: {
    host: true,
    port: 5173,
  },
})
