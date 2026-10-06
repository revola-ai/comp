import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthErrorCallbackUrl,
  EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE,
  getSignInErrorMessage,
} from './auth-error';

describe('getSignInErrorMessage', () => {
  it('uses the exact copy for the sign-up allowlist rejection', () => {
    expect(EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE).toBe(
      'Sign-ups are limited to revola.ai; ask an admin for an invite',
    );
  });

  it.each([
    // The error code itself (APIError body code).
    'email_domain_not_allowed',
    // better-auth's OAuth callback turns the APIError message into the
    // `error` query parameter with spaces replaced by underscores.
    'email_domain_not_allowed:_example.com',
    'Email_domain_not_allowed_(example.com)',
    'EMAIL_DOMAIN_NOT_ALLOWED',
  ])('maps %j to the allowlist message', (error) => {
    expect(getSignInErrorMessage({ error })).toBe(EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE);
  });

  it('also recognizes the code in error_description', () => {
    expect(
      getSignInErrorMessage({ error: 'FORBIDDEN', errorDescription: 'email_domain_not_allowed' }),
    ).toBe(EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE);
  });

  it('returns undefined for no error', () => {
    expect(getSignInErrorMessage({})).toBeUndefined();
    expect(getSignInErrorMessage({ error: '' })).toBeUndefined();
  });

  it('returns a generic message for other OAuth errors instead of echoing the raw code', () => {
    const message = getSignInErrorMessage({ error: 'unable_to_create_user' });
    expect(message).toBe('Sign-in failed. Please try again.');
  });
});

describe('buildAuthErrorCallbackUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the absolute app sign-in page so OAuth errors land in the app', () => {
    expect(buildAuthErrorCallbackUrl({})).toBe(`${window.location.origin}/auth`);
  });

  it('keeps the invite code and a safe redirect so the user can retry', () => {
    const url = new URL(buildAuthErrorCallbackUrl({ inviteCode: 'inv_1', redirectTo: '/org_1' }));
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('inviteCode')).toBe('inv_1');
    expect(url.searchParams.get('redirectTo')).toBe('/org_1');
  });

  it('drops an unsafe redirect', () => {
    const url = new URL(buildAuthErrorCallbackUrl({ redirectTo: 'https://evil.example.com' }));
    expect(url.searchParams.get('redirectTo')).toBeNull();
  });
});

describe('sign-in components route errors back to the app', () => {
  it.each([
    'components/google-sign-in.tsx',
    'components/github-sign-in.tsx',
    'components/microsoft-sign-in.tsx',
    'components/magic-link.tsx',
  ])('%s passes errorCallbackURL', (file) => {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    expect(source).toMatch(/errorCallbackURL:\s*buildAuthErrorCallbackUrl\(/);
  });
});
