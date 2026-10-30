import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Same backend as the Angular app's proxy.conf.json — the API secrets
    // only exist on the deployed project, so /api always goes to production.
    proxy: {
      '/api': {
        target: 'https://silpo-voice-shopping-agent.vercel.app',
        secure: true,
        changeOrigin: true,
      },
    },
  },
})
