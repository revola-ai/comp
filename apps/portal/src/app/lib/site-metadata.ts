import type { Metadata } from 'next';

/** Preview image served from this app's public folder. */
const OG_IMAGE = { url: '/web-app-manifest-512x512.png', width: 512, height: 512 };

function parseBaseUrl(baseUrl: string | undefined): URL | undefined {
  const value = baseUrl?.trim();
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Root page metadata. metadataBase, og:url and the preview image use this deployment's
 * public URL and are left out when it is unset, never an upstream host.
 */
export function siteMetadata({
  baseUrl,
  title,
  description,
}: {
  baseUrl: string | undefined;
  title: string;
  description: string;
}): Metadata {
  const base = parseBaseUrl(baseUrl);
  const images = base ? { images: [OG_IMAGE] } : {};
  return {
    ...(base ? { metadataBase: base } : {}),
    title,
    description,
    twitter: { title, description, ...images },
    openGraph: {
      title,
      description,
      ...(base ? { url: base.href.replace(/\/+$/, '') } : {}),
      ...images,
      siteName: 'Comp AI',
      locale: 'en_US',
      type: 'website',
    },
  };
}
