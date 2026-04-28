import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.VITE_BASE_PATH ? env.VITE_BASE_PATH + "/" : "/",
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: env.VITE_BACKEND_URL || "http://localhost:3030",
          changeOrigin: true,
        },
        "/static": {
          target: env.VITE_BACKEND_URL || "http://localhost:3030",
          changeOrigin: true,
        },
      },
    },
  }
})
