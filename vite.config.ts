import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Relative base is required for Electron `loadFile(dist/index.html)`: absolute "/assets/..."
// would resolve to the filesystem root and the app bundle would never load (blank window).
export default defineConfig({
  base: "./",
  plugins: [react()],
  assetsInclude: ['**/*.wasm'],
})
