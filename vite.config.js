import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pure static build - no backend, no API proxy. `vite build` emits dist/
// which can be hosted as-is on Cloudflare Pages, GitHub Pages, etc.
// `base` is relative so the build works from any path (e.g. project pages).
export default defineConfig({
  base: './',
  plugins: [react()],
})
