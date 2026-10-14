import { describe, expect, it } from 'vitest';
import { assertSafeApiPath, encodePathSegment, InvalidApiPathError } from './api-path';

const BASE = 'http://comp-api.comp.internal:3333';

function resolvedPath(path: string): string {
  return new URL(`${BASE}${path}`).pathname;
}

describe('encodePathSegment', () => {
  it('keeps a traversal id inside its resource path', () => {
    const path = `/v1/vendors/${encodePathSegment('../internal/x')}`;
    expect(resolvedPath(path)).toBe('/v1/vendors/..%2Finternal%2Fx');
  });

  it('encodes query and fragment delimiters so an id cannot add parameters', () => {
    expect(encodePathSegment('vnd_1?organizationId=other#frag')).toBe(
      'vnd_1%3ForganizationId%3Dother%23frag',
    );
  });

  it('passes prefixed ids through unchanged', () => {
    expect(encodePathSegment('vnd_abc123')).toBe('vnd_abc123');
  });

  it.each(['', '.', '..'])('refuses the dot or empty segment %j', (value) => {
    expect(() => encodePathSegment(value)).toThrow(InvalidApiPathError);
  });
});

describe('assertSafeApiPath', () => {
  it('accepts ordinary API paths with a query string', () => {
    expect(() => assertSafeApiPath('/v1/tasks/tsk_1/automations?limit=10&q=../x')).not.toThrow();
  });

  it.each([
    '/v1/vendors/../internal/integration-debug/connections',
    '/v1/vendors/./x',
    '/v1/vendors/%2e%2e/internal/x',
    '/v1/vendors/.%2E/internal/x',
    '/v1/vendors/%2E./internal/x',
    '/v1/vendors/..',
  ])('refuses the dot segment in %s', (path) => {
    expect(() => assertSafeApiPath(path)).toThrow(InvalidApiPathError);
  });

  it('refuses a backslash, which URL parsers treat as a separator', () => {
    expect(() => assertSafeApiPath('/v1/vendors/..\\internal')).toThrow(InvalidApiPathError);
  });

  it('refuses an absolute URL or a path that does not start with a slash', () => {
    expect(() => assertSafeApiPath('https://evil.example/v1/x')).toThrow(InvalidApiPathError);
    expect(() => assertSafeApiPath('//evil.example/v1/x')).toThrow(InvalidApiPathError);
    expect(() => assertSafeApiPath('v1/x')).toThrow(InvalidApiPathError);
  });
});
