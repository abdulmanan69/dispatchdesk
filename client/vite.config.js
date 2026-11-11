import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vendor code in its own long-lived chunks, so a deploy that changes app code does not make returning users
// download React, the router, TanStack Query or MapLibre again. recharts, d3-geo, driver.js and the map data stay
// in the lazy chunks of the pages that use them.
const vendor = (pkgs) => new RegExp(`node_modules[\\\\/](?:${pkgs.join('|')})[\\\\/]`);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // MapLibre alone is ~1 MB minified; it loads only with the fleet map.
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        // Icon groups get short file names (their automatic names list every page that uses them).
        chunkFileNames: (chunk) => (chunk.name.startsWith('icons') ? 'assets/icons-[hash].js' : 'assets/[name]-[hash].js'),
        codeSplitting: {
          groups: [
            { name: 'react', test: vendor(['react', 'react-dom', 'scheduler', 'react-router', 'cookie', 'set-cookie-parser']), priority: 30 },
            { name: 'query', test: vendor(['@tanstack']), priority: 25 },
            { name: 'maplibre', test: vendor(['maplibre-gl']), priority: 20 },
            // Icons are grouped by the pages that share them (not one big eager chunk), and groups under 6 KB merge
            // into a neighbor, instead of ~90 separate sub-1 KB files.
            { name: 'icons', test: vendor(['lucide-react']), priority: 15, entriesAware: true, entriesAwareMergeThreshold: 6000 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
});
