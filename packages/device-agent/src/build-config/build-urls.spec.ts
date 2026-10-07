import { describe, expect, it } from 'vitest';
import { deviceAgentUrls, requiredBuildUrl, requiredBuildUrls } from './build-urls.cjs';

const env = {
  PORTAL_URL: 'https://portal.comp.revola.ai/',
  API_URL: ' https://api.comp.revola.ai ',
  AUTO_UPDATE_URL: 'https://portal.comp.revola.ai/api/device-agent/updates',
};

describe('device agent build URLs', () => {
  it('returns every URL, trimmed and without a trailing slash', () => {
    expect(requiredBuildUrls(env)).toEqual({
      PORTAL_URL: 'https://portal.comp.revola.ai',
      API_URL: 'https://api.comp.revola.ai',
      AUTO_UPDATE_URL: 'https://portal.comp.revola.ai/api/device-agent/updates',
    });
  });

  for (const name of ['PORTAL_URL', 'API_URL', 'AUTO_UPDATE_URL'] as const) {
    it(`fails the build, never defaulting to upstream, when ${name} is unset`, () => {
      expect(() => requiredBuildUrls({ ...env, [name]: undefined })).toThrow(name);
      expect(() => requiredBuildUrls({ ...env, [name]: '  ' })).toThrow(name);
    });
  }

  it('rejects a value that is not an http(s) URL, without echoing it', () => {
    for (const value of ['api.example', 'ftp://files.example']) {
      let message = '';
      try {
        requiredBuildUrl({ name: 'API_URL', env: { API_URL: value } });
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain('API_URL');
      expect(message).not.toContain(value);
    }
  });
});

describe('device agent URLs per electron-vite command', () => {
  it('requires every URL for a build', () => {
    expect(() => deviceAgentUrls({ command: 'build', env: {} })).toThrow('PORTAL_URL');
    expect(deviceAgentUrls({ command: 'build', env }).API_URL).toBe('https://api.comp.revola.ai');
  });

  it('uses the local stack for dev (turbo dev), never an upstream host', () => {
    expect(deviceAgentUrls({ command: 'serve', env: {} })).toEqual({
      PORTAL_URL: 'http://localhost:3002',
      API_URL: 'http://localhost:3333',
      AUTO_UPDATE_URL: 'http://localhost:3002/api/device-agent/updates',
    });
    expect(deviceAgentUrls({ command: 'serve', env }).PORTAL_URL).toBe(
      'https://portal.comp.revola.ai',
    );
  });
});
