import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Two entry points, two audiences: index.html is the actual pairing tool
// (served at /app — see relay-server/index.js's routing), landing.html is
// beamlot.com's marketing homepage (served at the bare root "/"). Vite's
// multi-page build keys each output file by its input file's own name, so
// this produces dist/index.html and dist/landing.html.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing.html', import.meta.url)),
      },
    },
  },
});
