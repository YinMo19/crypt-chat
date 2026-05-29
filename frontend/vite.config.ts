import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single-binary deployment: assets are served from the embedded root.
// `base: '/'` so deep SPA paths like /r/abc123 still resolve /assets/* correctly
// (relative `./assets/...` from index.html would otherwise be resolved against
// /r/, hit the SPA fallback, and be served as text/html → blank page).
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      crypto: '/src/lib/nodeCryptoStub.ts',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
    },
  },
});
