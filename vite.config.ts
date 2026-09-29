import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = __dirname;

/** Emit dist/manifest.json with the version from package.json (single source of truth). */
function manifestPlugin(): Plugin {
  return {
    name: 'emit-manifest',
    generateBundle() {
      const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
      manifest.version = pkg.version;
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [manifestPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // The modulepreload polyfill uses fetch(); extension pages never need it.
    modulePreload: false,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        report: resolve(root, 'report.html'),
        background: resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
