// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { scrubSensitiveHeaders } from './src/lib/sentry-scrub';

Sentry.init({
  // No DSN means no Sentry: never upstream Comp's project, which would receive this
  // deployment's errors, request data and session replays.
  dsn: process.env.SENTRY_DSN || undefined,

  // Only report from production. On Vercel, VERCEL_ENV is 'production' | 'preview'
  // | 'development'; on any non-production deployment (or if the var is missing)
  // Sentry stays disabled - a no-op, never an error - to avoid noise and quota burn.
  enabled: Boolean(process.env.SENTRY_DSN) && process.env.VERCEL_ENV === 'production',

  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  enableLogs: true,

  // X-Comp-Origin-Auth (set by Cloudflare for the ALB) and the internal API
  // token are secrets; never ship them to Sentry with request headers.
  beforeSend: scrubSensitiveHeaders,
  beforeSendTransaction: scrubSensitiveHeaders,
});
