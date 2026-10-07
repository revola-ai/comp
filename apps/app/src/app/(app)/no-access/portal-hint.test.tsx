import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalHint } from './portal-hint';

describe('PortalHint', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("links to this deployment's employee portal", () => {
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', 'https://portal.comp.revola.ai/');
    render(<PortalHint />);
    const link = screen.getByRole('link', { name: 'portal.comp.revola.ai' });
    expect(link.getAttribute('href')).toBe('https://portal.comp.revola.ai');
  });

  it('never links to an upstream portal when NEXT_PUBLIC_PORTAL_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', undefined);
    const { container } = render(<PortalHint />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).not.toContain('trycomp.ai');
    expect(container.textContent).toContain('employee portal');
  });
});
