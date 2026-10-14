import { identityTracker, verifiedClientIp } from './identity-tracker';
import {
  isTrustedEdgePeer,
  parseTrustedEdgeProxyIps,
} from './verified-headers';

// The address cloudflared reaches the API from on the private Docker network.
const TUNNEL = '172.30.0.10';
const env = { TRUSTED_EDGE_PROXY_IPS: `${TUNNEL}, fd00:30::10` };

describe('parseTrustedEdgeProxyIps', () => {
  it('reads a comma-separated list, trimming each entry', () => {
    expect(
      parseTrustedEdgeProxyIps({ value: ' 172.30.0.10 ,fd00:30::10\n' }),
    ).toEqual({
      addresses: ['172.30.0.10', 'fd00:30::10'],
      invalidEntryCount: 0,
    });
  });

  it('unwraps an IPv4-mapped IPv6 entry', () => {
    expect(
      parseTrustedEdgeProxyIps({ value: '::ffff:172.30.0.10' }).addresses,
    ).toEqual(['172.30.0.10']);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '  '],
  ])('reads %s as no addresses', (_case, value) => {
    expect(parseTrustedEdgeProxyIps({ value })).toEqual({
      addresses: [],
      invalidEntryCount: 0,
    });
  });

  it.each([
    ['a hostname', 'cloudflared', []],
    ['a CIDR range', '172.30.0.0/24', []],
    [
      'an empty entry',
      '172.30.0.10,,172.30.0.11',
      ['172.30.0.10', '172.30.0.11'],
    ],
    ['a trailing comma', '172.30.0.10,', ['172.30.0.10']],
    ['an out-of-range octet', '172.30.0.256,fd00:30::10', ['fd00:30::10']],
  ])(
    'counts %s as invalid and keeps exactly the valid entries',
    (_case, value, addresses) => {
      expect(parseTrustedEdgeProxyIps({ value })).toEqual({
        addresses,
        invalidEntryCount: 1,
      });
    },
  );

  it('counts every invalid entry', () => {
    const parsed = parseTrustedEdgeProxyIps({ value: 'a, b ,172.30.0.10,' });
    expect(parsed).toEqual({
      addresses: ['172.30.0.10'],
      invalidEntryCount: 3,
    });
  });
});

describe('isTrustedEdgePeer', () => {
  it('matches a listed IPv4 peer, also when the socket reports it IPv4-mapped', () => {
    expect(isTrustedEdgePeer({ peer: TUNNEL, env })).toBe(true);
    expect(isTrustedEdgePeer({ peer: `::ffff:${TUNNEL}`, env })).toBe(true);
    expect(isTrustedEdgePeer({ peer: `::FFFF:${TUNNEL}`, env })).toBe(true);
  });

  it('matches a listed IPv6 peer written in another form', () => {
    expect(isTrustedEdgePeer({ peer: 'FD00:30:0:0::10', env })).toBe(true);
  });

  it('refuses any other peer, an unknown peer and an unset or empty list', () => {
    expect(isTrustedEdgePeer({ peer: '172.30.0.11', env })).toBe(false);
    expect(isTrustedEdgePeer({ peer: 'fd00:30::11', env })).toBe(false);
    expect(isTrustedEdgePeer({ peer: undefined, env })).toBe(false);
    expect(isTrustedEdgePeer({ peer: 'not-an-ip', env })).toBe(false);
    expect(isTrustedEdgePeer({ peer: TUNNEL, env: {} })).toBe(false);
    expect(
      isTrustedEdgePeer({ peer: TUNNEL, env: { TRUSTED_EDGE_PROXY_IPS: '' } }),
    ).toBe(false);
  });

  it('trusts the valid entries of a list that also holds an invalid one', () => {
    const mixed = { TRUSTED_EDGE_PROXY_IPS: `cloudflared,${TUNNEL}` };
    expect(isTrustedEdgePeer({ peer: TUNNEL, env: mixed })).toBe(true);
  });

  it('follows a changed list', () => {
    expect(isTrustedEdgePeer({ peer: TUNNEL, env })).toBe(true);
    const moved = { TRUSTED_EDGE_PROXY_IPS: '172.30.0.20' };
    expect(isTrustedEdgePeer({ peer: TUNNEL, env: moved })).toBe(false);
    expect(isTrustedEdgePeer({ peer: '172.30.0.20', env: moved })).toBe(true);
  });
});

