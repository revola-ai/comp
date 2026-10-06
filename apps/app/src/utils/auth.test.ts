import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthForwardHeaders } from './auth-forward-headers';

describe('buildAuthForwardHeaders', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', 'forwarded-test-token');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('forwards the cookie header', () => {
    const result = buildAuthForwardHeaders({ incoming: new Headers({ cookie: 'session=abc123' }) });
    expect(result.cookie).toBe('session=abc123');
  });

  it('forwards the origin header when present', () => {
    const incoming = new Headers({ cookie: 'session=abc', origin: 'https://app.example.com' });
    expect(buildAuthForwardHeaders({ incoming }).origin).toBe('https://app.example.com');
  });

  it('falls back to the public API origin when origin is missing', () => {
    const result = buildAuthForwardHeaders({ incoming: new Headers({ cookie: 'session=abc' }) });
    expect(result.origin).toBe('https://api.comp.revola.ai');
  });

  it('adds the forwarded-IP token and the sanitized client IP, never the internal token', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    const result = buildAuthForwardHeaders({ incoming });
    expect(result['X-Comp-Forwarded-Auth']).toBe('forwarded-test-token');
    expect(result).not.toHaveProperty('X-Internal-Token');
    expect(result['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('drops arbitrary x-* headers, including the edge origin header', () => {
    const incoming = new Headers({
      'x-request-id': '12345',
      'x-comp-origin-auth': 'edge-secret',
      'x-forwarded-for': 'spoofed',
    });
    const result = buildAuthForwardHeaders({ incoming });
    const names = Object.keys(result).map((name) => name.toLowerCase());
    expect(names).not.toContain('x-request-id');
    expect(names).not.toContain('x-comp-origin-auth');
    expect(names).not.toContain('x-forwarded-for');
  });

  it('excludes other headers', () => {
    const incoming = new Headers({
      'content-type': 'application/json',
      authorization: 'Bearer token',
      accept: 'text/html',
    });
    const result = buildAuthForwardHeaders({ incoming });
    expect(result['content-type']).toBeUndefined();
    expect(result.authorization).toBeUndefined();
    expect(result.accept).toBeUndefined();
  });
});
