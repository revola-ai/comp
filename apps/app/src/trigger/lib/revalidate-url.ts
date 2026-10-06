/**
 * The app's cache revalidation endpoint, as called from Trigger.dev tasks.
 *
 * It lives on the app host (`/api/revalidate/path` is an app route), so it is
 * built from NEXT_PUBLIC_APP_URL. BETTER_AUTH_URL is wrong here: once the API
 * runs on its own host it points at the API, where the route does not exist.
 */

export class RevalidateUrlNotConfiguredError extends Error {
  constructor() {
    super('NEXT_PUBLIC_APP_URL is not set; cannot build the app revalidation URL');
    this.name = 'RevalidateUrlNotConfiguredError';
  }
}

export function getRevalidateUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    throw new RevalidateUrlNotConfiguredError();
  }
  return `${appUrl.replace(/\/+$/, '')}/api/revalidate/path`;
}