describe('client IP behind a Cloudflare Tunnel (TRUSTED_EDGE_PROXY_IPS)', () => {
  const fromTunnel = (visitor: string) => ({
    headers: { 'cf-connecting-ip': visitor },
    ip: `::ffff:${TUNNEL}`,
    socket: { remoteAddress: `::ffff:${TUNNEL}` },
  });

  it('keys a request from the tunnel peer on the visitor', () => {
    expect(identityTracker({ req: fromTunnel('198.51.100.1'), env })).toBe(
      'ip:198.51.100.1',
    );
  });

  it('gives two visitors through the tunnel separate buckets', () => {
    const first = identityTracker({ req: fromTunnel('198.51.100.1'), env });
    const second = identityTracker({ req: fromTunnel('198.51.100.2'), env });
    expect(first).not.toBe(second);
  });

  it('keys a forged CF-Connecting-IP from another peer on that peer', () => {
    const forged = {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
      ip: '172.30.0.99',
      socket: { remoteAddress: '172.30.0.99' },
    };
    expect(identityTracker({ req: forged, env })).toBe('ip:172.30.0.99');
  });

  it('decides on the socket peer, not on req.ip, and keys on that peer', () => {
    const spoofedIp = {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
      ip: TUNNEL,
      socket: { remoteAddress: '172.30.0.99' },
    };
    expect(verifiedClientIp({ req: spoofedIp, env })).toBe('172.30.0.99');
    expect(identityTracker({ req: spoofedIp, env })).toBe('ip:172.30.0.99');
  });

  it('never trusts a comma-joined or duplicated CF-Connecting-IP from the tunnel', () => {
    // Node joins a repeated header into one comma-separated value.
    for (const value of [
      '198.51.100.1, 198.51.100.2',
      '198.51.100.1,198.51.100.1',
    ]) {
      const joined = { headers: { 'cf-connecting-ip': value }, ip: TUNNEL };
      expect(verifiedClientIp({ req: joined, env })).toBe(TUNNEL);
    }
  });

  it('uses req.ip as the peer when the socket address is unknown', () => {
    const noSocket = {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
      ip: TUNNEL,
    };
    expect(verifiedClientIp({ req: noSocket, env })).toBe('198.51.100.1');
  });

  it('falls back to the tunnel peer when CF-Connecting-IP is missing or invalid', () => {
    const missing = { headers: {}, ip: TUNNEL };
    const invalid = { headers: { 'cf-connecting-ip': 'garbage' }, ip: TUNNEL };
    expect(verifiedClientIp({ req: missing, env })).toBe(TUNNEL);
    expect(verifiedClientIp({ req: invalid, env })).toBe(TUNNEL);
  });

  it('keeps the origin-header rule working alongside it', () => {
    const origin = 'o'.repeat(64);
    const viaAlb = {
      headers: {
        'x-comp-origin-auth': origin,
        'cf-connecting-ip': '198.51.100.3',
      },
      ip: '10.0.1.20',
    };
    expect(
      verifiedClientIp({
        req: viaAlb,
        env: { ...env, COMP_ORIGIN_AUTH: origin },
      }),
    ).toBe('198.51.100.3');
  });

  it('still prefers a forwarded-auth X-Forwarded-For from the app or portal', () => {
    const token = 'forwarded-ip-token-value';
    const fromApp = {
      headers: {
        'x-comp-forwarded-auth': token,
        'x-forwarded-for': '203.0.113.9',
      },
      ip: '172.30.0.20',
    };
    expect(
      verifiedClientIp({
        req: fromApp,
        env: { ...env, COMP_FORWARDED_IP_TOKEN: token },
      }),
    ).toBe('203.0.113.9');
  });
});
