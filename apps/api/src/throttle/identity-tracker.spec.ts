import {
  identityTracker,
  type TrackableRequest,
  verifiedClientIp,
} from './identity-tracker';

const ORIGIN = 'o'.repeat(64);
const ORIGIN_PREVIOUS = 'p'.repeat(64);
const FORWARDED = 'forwarded-ip-token-value';
const INTERNAL = 'internal-token-value';

const env = {
  COMP_ORIGIN_AUTH: ORIGIN,
  COMP_ORIGIN_AUTH_PREVIOUS: ORIGIN_PREVIOUS,
  COMP_FORWARDED_IP_TOKEN: FORWARDED,
  INTERNAL_API_TOKEN: INTERNAL,
};

function req(overrides: Partial<TrackableRequest> = {}): TrackableRequest {
  return { headers: {}, ip: '10.0.1.20', ...overrides };
}

describe('identityTracker', () => {
  it('keys a session request on the user ID', () => {
    const tracked = identityTracker({
      req: req({ authType: 'session', userId: 'usr_a' }),
      env,
    });
    expect(tracked).toBe('user:usr_a');
  });

  it('keys an API key request on the API key ID', () => {
    const tracked = identityTracker({
      req: req({ authType: 'api-key', apiKeyId: 'apk_1' }),
      env,
    });
    expect(tracked).toBe('api-key:apk_1');
  });

  it('keys a service-token request on the service name, even when it acts for a user', () => {
    const tracked = identityTracker({
      req: req({
        authType: 'service',
        serviceName: 'Portal App',
        userId: 'usr_a',
      }),
      env,
    });
    expect(tracked).toBe('service:Portal App');
  });

  it('keys an unauthenticated request on the socket address', () => {
    expect(identityTracker({ req: req(), env })).toBe('ip:10.0.1.20');
  });

  it('ignores forged CF-Connecting-IP and X-Forwarded-For without a valid origin header', () => {
    const forged = req({
      headers: {
        'cf-connecting-ip': '198.51.100.1',
        'x-forwarded-for': '198.51.100.2',
      },
    });
    expect(identityTracker({ req: forged, env })).toBe('ip:10.0.1.20');
  });

  it('ignores CF-Connecting-IP when the origin header is wrong', () => {
    const wrong = req({
      headers: {
        'x-comp-origin-auth': 'x'.repeat(64),
        'cf-connecting-ip': '198.51.100.1',
      },
    });
    expect(identityTracker({ req: wrong, env })).toBe('ip:10.0.1.20');
  });

  it('trusts CF-Connecting-IP with the current or the previous origin header value', () => {
    for (const value of [ORIGIN, ORIGIN_PREVIOUS]) {
      const viaCloudflare = req({
        headers: {
          'x-comp-origin-auth': value,
          'cf-connecting-ip': '198.51.100.1',
        },
      });
      expect(identityTracker({ req: viaCloudflare, env })).toBe(
        'ip:198.51.100.1',
      );
    }
  });

  it('never trusts the origin header when COMP_ORIGIN_AUTH is unset or empty', () => {
    const viaCloudflare = req({
      headers: { 'x-comp-origin-auth': '', 'cf-connecting-ip': '198.51.100.1' },
    });
    expect(
      identityTracker({ req: viaCloudflare, env: { COMP_ORIGIN_AUTH: '' } }),
    ).toBe('ip:10.0.1.20');
    expect(identityTracker({ req: viaCloudflare, env: {} })).toBe(
      'ip:10.0.1.20',
    );
  });

  it('ignores an invalid CF-Connecting-IP even with a valid origin header', () => {
    const invalid = req({
      headers: {
        'x-comp-origin-auth': ORIGIN,
        'cf-connecting-ip': 'not-an-ip',
      },
    });
    expect(identityTracker({ req: invalid, env })).toBe('ip:10.0.1.20');
  });

  it('trusts the first X-Forwarded-For entry with a valid forwarded-auth token, ignoring an appended proxy hop', () => {
    const viaServiceConnect = req({
      ip: '127.0.0.1',
      headers: {
        'x-comp-forwarded-auth': FORWARDED,
        'x-forwarded-for': '203.0.113.9, 10.0.3.4',
      },
    });
    expect(identityTracker({ req: viaServiceConnect, env })).toBe(
      'ip:203.0.113.9',
    );
  });

  it('ignores X-Forwarded-For with a wrong forwarded-auth token or none configured', () => {
    const forged = req({
      ip: '127.0.0.1',
      headers: {
        'x-comp-forwarded-auth': 'guess',
        'x-forwarded-for': '203.0.113.9',
      },
    });
    expect(identityTracker({ req: forged, env })).toBe('ip:127.0.0.1');
    const unconfigured = req({
      ip: '127.0.0.1',
      headers: { 'x-comp-forwarded-auth': '', 'x-forwarded-for': '203.0.113.9' },
    });
    expect(identityTracker({ req: unconfigured, env: {} })).toBe(
      'ip:127.0.0.1',
    );
  });

  it('does not trust X-Forwarded-For on the privileged internal token', () => {
    const internalOnly = req({
      ip: '127.0.0.1',
      headers: {
        'x-internal-token': INTERNAL,
        'x-forwarded-for': '203.0.113.9',
      },
    });
    expect(identityTracker({ req: internalOnly, env })).toBe('ip:127.0.0.1');
  });

  it('ignores an invalid first X-Forwarded-For entry even with a valid forwarded-auth token', () => {
    const invalid = req({
      ip: '127.0.0.1',
      headers: {
        'x-comp-forwarded-auth': FORWARDED,
        'x-forwarded-for': 'garbage, 203.0.113.9',
      },
    });
    expect(identityTracker({ req: invalid, env })).toBe('ip:127.0.0.1');
  });

  it('buckets IPv6 clients by /64 so one host cannot rotate through its prefix', () => {
    const a = req({
      headers: {
        'x-comp-origin-auth': ORIGIN,
        'cf-connecting-ip': '2001:db8:1:2::1',
      },
    });
    const b = req({
      headers: {
        'x-comp-origin-auth': ORIGIN,
        'cf-connecting-ip': '2001:DB8:1:2:ffff:ffff:ffff:fffe',
      },
    });
    expect(identityTracker({ req: a, env })).toBe(
      'ip:2001:0db8:0001:0002::/64',
    );
    expect(identityTracker({ req: b, env })).toBe(
      identityTracker({ req: a, env }),
    );
  });

  it('treats an IPv4-mapped IPv6 socket address as IPv4', () => {
    expect(identityTracker({ req: req({ ip: '::ffff:10.0.1.20' }), env })).toBe(
      'ip:10.0.1.20',
    );
  });

  it('falls back to the socket remote address, then to unknown', () => {
    expect(
      identityTracker({
        req: { headers: {}, socket: { remoteAddress: '10.0.9.9' } },
        env,
      }),
    ).toBe('ip:10.0.9.9');
    expect(identityTracker({ req: { headers: {} }, env })).toBe('ip:unknown');
  });

  it('takes the first value when a header arrives as an array', () => {
    const arrays = req({
      headers: {
        'x-comp-origin-auth': [ORIGIN, 'other'],
        'cf-connecting-ip': ['198.51.100.1', '198.51.100.2'],
      },
    });
    expect(identityTracker({ req: arrays, env })).toBe('ip:198.51.100.1');
  });

  it('falls back to the client IP when an authType carries no identity', () => {
    expect(identityTracker({ req: req({ authType: 'session' }), env })).toBe(
      'ip:10.0.1.20',
    );
  });
});

describe('verifiedClientIp', () => {
  it('returns the exact verified address, unbucketed', () => {
    const viaCloudflare = req({
      headers: {
        'x-comp-origin-auth': ORIGIN,
        'cf-connecting-ip': '2001:db8:1:2::1',
      },
    });
    expect(verifiedClientIp({ req: viaCloudflare, env })).toBe(
      '2001:db8:1:2::1',
    );
  });

  it('returns undefined when no address is known', () => {
    expect(verifiedClientIp({ req: { headers: {} }, env })).toBeUndefined();
  });
});
