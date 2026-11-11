import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The hosted viewer for business users. Like any host app, it proxies /bi-api to the shared backend.
// Production builds are served by the API under /view/ (single-container deployment).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/view/' : '/',
  plugins: [react()],
  server: {
    port: 5176,
    strictPort: true,
    proxy: {
      '/bi-api': {
        target: process.env.BI_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bi-api/, ''),
      },
    },
  },
}));
