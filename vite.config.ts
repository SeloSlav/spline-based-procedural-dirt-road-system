import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@seedthree': fileURLToPath(new URL('./vendor/seedthree/src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
