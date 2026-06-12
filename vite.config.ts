import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Three.js is intentionally isolated behind idle/interaction-triggered 3D
    // features. Keep warnings for chunks larger than that known vendor split.
    chunkSizeWarningLimit: 600,
  },
})
