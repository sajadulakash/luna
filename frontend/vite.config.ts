// `vitest/config` re-exports Vite's defineConfig with the `test` block typed.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],

  // .env lives at the repo root, alongside the backend and database folders,
  // so one file configures every part of the project. Without this Vite would
  // only look inside frontend/.
  envDir: '..',

  // The browser talks to Vite over HTTPS, and Vite forwards API traffic to
  // plain HTTP FastAPI. This avoids mixed-content errors and keeps Uvicorn's
  // development command free of certificate arguments.
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },

  // Static output. No SSR, no Node process in production — `npm run build`
  // produces a folder that a CDN or Nginx serves as-is.
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
