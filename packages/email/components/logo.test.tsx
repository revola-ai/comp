import { render } from '@react-email/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_LOGO_PATH, Logo } from './logo';

describe('email Logo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads the logo from this deployment, never upstream assets', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    const html = await render(<Logo />);
    expect(html).toContain('src="https://app.comp.revola.ai/email/logo.png"');
    expect(html).not.toContain('trycomp.ai');
  });

  it('renders no image without NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await render(<Logo />)).not.toContain('<img');
  });

  it('points at the app public file', () => {
    expect(EMAIL_LOGO_PATH).toBe('/email/logo.png');
  });
});
