declare const __PORTAL_URL__: string;
declare const __API_URL__: string;
declare const __AUTO_UPDATE_URL__: string;
declare const __AGENT_VERSION__: string;

// Injected at build time via electron-vite define (src/build/build-urls.cjs); the build
// fails without them, so there is no upstream default here.

/** Default portal base URL */
export const DEFAULT_PORTAL_URL: string = __PORTAL_URL__;

/** Default API base URL */
export const DEFAULT_API_URL: string = __API_URL__;

/** Update feed for the Linux manual update check */
export const AUTO_UPDATE_URL: string = __AUTO_UPDATE_URL__;

/** How often to run compliance checks (in milliseconds) */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Agent version reported to the server */
export const AGENT_VERSION = typeof __AGENT_VERSION__ !== 'undefined' ? __AGENT_VERSION__ : '1.0.0';

/** API route paths on the NestJS API */
export const API_ROUTES = {
  REGISTER: '/v1/device-agent/register',
  CHECK_IN: '/v1/device-agent/check-in',
  STATUS: '/v1/device-agent/status',
  MY_ORGANIZATIONS: '/v1/device-agent/my-organizations',
  EXCHANGE_CODE: '/v1/device-agent/exchange-code',
} as const;

/** electron-store encryption key identifier */
export const STORE_ENCRYPTION_KEY = 'comp-device-agent-store';
