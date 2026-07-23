import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Three entry points: index.html is the actual pairing tool (served at /app
// — see relay-server/index.js's routing), landing.html is beamlot.com's
// marketing homepage (served at the bare root "/"), and ios.html is the
// Shortcuts setup guide (served at /ios). Vite's multi-page build keys each
// output file by its input file's own name, so this produces
// dist/index.html, dist/landing.html and dist/ios.html.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Shipped client code is minified and mangled, and no source map is
    // emitted alongside it. A source map would hand back the original
    // module layout, names and comments to anyone who opened devtools,
    // which defeats the point of shipping a build at all.
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing.html', import.meta.url)),
        ios: fileURLToPath(new URL('./ios.html', import.meta.url)),
      },
    },
  },
  esbuild: {
    legalComments: 'none',
  },
});
