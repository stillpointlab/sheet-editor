import { defineConfig } from 'vite';

export default defineConfig({
  root: 'dev',
  build: {
    outDir: '../dist-dev',
    emptyOutDir: true,
  },
  server: {
    port: 5182,
    strictPort: true,
  },
});
