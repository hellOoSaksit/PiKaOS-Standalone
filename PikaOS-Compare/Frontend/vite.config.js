import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev proxy → the standalone compare backend. In Docker the frontend reaches it over the
// compose network as `backend:8000` (VITE_PROXY_TARGET); on the host it defaults to
// 127.0.0.1:8000 (IPv4 forced — "localhost" can resolve to ::1 on Windows and break the
// Docker port-forward). Timeout is generous (180s) because a deep batch on a slow, WAF-
// throttled site can take 1–2 min.
const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    open: process.env.VITE_OPEN !== 'false',
    watch: process.env.VITE_POLL === 'true' ? { usePolling: true } : undefined,
    proxy: {
      '/api': { target: PROXY_TARGET, changeOrigin: true, timeout: 180000, proxyTimeout: 180000 },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
