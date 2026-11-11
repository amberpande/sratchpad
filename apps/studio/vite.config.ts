import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Studio proxies /bi-api to the shared BI backend, exactly like a host app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/bi-api': {
        target: process.env.BI_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bi-api/, ''),
      },
    },
  },
});
