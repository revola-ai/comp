import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  magicLink: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/utils/auth-client', () => ({
  authClient: { signIn: { magicLink: mocks.magicLink } },
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { MagicLinkSignIn } from './magic-link';

async function submit(email: string): Promise<void> {
  render(<MagicLinkSignIn />);
  fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
    target: { value: email },
  });
  fireEvent.submit(screen.getByPlaceholderText('name@example.com').closest('form')!);
  await waitFor(() => expect(mocks.magicLink).toHaveBeenCalled());
}

describe('MagicLinkSignIn errors', () => {
  beforeEach(() => {
    mocks.magicLink.mockReset();
    mocks.toastError.mockReset();
  });

  it('shows the allowlist message when the API rejects the email domain (code)', async () => {
    mocks.magicLink.mockResolvedValue({
      error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: 'Forbidden', status: 403 },
    });

    await submit('someone@example.com');

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Sign-ups are limited to revola.ai; ask an admin for an invite',
      ),
    );
  });

  it('shows the allowlist message when only the message carries the code', async () => {
    mocks.magicLink.mockResolvedValue({
      error: { message: 'email_domain_not_allowed: example.com', status: 403 },
    });

    await submit('someone@example.com');

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Sign-ups are limited to revola.ai; ask an admin for an invite',
      ),
    );
  });

  it('keeps the existing text for other send errors', async () => {
    mocks.magicLink.mockResolvedValue({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom', status: 500 },
    });

    await submit('person@revola.ai');

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Error sending email - try again?'),
    );
  });
});
