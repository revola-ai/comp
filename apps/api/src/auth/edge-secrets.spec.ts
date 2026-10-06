import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertEdgeSecrets } from './edge-secrets';

const ORIGIN = 'Ab3'.repeat(21) + 'Z';
const FORWARDED = 'f'.repeat(32);

const production = {
  NODE_ENV: 'production',
  AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
  COMP_ORIGIN_AUTH: ORIGIN,
  COMP_FORWARDED_IP_TOKEN: FORWARDED,
};

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('assertEdgeSecrets', () => {
  it('accepts a production self-hosted deployment with both secrets', () => {
    expect(() => assertEdgeSecrets({ env: production })).not.toThrow();
  });

  it('does nothing outside production', () => {
    const env = {
      ...production,
      NODE_ENV: 'development',
      COMP_ORIGIN_AUTH: '',
    };
    expect(() => assertEdgeSecrets({ env })).not.toThrow();
  });

  it('does nothing when AUTH_COOKIE_DOMAIN is unset (not this deployment shape)', () => {
    const env = { NODE_ENV: 'production' };
    expect(() => assertEdgeSecrets({ env })).not.toThrow();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['too short', 'A'.repeat(63)],
    ['too long', 'A'.repeat(65)],
    ['outside [A-Za-z0-9]', `${'A'.repeat(63)}-`],
  ])('refuses COMP_ORIGIN_AUTH %s, naming the variable', (_case, value) => {
    const message = messageOf(() =>
      assertEdgeSecrets({ env: { ...production, COMP_ORIGIN_AUTH: value } }),
    );
    expect(message).toContain('COMP_ORIGIN_AUTH');
    expect(message).toContain('64');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['shorter than 32 characters', 'x'.repeat(31)],
  ])(
    'refuses COMP_FORWARDED_IP_TOKEN %s, naming the variable',
    (_case, value) => {
      const message = messageOf(() =>
        assertEdgeSecrets({
          env: { ...production, COMP_FORWARDED_IP_TOKEN: value },
        }),
      );
      expect(message).toContain('COMP_FORWARDED_IP_TOKEN');
      expect(message).toContain('32');
    },
  );

  it('never includes a secret value in its message', () => {
    const badOrigin = 'secret-origin-value-that-is-wrong';
    const badForwarded = 'short-forwarded';
    const first = messageOf(() =>
      assertEdgeSecrets({
        env: { ...production, COMP_ORIGIN_AUTH: badOrigin },
      }),
    );
    const second = messageOf(() =>
      assertEdgeSecrets({
        env: { ...production, COMP_FORWARDED_IP_TOKEN: badForwarded },
      }),
    );
    expect(first).not.toContain(badOrigin);
    expect(second).not.toContain(badForwarded);
    expect(`${first}${second}`).not.toContain(ORIGIN);
    expect(`${first}${second}`).not.toContain(FORWARDED);
  });

  it('runs at boot next to the cookie-domain validation', () => {
    const source = readFileSync(resolve(__dirname, 'auth.server.ts'), 'utf8');
    const cookie = source.indexOf('getCookieDomain({ env: process.env })');
    const edge = source.indexOf('assertEdgeSecrets({ env: process.env })');
    expect(cookie).toBeGreaterThan(-1);
    expect(edge).toBeGreaterThan(cookie);
  });
});
