/**
 * App routes that authenticate without a user session.
 *
 * Cloudflare Access protects the whole app host, so a non-browser caller can
 * only reach a route listed here with disposition `access-bypass`. Task 8
 * derives the Access Bypass applications (`ACCESS_BYPASS_PATHS`) from this
 * list, and its edge test expects `rejectsWithoutSecret` from each bypassed
 * path when the request carries no secret. `machine-routes.test.ts` (next to
 * the app's API routes) fails when a route that authenticates without a
 * session is missing here.
 *
 * Dispositions:
 * - `access-bypass`: opened at the edge; the route's own check is the gate.
 * - `unsupported`: documented as unsupported on Revola's hosting; it stays
 *   behind Access (or is disabled in production), so machine callers cannot
 *   reach it.
 * - `removed`: the route was deleted; kept here so the edge config can assert
 *   it is gone.
 */

export type MachineRouteAuth =
  | 'shared-secret-body'
  | 'bearer-secret'
  | 'bearer-passthrough'
  | 'signed-token'
  | 'e2e-test-mode'
  | 'none';

export type MachineRouteDisposition = 'access-bypass' | 'unsupported' | 'removed';

export interface MachineRoute {
  /** URL path on the app host, without a trailing slash. */
  path: string;
  methods: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  auth: MachineRouteAuth;
  disposition: MachineRouteDisposition;
  /** Status the route returns to a request that has no secret (bypassed routes). */
  rejectsWithoutSecret?: number;
  reason: string;
}

export const APP_MACHINE_ROUTES: readonly MachineRoute[] = [
  {
    path: '/api/revalidate/path',
    methods: ['POST'],
    auth: 'shared-secret-body',
    disposition: 'access-bypass',
    rejectsWithoutSecret: 401,
    reason:
      'Called by Trigger.dev tasks (getRevalidateUrl) to bust the app cache. Requires a non-empty REVALIDATION_SECRET compared with timingSafeEqual and an app-relative path.',
  },
  {
    path: '/api/user-frameworks',
    methods: ['GET'],
    auth: 'bearer-secret',
    disposition: 'unsupported',
    reason:
      'Upstream reporting export guarded by SECRET_KEY. Revola has no caller, so it stays behind Access; its own timingSafeEqual check remains.',
  },
  {
    path: '/api/retool/reset-org',
    methods: ['POST'],
    auth: 'bearer-secret',
    disposition: 'unsupported',
    reason:
      'Upstream Retool tooling (RETOOL_COMP_API_SECRET). Returns 404 when NODE_ENV is production and stays behind Access.',
  },
  {
    path: '/api/qa/approve-org',
    methods: ['POST'],
    auth: 'bearer-secret',
    disposition: 'unsupported',
    reason:
      'Upstream QA tooling (QA_SECRET). Returns 404 when NODE_ENV is production and stays behind Access.',
  },
  {
    path: '/api/qa/delete-user',
    methods: ['POST'],
    auth: 'bearer-secret',
    disposition: 'unsupported',
    reason:
      'Upstream QA tooling (QA_SECRET). Returns 404 when NODE_ENV is production and stays behind Access.',
  },
  {
    path: '/api/auth/test-db',
    methods: ['GET'],
    auth: 'e2e-test-mode',
    disposition: 'unsupported',
    reason: 'E2E-only helper gated by E2E_TEST_MODE; returns 404 when NODE_ENV is production.',
  },
  {
    path: '/api/auth/test-grant-access',
    methods: ['POST'],
    auth: 'e2e-test-mode',
    disposition: 'unsupported',
    reason: 'E2E-only helper gated by E2E_TEST_MODE; returns 404 when NODE_ENV is production.',
  },
  {
    path: '/api/auth/test-login',
    methods: ['POST'],
    auth: 'e2e-test-mode',
    disposition: 'unsupported',
    reason: 'E2E-only helper gated by E2E_TEST_MODE; returns 404 when NODE_ENV is production.',
  },
  {
    path: '/api/email-preferences',
    methods: ['PUT'],
    auth: 'signed-token',
    disposition: 'unsupported',
    reason:
      'Called by the /unsubscribe/preferences page with an HMAC token from the email link. Recipients reach it through Access like any app page; email recipients without Access cannot use the link.',
  },
  {
    path: '/api/offboarding-export',
    methods: ['GET'],
    auth: 'bearer-passthrough',
    disposition: 'unsupported',
    reason:
      'Browser download that forwards the session cookie (and any Authorization header) to the API, which authenticates. Machine callers use api.comp.revola.ai directly instead.',
  },
];
