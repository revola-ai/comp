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

  describe('Cloudflare Tunnel deployment (TRUSTED_EDGE_PROXY_IPS)', () => {
    const tunnel = {
      NODE_ENV: 'production',
      AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
      TRUSTED_EDGE_PROXY_IPS: '172.30.0.10',
      COMP_FORWARDED_IP_TOKEN: FORWARDED,
    };

    it.each([
      ['one IPv4 address', '172.30.0.10'],
      ['a list with IPv6 and spaces', '172.30.0.10, fd00:30::10 '],
    ])('accepts it with %s instead of COMP_ORIGIN_AUTH', (_case, value) => {
      const env = { ...tunnel, TRUSTED_EDGE_PROXY_IPS: value };
      expect(() => assertEdgeSecrets({ env })).not.toThrow();
    });

    it('accepts both designs configured at once', () => {
      const env = { ...production, TRUSTED_EDGE_PROXY_IPS: '172.30.0.10' };
      expect(() => assertEdgeSecrets({ env })).not.toThrow();
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['whitespace', '  '],
    ])(
      'refuses neither design (list %s), naming both variables',
      (_case, value) => {
        const message = messageOf(() =>
          assertEdgeSecrets({
            env: { ...tunnel, TRUSTED_EDGE_PROXY_IPS: value },
          }),
        );
        expect(message).toContain('COMP_ORIGIN_AUTH');
        expect(message).toContain('TRUSTED_EDGE_PROXY_IPS');
      },
    );

    it.each([
      ['a hostname', 'cloudflared'],
      ['a CIDR range', '172.30.0.0/24'],
      ['an empty entry', '172.30.0.10,,172.30.0.11'],
      ['an invalid address', '172.30.0.256'],
    ])(
      'refuses a list with %s, even next to a valid COMP_ORIGIN_AUTH',
      (_case, value) => {
        for (const env of [tunnel, production]) {
          const message = messageOf(() =>
            assertEdgeSecrets({
              env: { ...env, TRUSTED_EDGE_PROXY_IPS: value },
            }),
          );
          expect(message).toContain('TRUSTED_EDGE_PROXY_IPS');
          expect(message).not.toContain(value);
        }
      },
    );

    it('refuses a malformed COMP_ORIGIN_AUTH even with a valid list', () => {
      const message = messageOf(() =>
        assertEdgeSecrets({
          env: { ...tunnel, COMP_ORIGIN_AUTH: 'short-origin-value' },
        }),
      );
      expect(message).toContain('COMP_ORIGIN_AUTH');
      expect(message).not.toContain('short-origin-value');
    });

    it('still requires COMP_FORWARDED_IP_TOKEN', () => {
      const message = messageOf(() =>
        assertEdgeSecrets({
          env: { ...tunnel, COMP_FORWARDED_IP_TOKEN: undefined },
        }),
      );
      expect(message).toContain('COMP_FORWARDED_IP_TOKEN');
    });
  });

  describe('service tokens (validated in memory, so they must not be guessable)', () => {
    const SHORT = 's'.repeat(20);
    const STRONG = 't'.repeat(32);

    it.each([
      'SERVICE_TOKEN_TRIGGER',
      'SERVICE_TOKEN_PORTAL',
      'SERVICE_TOKEN_TRUST',
      'SERVICE_TOKEN_TRIGGER_PREVIOUS',
      'SERVICE_TOKEN_PORTAL_PREVIOUS',
      'SERVICE_TOKEN_TRUST_PREVIOUS',
    ])('refuses a 20-character %s, naming the variable', (name) => {
      const message = messageOf(() =>
        assertEdgeSecrets({ env: { ...production, [name]: SHORT } }),
      );
      expect(message).toContain(name);
      expect(message).toContain('32');
      expect(message).not.toContain(SHORT);
    });

    it('refuses a whitespace-only token', () => {
      const message = messageOf(() =>
        assertEdgeSecrets({
          env: { ...production, SERVICE_TOKEN_TRIGGER: ' '.repeat(40) },
        }),
      );
      expect(message).toContain('SERVICE_TOKEN_TRIGGER');
    });

    it('accepts tokens of at least 32 characters and unset ones', () => {
      const env = {
        ...production,
        SERVICE_TOKEN_TRIGGER: STRONG,
        SERVICE_TOKEN_TRIGGER_PREVIOUS: `${STRONG}-previous`,
        SERVICE_TOKEN_PORTAL: '',
      };
      expect(() => assertEdgeSecrets({ env })).not.toThrow();
    });

    it('leaves other deployments alone', () => {
      const short = { SERVICE_TOKEN_TRIGGER: SHORT };
      expect(() =>
        assertEdgeSecrets({
          env: { ...production, ...short, NODE_ENV: 'development' },
        }),
      ).not.toThrow();
      expect(() =>
        assertEdgeSecrets({ env: { NODE_ENV: 'production', ...short } }),
      ).not.toThrow();
    });
  });

  it('runs at boot next to the cookie-domain validation', () => {
    const source = readFileSync(resolve(__dirname, 'auth.server.ts'), 'utf8');
    const cookie = source.indexOf('getCookieDomain({ env: process.env })');
    const edge = source.indexOf('assertEdgeSecrets({ env: process.env })');
    expect(cookie).toBeGreaterThan(-1);
    expect(edge).toBeGreaterThan(cookie);
  });
});
