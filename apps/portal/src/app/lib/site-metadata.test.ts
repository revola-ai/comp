import { describe, expect, it } from 'vitest';
import { siteMetadata } from './site-metadata';

const copy = { title: 'Comp AI', description: 'Compliance' };

describe('siteMetadata', () => {
  it('uses the configured public URL for metadataBase, og:url and a self-hosted image', () => {
    const metadata = siteMetadata({ ...copy, baseUrl: 'https://app.comp.revola.ai/' });
    expect(String(metadata.metadataBase)).toBe('https://app.comp.revola.ai/');
    expect(metadata.openGraph).toMatchObject({
      url: 'https://app.comp.revola.ai',
      images: [{ url: '/web-app-manifest-512x512.png' }],
    });
    expect(JSON.stringify(metadata)).not.toContain('trycomp.ai');
  });

  it('omits metadataBase, og:url and images when the URL is unset or invalid', () => {
    for (const baseUrl of [undefined, '', 'not a url']) {
      const metadata = siteMetadata({ ...copy, baseUrl });
      expect(metadata.metadataBase).toBeUndefined();
      expect(metadata.openGraph).not.toHaveProperty('url');
      expect(metadata.openGraph).not.toHaveProperty('images');
      expect(metadata.twitter).not.toHaveProperty('images');
      expect(metadata.title).toBe('Comp AI');
      expect(JSON.stringify(metadata)).not.toContain('trycomp.ai');
    }
  });
});
