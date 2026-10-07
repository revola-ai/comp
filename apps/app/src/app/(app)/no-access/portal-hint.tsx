import Link from 'next/link';

/** NEXT_PUBLIC_PORTAL_URL as a link target and its host, or undefined when unset or invalid. */
function configuredPortal(): { href: string; host: string } | undefined {
  const href = process.env.NEXT_PUBLIC_PORTAL_URL?.trim().replace(/\/+$/, '');
  if (!href) return undefined;
  try {
    return { href, host: new URL(href).host };
  } catch {
    return undefined;
  }
}

/**
 * Points users without app access at this deployment's employee portal. Never an
 * upstream portal: without NEXT_PUBLIC_PORTAL_URL it gives no link.
 */
export function PortalHint() {
  const portal = configuredPortal();
  if (!portal) {
    return (
      <p>
        Your current role doesn&apos;t have access to the app. If you&apos;re looking for the
        employee portal, ask your organization administrator for its address.
      </p>
    );
  }
  return (
    <p>
      Your current role doesn&apos;t have access to the app. If you&apos;re looking for the employee
      portal, go to{' '}
      <Link href={portal.href} className="text-primary underline">
        {portal.host}
      </Link>
      .
    </p>
  );
}
