import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const { deviceAgentUrls } = require('./src/build/build-urls.cjs');

export default defineConfig(({ command }) => {
  // A build fails when PORTAL_URL, API_URL or AUTO_UPDATE_URL is unset (no upstream
  // default); dev uses the local stack.
  const urls = deviceAgentUrls({ command, env: process.env });
  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
      define: {
        __PORTAL_URL__: JSON.stringify(urls.PORTAL_URL),
        __API_URL__: JSON.stringify(urls.API_URL),
        __AUTO_UPDATE_URL__: JSON.stringify(urls.AUTO_UPDATE_URL),
        __AGENT_VERSION__: JSON.stringify(process.env.AGENT_VERSION || pkg.version),
      },
      build: {
        outDir: 'dist/main',
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
          },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'dist/preload',
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/preload/index.ts'),
          },
        },
      },
    },
    renderer: {
      plugins: [react(), tailwindcss()],
      root: resolve(__dirname, 'src/renderer'),
      build: {
        outDir: resolve(__dirname, 'dist/renderer'),
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/renderer/index.html'),
          },
        },
      },
    },
  };
});
