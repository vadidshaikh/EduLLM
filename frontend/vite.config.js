import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Read .env from the repo root, same file backend/app/config.py and
  // docker-compose use, instead of Vite's default of frontend/.env.
  envDir: '..',
})
