import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy keeps the browser same-origin, so no API key ever reaches the client.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
});
