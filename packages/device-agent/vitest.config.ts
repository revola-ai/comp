import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The build-time constants electron-vite injects (test values, not upstream hosts).
  define: {
    __PORTAL_URL__: JSON.stringify('https://portal.test'),
    __API_URL__: JSON.stringify('https://api.test'),
    __AUTO_UPDATE_URL__: JSON.stringify('https://portal.test/api/device-agent/updates'),
    __AGENT_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
