import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('@db/server', () => ({ db: { user: { findUnique: mocks.findUnique } } }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('./preferences/client', () => ({
  UnsubscribePreferencesClient: () => <div>preferences form</div>,
}));

import UnsubscribePage from './page';
import UnsubscribePreferencesPage from './preferences/page';

const EMAIL = 'person@revola.ai';

describe('unsubscribe pages without an unsubscribe secret', () => {
  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    vi.stubEnv('AUTH_SECRET', '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.findUnique.mockReset().mockResolvedValue({
      emailNotificationsUnsubscribed: false,
      emailPreferences: null,
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('the unsubscribe page renders without a link instead of failing', async () => {
    render(await UnsubscribePage({ searchParams: Promise.resolve({ email: EMAIL }) }));
    expect(screen.queryByRole('link', { name: 'Unsubscribe' })).toBeNull();
    expect(screen.getByText(/not available on this server/)).toBeTruthy();
  });

  it('the preferences page says it is unavailable instead of failing', async () => {
    render(
      await UnsubscribePreferencesPage({
        searchParams: Promise.resolve({ email: EMAIL, token: 'any-token' }),
      }),
    );
    expect(screen.getByText(/not available on this server/)).toBeTruthy();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe('unsubscribe pages with an unsubscribe secret', () => {
  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai');
    mocks.findUnique.mockReset().mockResolvedValue({
      emailNotificationsUnsubscribed: false,
      emailPreferences: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('the unsubscribe page links to the signed preferences page', async () => {
    render(await UnsubscribePage({ searchParams: Promise.resolve({ email: EMAIL }) }));
    const link = screen.getByRole('link', { name: 'Unsubscribe' });
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/app\.comp\.revola\.ai\/unsubscribe\/preferences\?email=person%40revola\.ai&token=/,
    );
  });

  it('the preferences page rejects a token it did not sign', async () => {
    render(
      await UnsubscribePreferencesPage({
        searchParams: Promise.resolve({ email: EMAIL, token: 'forged' }),
      }),
    );
    expect(screen.getByText('Invalid token')).toBeTruthy();
  });
});
