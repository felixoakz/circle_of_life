import { defineConfig } from 'vite';

// The Rust server (`species serve`, port 3000) owns /api. In development Vite
// serves the frontend with hot reload and forwards API calls to it, so the
// browser sees a single origin, exactly like production.
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    target: 'es2023',
  },
});
