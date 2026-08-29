import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * The new console — built to static files the API already knows how to serve.
 *
 * WHY THE OUTPUT IS NOT HASHED, which is the decision most likely to look like an oversight.
 *
 * `apps/api/src/http/routes/ui.ts` serves the console from an ALLOWLIST of literal paths, and that
 * is a deliberate security design: "the only paths that resolve are the literals below, so there is
 * no path to traverse, no dotfile to leak". A content hash in the filename changes on every build,
 * so an allowlist could never name it — the choice would be to replace the allowlist with a
 * static-file plugin, which would undo the security decision to buy caching.
 *
 * And it would buy nothing. Every console response already carries `cache-control: no-store`,
 * because the console is a credentialed surface and a shared cache holding it is a shared cache
 * holding somebody's fleet page. Nothing downstream caches these files, so a cache-busting
 * filename has nothing to bust. Fixed names are strictly better here: the allowlist stays literal
 * and the deployment stays a copy.
 *
 * BASE IS `/app/`, and the old console keeps `/`. The two are served side by side until this one is
 * at parity — a cutover is a one-line change to the allowlist, and a rollback is the same line back.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  base: '/app/',
  build: {
    outDir: '../api/public/app',
    // The API image is built from a clean checkout, but a developer's tree is not — and a stale
    // asset from a previous build would be served happily by a path that still matches.
    emptyOutDir: true,
    // Source maps would be a fourth and fifth file to allowlist, and they are not useful on a
    // surface that ships to customers. Debug against the dev server.
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        /**
         * Fonts keep their own names; everything else collapses to `app.<ext>`.
         *
         * Deliberate, because the two are allowlisted differently: there is exactly one stylesheet
         * and it can be named literally, while the font files are a set that will grow when a
         * weight or a face is added. Naming them predictably is what lets the allowlist enumerate
         * them without a hash to chase.
         */
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? '';
          if (/\.(woff2?|ttf|otf)$/i.test(name)) return 'fonts/[name][extname]';
          if (/\.css$/i.test(name)) return 'app.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
  server: {
    // The dev server talks to a real API. Same-origin in the browser, so cookies and the CSP behave
    // the way they will in production rather than only in development.
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/dp': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
});
