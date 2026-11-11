import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The host proxies /bi-api to the shared BI backend, so the SDK needs no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/bi-api': {
        target: process.env.BI_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bi-api/, ''),
      },
    },
  },
});
