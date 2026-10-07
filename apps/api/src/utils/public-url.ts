// Public base URLs for links in emails, in-app and Slack notifications. Mirrors
// packages/email/lib/public-url.ts; kept local so the many specs that mock
// @trycompai/email still get the real helper.
//
// There is deliberately no built-in default. Upstream Comp defaulted to its own hosts
// (app/portal.trycomp.ai), so a laptop without the variable sent every recipient, with
// their address and record ids, to upstream's servers. Unset returns undefined and the
// caller leaves the link out; one warning per variable list per process names the
// variables, never a value.

const warnedVariables = new Set<string>();

export function publicBaseUrl(
  variables: readonly string[],
): string | undefined {
  for (const name of variables) {
    const value = process.env[name]?.trim().replace(/\/+$/, '');
    if (value) return value;
  }
  const names = variables.join(' / ');
  if (!warnedVariables.has(names)) {
    warnedVariables.add(names);
    console.warn(
      `[public-url] ${names} is not set: links that need it are left out of emails and notifications. Set it to the public URL of this deployment.`,
    );
  }
  return undefined;
}

/** The app's base URL: NEXT_PUBLIC_APP_URL, else BETTER_AUTH_URL (the existing order). */
export function appBaseUrl(): string | undefined {
  return publicBaseUrl(['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL']);
}

/** The employee portal's base URL. */
export function portalBaseUrl(): string | undefined {
  return publicBaseUrl(['NEXT_PUBLIC_PORTAL_URL']);
}

/** An app link for `path` (starting with `/`), or undefined when the app URL is unset. */
export function appLink({
  path,
  searchParams = {},
  hash,
}: {
  path: string;
  searchParams?: Record<string, string>;
  hash?: string;
}): string | undefined {
  const appUrl = appBaseUrl();
  if (!appUrl) return undefined;
  const url = new URL(`${appUrl}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  if (hash) url.hash = hash;
  return url.toString();
}
