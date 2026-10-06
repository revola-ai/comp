# Comp AI on AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Revola fork of Comp AI as a hosted web app at `https://app.comp.revola.ai`, so colleagues use it in a browser and nobody runs the servers or Trigger workers to use it.

**Architecture:** Three ARM64 Fargate services (`comp-api`, `comp-app`, `comp-portal`) on `revola-cluster` behind `revola-production-alb`, reached through Cloudflare (proxied DNS, an origin header the ALB requires, Access in front of `app` and `portal`). The app and portal reach the API inside the VPC through ECS Service Connect. Infrastructure is Terraform; images are built by AWS CodeBuild; one command (`deploy/aws/release.sh`) releases a commit (migrations, ECS, Trigger.dev `prod`). Production data and keys are today's shared Supabase project, Upstash database and secrets.

**Tech Stack:** NestJS API, Next.js 16 app and portal, Bun 1.3.4 + Turbo, Prisma 7.6, Docker buildx bake, Terraform (`aws`, `cloudflare` providers), AWS ECS Fargate / ECR / CodeBuild / ELBv2 / ACM / Secrets Manager / Cloud Map / CloudWatch / SNS / S3 / DynamoDB, Cloudflare (DNS, Rulesets, Access, Advanced Certificate Manager), Trigger.dev v4.4.3.

**Spec:** `docs/specs/2026-10-05-aws-hosting-design.md`
**Review history:** `docs/plans/2026-10-05-aws-hosting-review-history.md` (not executable; this plan wins on any disagreement).

## Decisions

| ID | Decision | Answer | Tasks changed |
|---|---|---|---|
| D1/UC1 | Where Cloudflare Access applies | Access on `app.comp.revola.ai` and `portal.comp.revola.ai` only; `api.comp.revola.ai` is proxied with the origin header and protected by its own auth (session, API key, service token), the sign-up allowlist, verified-identity throttling and API-key revocation on offboarding | 1, 2b, 8, 10 |
| D7 (revises UC2) | Production state | Production reuses today's shared Supabase project (database and Storage), Upstash database and keys; no new project, no data copy, no re-encryption; laptops keep using the same state. Accepted ceiling: laptops can migrate, write and decrypt production data. Upgrade trigger: before the SOC 2 audit window or the first real evidence, local development moves to its own project (P1 issue, Task 10) | 4, 6, 7b, 10 |
| UC3 | Fork ownership | Decision record, primary maintainer Kyle plus a backup Kyle names, weekly upstream merge plus within 2 working days of any upstream security commit, upstream PRs for generic fixes | 10 |
| UC4 | Provisioning | Terraform under `deploy/aws/terraform/`; scripts only for releases, migrations and secret sync | 5, 6, 7, 8 |
| CEO-2 | Internal API route | ECS Service Connect: app and portal call `http://comp-api.comp.internal:3333` server-side | 2b, 7 |
| CEO-TLS | Edge certificate | Cloudflare Advanced Certificate Manager certificate for `*.comp.revola.ai` (about $10 per month, Kyle confirms or reuses an existing subscription) | 8, 10 |
| CEO-E7 | Build on merge | CodeBuild builds every push to `revola/self-host`; deploys stay manual | 5 |
| DX-HATCH | Incident hatch | `--skip-smoke --reason "<text>"` allowed at any time with a loud warning; reason stored in the release record | 7b |
| ENG-8 | Offboarding and API keys | Removing a member revokes API keys they created; keys of an inactive creator are rejected unless marked organization-owned | 1 |
| Deferred | CodeBuild as release runner | Not now; releases run from an operator machine | none |

## Global Constraints

- Branch `revola/aws-hosting` off `revola/self-host`; PR into `revola/self-host` on `revola-ai/comp`. Conventional commits with lowercase subjects; never `--no-verify`, never `git stash`.
- Repo rules (`CLAUDE.md`): bun only; no `as any`, no `@ts-ignore`; named parameters for functions with 2+ arguments; files at most 300 lines; zod at runtime boundaries; TDD for code (failing test, run, implement, run, commit). Shell functions under test are called as plain statements, never inside `&&` lists (errexit is off there).
- No em dashes in any file. Long Markdown: one sentence per line.
- AWS: account `455986776194`, region `us-east-2`, cluster `revola-cluster`, ALB `revola-production-alb` (DNS `revola-production-alb-1399285125.us-east-2.elb.amazonaws.com`, SG `sg-0eb10c6d5c5fd239b`, VPC `vpc-06b67bec700b38a10`, existing 443 listener rules at priorities 5 to 62, default action forwards to another service), subnets `subnet-08095a4ada58a9eef`, `subnet-0284c89a912e76d71`, `subnet-0d4308baa95e7f157`, `assignPublicIp` `DISABLED`. These shared resources are Terraform data sources only, never managed.
- Comp task execution role: `comp-task-execution-role` (Terraform), allowed only `ecr:GetAuthorizationToken` on `*`, ECR pull on the three Comp repositories, CloudWatch Logs on `/ecs/comp-*`, `secretsmanager:GetSecretValue` on `comp/production/*`.
- Hosts: `app.comp.revola.ai`, `api.comp.revola.ai`, `portal.comp.revola.ai`; cookie domain `.comp.revola.ai`; certificate `*.comp.revola.ai` in ACM `us-east-2` (ALB) and in Cloudflare (edge).
- Fargate `ARM64`/`LINUX`; sizes: api 1024 CPU / 2048 MB, app 1024 / 2048, portal 512 / 1024; desired count 1 each.
- ECR repositories `comp-api`, `comp-app`, `comp-portal`; image tag = 12-character git SHA (`git rev-parse --short=12`); bake sets `provenance=false`, `sbom=false`; buildx `docker-container` builder with `--cache-from=type=registry,ref=<repo>:cache` and `--cache-to=type=registry,ref=<repo>:cache,mode=max,image-manifest=true,oci-mediatypes=true`; never `type=inline`.
- Secrets: Secrets Manager `comp/production/config` (JSON) for application secrets and `comp/production/origin-auth` for `COMP_ORIGIN_AUTH` and `COMP_ORIGIN_AUTH_PREVIOUS`; task definitions reference `<full-arn>:KEY::<version-id>` (pinned versions); non-secret per-service values are task-definition `environment` entries from `overridesForService`, never stored in a secret. Never print, log or commit a secret value; never read `.env*` files (scripts may source them in a child process and pass values on without echoing).
- Images: runtime and build stages `node:22-slim` (Node >= 22.12), Bun copied from `oven/bun:1.3.4`; the public Supabase root certificate is committed at `deploy/aws/certs/supabase-ca.crt` and every image carries it at `/app/certs/supabase-ca.crt` with `DATABASE_SSL_CA=/app/certs/supabase-ca.crt`.
- ALB listener rules: priority 1 `api`, 2 `app`, 3 `portal` (host AND header `X-Comp-Origin-Auth` matching one of up to two values), 4 = host `*.comp.revola.ai` only, fixed response `403` `text/plain` `comp-alb: origin header missing or invalid`. `COMP_ORIGIN_AUTH` is 64 characters from `[A-Za-z0-9]`.
- Every `terraform apply` and every step that changes AWS, Cloudflare, Google, Supabase or Trigger.dev runs only after Kyle reviews the plan output or the printed command and confirms.
- Releases go through `deploy/aws/release.sh`, which renders task definitions from the release commit (no clone-and-swap) and records each release in S3 bucket `comp-release-records-455986776194`.

## Review Focus

1. A wrong `AUTH_COOKIE_DOMAIN` (no leading dot, too broad, or not covering the API, app and portal hosts) must stop the API at boot with a message naming the variable and an example, never silently drop sessions (Task 1).
2. A request that reaches the ALB with `Host: app.comp.revola.ai` and no or a wrong origin header must get the `403` `comp-alb:` body, never the app or another Revola service (Tasks 7, 8).
3. An app-host machine route opened by an Access Bypass must still reject a request without its secret with the app's own `4xx` (per-path expectation in the test fixture), never be an open door (Task 8).
4. A production container without `DATABASE_SSL_CA` must exit at boot with `ca_file_missing`; a runtime TLS or connection failure must make `GET /v1/health/ready` (API) and `GET /api/health` (app) answer `503` with a `tls_<CODE>`, Prisma-code, `timeout` or `unknown` reason, never connect without verification (Tasks 2, 3, 4).
5. Because laptops share production state (D7), a local `prisma migrate dev`, `migrate reset`, `db push` or `db:seed` against the production host must be refused unless `COMP_I_AM_TOUCHING_PROD=1` is set (Task 4).

---

### Task 0: Deploy workspace, shared config and plan gates

**Files:**
- Create: `deploy/aws/package.json` (workspace `@trycompai/deploy-aws`; dependencies `zod`, `@trigger.dev/sdk` pinned to the repo's 4.4.3; scripts `typecheck`, `lint` (eslint plus `shellcheck -S warning` on every `*.sh`), `test` (bun tests plus `deploy/aws/tests/*.test.sh`)), `deploy/aws/tsconfig.json`, `deploy/aws/config.ts`, `deploy/aws/config.test.ts`, `deploy/aws/write-config-env.ts` (writes `deploy/aws/config.env` for shell scripts), `deploy/aws/preflight.ts`, `deploy/aws/preflight.test.ts`, `deploy/aws/tests/plan-lint.test.ts`
- Modify: root `package.json` workspaces (add `deploy/aws`), `.github/workflows/check-types.yml` (call the existing `typecheck:ci` script; it calls a missing `type-check:ci` today), `.gitignore` (`deploy/aws/config.env`, `deploy/aws/terraform/.terraform`)

**Interfaces:**
- Produces: `config` (zod-validated, frozen): `accountId`, `region`, `clusterName`, `albName`, `albDnsName`, `albSecurityGroupId`, `vpcId`, `subnetIds`, `hosts` (`api`, `app`, `portal`), `cookieDomain`, `productionDbRef` (the Supabase project ref, entered by Kyle in Step 4), `productionPoolerHost`, `triggerCliVersion` (read from `apps/*/package.json`, must agree), `releaseBucket`, `lockTable` (`comp-release-lock`), `terraformStateBucket` (`comp-terraform-state-455986776194`); `runPreflight({ needs }: { needs: readonly ('aws' | 'cloudflare' | 'trigger' | 'docker')[] }): Promise<void>`.

- [ ] **Step 1: Write the failing tests.** `config.test.ts`: the values equal Global Constraints; a mismatched Trigger CLI version between `apps/api` and `apps/app` throws. `preflight.test.ts` (stubbed `aws`, `bun`, `git`, `curl` on `PATH`): a wrong account prints `wrong AWS account <X>, expected 455986776194; set AWS_PROFILE=...` and exits non-zero before any mutating call; a wrong region, a missing tool, a missing `CLOUDFLARE_API_TOKEN` (when `needs` includes `cloudflare`), a missing Trigger login, and a subnet without a NAT route in its route table each fail with a named message. `plan-lint.test.ts`: reads `docs/plans/2026-10-05-aws-hosting.md` and fails if it contains any superseded identifier from the list in its source (the ENG-1 list in the review history: the old overrides constant, the shared execution role, the in-repo release path, the 7-character short-tag command, and the old readiness wording).
- [ ] **Step 2: Run** `cd deploy/aws && bun test`; confirm FAIL.
- [ ] **Step 3: Implement** the workspace, `config.ts`, `write-config-env.ts` and `preflight.ts`; fix `check-types.yml`.
- [ ] **Step 4: Kyle enters** `productionDbRef` and `productionPoolerHost` (from the Supabase dashboard; not secret). Run `bun run typecheck`, `bun run lint` and `bun run test` from the repo root; they include `deploy/aws` and PASS.
- [ ] **Step 5: Commit** `feat(deploy): deploy workspace, shared config, preflight and plan gates`.

### Task 1: API authentication for a self-hosted domain

**Files:**
- Create: `apps/api/src/auth/cookie-domain.ts`, `apps/api/src/auth/cookie-domain.spec.ts`, `apps/api/src/auth/email-domain-allowlist.ts`, `apps/api/src/auth/email-domain-allowlist.spec.ts`
- Modify: `apps/api/src/auth/auth.server.ts` (import `getCookieDomain`, add one `databaseHooks.user.create.before` entry), `apps/api/src/auth/origin-policy.ts` and its spec, the API-key validation path and `apps/api/src/auth/acting-user.service.ts` with their specs, the service-token guard and its spec, `docs/self-hosting-local.md` (one line each for `AUTH_COOKIE_DOMAIN` and `AUTH_ALLOWED_EMAIL_DOMAINS`)

**Interfaces:**
- Produces: `getCookieDomain({ env }: { env: Partial<NodeJS.ProcessEnv> }): string | undefined`; `parseAllowedDomains({ env })`, `isEmailAllowed({ email, allowedDomains, hasPendingInvitation })`, `createEmailDomainAllowlistHook({ env, db })` (returns the `user.create.before` handler, which throws `APIError('FORBIDDEN')` with code `email_domain_not_allowed`, used by Task 2b's message).

- [ ] **Step 1: Write the failing tests** (jest).
  - Cookie domain: `.comp.revola.ai` with `BASE_URL=https://api.comp.revola.ai`, `NEXT_PUBLIC_APP_URL=https://app.comp.revola.ai`, `NEXT_PUBLIC_PORTAL_URL=https://portal.comp.revola.ai` returns `.comp.revola.ai`; the variable wins over the built-in staging rule (`.trycomp.ai` with `https://api.staging.trycomp.ai` returns `.trycomp.ai`); `comp.revola.ai` throws `/must start with a dot/`; `.api.comp.revola.ai` throws because the app host is not covered; `.revola.ai` throws (fewer than three labels) unless `AUTH_COOKIE_DOMAIN_ALLOW_BROAD=1`; set while `BASE_URL` is missing or unparseable throws; coverage is `host === d.slice(1) || host.endsWith(d)`; every error text includes an example value and names `AUTH_COOKIE_DOMAIN`; unset keeps today's `trycomp.ai`, staging and `undefined` behaviour.
  - Origin policy: with `SELF_HOSTED=true`, trusted origins come only from `AUTH_TRUSTED_ORIGINS` plus the `AUTH_COOKIE_DOMAIN` hosts, `https://x.trycomp.ai` and `*.trust.inc` are rejected, and there is no `.trycomp.ai` cookie fallback; without `SELF_HOSTED` behaviour is unchanged.
  - Allowlist: listed domain allowed; other domain rejected; `Person@Revola.AI` normalized and allowed; `x.revola.ai` rejected unless listed; email with a pending, unexpired invitation allowed (lookup case-insensitive); expired or accepted invitation rejected; unset or empty allows everyone; malformed email rejected.
  - Offboarding: a removed member's API keys are revoked; a key whose creator is inactive gets `401` on a read and a mutation unless the key is marked organization-owned; the owner fallback in `acting-user.service.ts` applies only to legacy keys with no recorded creator.
  - Service tokens: the guard accepts `SERVICE_TOKEN_<NAME>` and, when set, `SERVICE_TOKEN_<NAME>_PREVIOUS`; anything else is rejected.
- [ ] **Step 2: Run** `cd apps/api && npx jest src/auth`; confirm the new cases FAIL.
- [ ] **Step 3: Implement** the modules and the minimal wiring in `auth.server.ts`, `origin-policy.ts`, key validation and the service-token guard.
- [ ] **Step 4: Run** `npx jest src/auth` and `npx turbo run typecheck --filter=@trycompai/api`; all PASS, no new type errors in touched files.
- [ ] **Step 5: Commit** `feat(api): self-hosted cookie domain, origin policy, sign-up allowlist and key revocation on offboarding`.

### Task 2: Health, readiness and throttling

**Files:**
- Create: `apps/portal/src/app/api/health/route.ts` and `route.test.ts`, `apps/app/src/app/api/health/live/route.ts` and `route.test.ts`, `apps/api/src/health/readiness.ts` and its spec, `apps/api/src/throttle/identity-tracker.ts` and its spec
- Modify: `apps/api/src/health/health.controller.ts` and spec (`@Public()` `GET /v1/health/ready`), `apps/app/src/app/api/health/route.ts` and test (readiness reasons), the API throttler registration and `adminAuthRateLimiter`, `apps/api/src/main.ts` (no hop-count `trust proxy`), the API's Sentry and request-log setup (scrub `X-Comp-Origin-Auth`)

**Interfaces:**
- Consumes: Task 4's `buildPgAdapterOptions` error types for reason mapping (Task 4 lands first if run in parallel; the reason mapper only needs the error shapes).
- Produces: `GET /api/health` (portal) and `GET /api/health/live` (app): `200 {status:'ok'}` with no database, auth or `next/headers` import; `GET /v1/health/ready` (API) and `GET /api/health` (app): `SELECT 1` with a 2-second timeout, `200 {status:'ok'}` or `503 {status:'unavailable', reason}` where `reason` is `tls_<CODE>` (walking `err.cause` for a Node TLS code), else the Prisma code, else `timeout`, else `unknown`, with no connection details; `identityTracker({ req })`: authenticated requests key on session user ID or API key ID, unauthenticated requests key on `CF-Connecting-IP` only when the request carries a valid origin header, else `req.ip`.

- [ ] **Step 1: Write the failing tests.** Health routes: status, body and the forbidden-import source scan. Readiness: ok, timeout, a Prisma-coded error, and a TLS error whose fixture is captured once from a real failed Supabase connection map to `200`, `503 timeout`, `503 P<code>`, `503 tls_<CODE>`. Throttling (real middleware chain, interceptor after `HybridAuthGuard`, global IP limiter kept for unauthenticated routes only): forged `CF-Connecting-IP` and `X-Forwarded-For` without the origin header are ignored; two users arriving through Service Connect with `INTERNAL_API_TOKEN` get separate buckets; a service-token caller has its own bucket; `adminAuthRateLimiter` uses the same tracker. `X-Comp-Origin-Auth` never appears in the API's Sentry events or request logs.
- [ ] **Step 2: Run** `cd apps/api && npx jest src/health src/throttle`, `cd apps/app && npx vitest run src/app/api/health`, `cd apps/portal && npx vitest run src/app/api/health`; confirm FAIL.
- [ ] **Step 3: Implement** the routes, the readiness mapper and the tracker; remove `trust proxy` hop arithmetic.
- [ ] **Step 4: Run** the same commands; all PASS.
- [ ] **Step 5: Commit** `feat: readiness and liveness routes and verified-identity throttling`.

### Task 2b: Server-side API base URL, revalidation, schedules and app machine routes

**Files:**
- Create: `apps/app/src/lib/server-api-base-url.ts` and test, `apps/portal/src/app/lib/server-api-base-url.ts` and test, `apps/app/src/lib/server-only-env.guard.test.ts`, `apps/portal/src/app/lib/server-only-env.guard.test.ts`, `apps/app/src/trigger/lib/revalidate-url.ts` and test, `apps/{api,app}/src/trigger/lib/schedule-guard.ts` and tests, `apps/app/src/app/api/machine-routes.test.ts`
- Modify: server-only API callers in app (`lib/api-server.ts`, `lib/server-api-client.ts`, `utils/auth.ts`, `app/api/training/certificate/route.ts`, `app/api/offboarding-export/route.ts`, `people/[employeeId]/actions/download-training-certificate.ts`, `people/[employeeId]/actions/download-hipaa-certificate.ts`, `policies/[policyId]/editor/tools/policy-tools.ts`) and portal (`app/lib/auth.ts`, `app/api/auth/get-session/route.ts`, `app/api/device-agent/proxy.ts`, `app/api/portal/complete-training/route.ts`, `documents/[formType]/page.tsx`, `documents/[formType]/submissions/page.tsx`); the six revalidation call sites and the two `onboard-organization*.ts` path arguments; `apps/app/src/lib/unsubscribe.ts`; `apps/app/src/app/api/revalidate/path/route.ts`; every `schedules.task` file; the app sign-in error display; portal header forwarding; Sentry and request-log scrubbing in app and portal; `docs/self-hosting-local.md`

**Interfaces:**
- Produces: `getServerApiBaseUrl(): string` (`BACKEND_API_URL`, else `NEXT_PUBLIC_API_URL`, else `http://localhost:3333`; empty counts as unset); `getRevalidateUrl(): string` (`${NEXT_PUBLIC_APP_URL}/api/revalidate/path`, trailing slash normalized, throws a named error when unset); `shouldRunScheduledTask({ environmentType, env }): boolean` (true only for `PRODUCTION`, or when `COMP_RUN_SCHEDULES_IN_DEV=true`); `APP_MACHINE_ROUTES` (each app `route.ts` that authenticates by bearer or shared secret, with its disposition: Access bypass with its own check, documented unsupported, or removed), consumed by Task 8.

- [ ] **Step 1: Write the failing tests.** Base URL helper: set, unset, empty. Guard test per app: files outside `src/trigger` that are server-only (`'use server'`, a `route.ts`, `import 'server-only'`, an import of `next/headers`, `proxy.ts`, `middleware.ts`, or a `page.tsx`/`layout.tsx` without `'use client'`) must not read `NEXT_PUBLIC_API_URL` directly; browser modules (`auth-client.ts`, `api-client.ts`, `evidence-download.ts`, `hooks/use-training-completions.ts`, `auth/device-callback/page.tsx`) keep it. Revalidation: set returns `https://app.comp.revola.ai/api/revalidate/path`, unset throws, a scan fails if any trigger file joins `BETTER_AUTH_URL` with `/api/revalidate`; the route rejects an empty secret, compares with `timingSafeEqual`, and accepts only relative paths. Unsubscribe base URL is `NEXT_PUBLIC_APP_URL`. Schedule guard: truth table, and a scan failing when a `schedules.task` file does not call it. Machine routes: every app route authenticating without a session is listed in `APP_MACHINE_ROUTES` with a disposition. Sign-in: an `email_domain_not_allowed` error (including through the OAuth callback) shows "Sign-ups are limited to revola.ai; ask an admin for an invite". Portal forwards only a sanitized client IP, not arbitrary `x-*` headers. `X-Comp-Origin-Auth` never appears in Sentry events or request logs in app and portal.
- [ ] **Step 2: Run** `cd apps/app && npx vitest run` and `cd apps/portal && npx vitest run` (plus `cd apps/api && npx jest src/trigger` for the API schedule guard); confirm FAIL.
- [ ] **Step 3: Implement** the helpers and replace each listed call site; `docs/self-hosting-local.md` states that local `trigger dev` skips schedules by default and that local runs write production data (D7).
- [ ] **Step 4: Run** the same suites; all PASS.
- [ ] **Step 5: Commit** `fix(app): server-side api base url, revalidation host, dev schedule guard and machine route checks`.

### Task 3: Fork-owned container images

**Files:**
- Create: `deploy/aws/Dockerfile` (targets `api`, `app`, `portal`), `deploy/aws/docker-bake.hcl`, `deploy/aws/assemble-api-context.sh`, `deploy/aws/certs/supabase-ca.crt` (copied from `packages/db/certs/prod-ca-2021.crt`; commit body records its SHA-256), `deploy/aws/tests/images.smoke.sh`, `deploy/aws/tests/build-context-drift.test.ts`, `deploy/aws/public-env.ts` (bake args and `INTENTIONALLY_UNSET` public keys)
- Modify: `.dockerignore` (create if absent): `**/.env*`, `**/node_modules`, `**/dist`, `**/.next`, `**/.turbo`, `.git`, `.local`, `.worktrees`, `.claude`, `packages/db/certs/*`. Upstream's root `Dockerfile` and `apps/api/Dockerfile` stay untouched.

**Interfaces:**
- Consumes: Task 2 health routes, Task 4 adapter options (images run them).
- Produces: bake targets `api`, `app`, `portal` (`linux/arm64`), variables `TAG`, `REGISTRY`, `APP_URL`, `API_URL`, `PORTAL_URL` (defaults are the three https hosts); images listen on 3333 (api) and 3000 (app, portal, with `HOSTNAME=0.0.0.0`). Images carry one environment's `NEXT_PUBLIC_*` values and are not promotable across environments.

- [ ] **Step 1: Write the tests.** Drift test: the `@trycompai/*` packages `apps/api` depends on transitively equal `assemble-api-context.sh`'s list. `images.smoke.sh` builds the three targets with `--load` and asserts:
  - `node -v` starts with `v22.` in every image, and the CA file exists;
  - the portal answers `/api/health` with `200`;
  - the app answers `/api/health/live` with `200`, and a static chunk referenced by `/` and one `/_next/image` request return `200`;
  - the built app output contains `api.comp.revola.ai` and not `localhost:3333`;
  - every `NEXT_PUBLIC_*` read in code is a bake arg or listed in `INTENTIONALLY_UNSET`;
  - `SKIP_ENV_VALIDATION` is absent from runtime env;
  - the api, started with `apps/api/.env` sourced in a child process and passed by name only (`-e NAME` per `^[A-Z][A-Z0-9_]*=` line) plus `NODE_ENV=production`, answers `/v1/health/ready` with `200` within 60 s;
  - an api container with `NODE_ENV=production` and `DATABASE_SSL_CA=`, `PRISMA_ALLOW_INSECURE_TLS=` explicitly emptied exits non-zero with `ca_file_missing` in stderr;
  - each image is under a size threshold recorded in the script after the first green run.
  The script never prints env values.
- [ ] **Step 2: Run** `bash deploy/aws/tests/images.smoke.sh` and `cd deploy/aws && bun test tests/build-context-drift.test.ts`; confirm FAIL.
- [ ] **Step 3: Write the Dockerfile and bake file.**
  - `deps`: `node:22-slim` with Bun copied from `oven/bun:1.3.4`, `node -v` asserted, then `bun install --frozen-lockfile`.
  - `libs`: turbo builds every dependency of api, app and portal (`--ui=stream`).
  - `api-build`: `cd apps/api && bun run build`, then `assemble-api-context.sh` writes `/out`. The script copies `dist` (either layout) and only the schema assets from `apps/api/prisma` (never `client.js`). It takes production-only `node_modules` and replaces each `@trycompai/*` symlink with that package's built output plus `package.json` (`utils` copies `src`). It fails if `src/main.js` is missing.
  - `app-build` and `portal-build`: the `db:generate` schema path, then `bun run build:docker` with `NEXT_OUTPUT_STANDALONE=true`, `SKIP_ENV_VALIDATION=1` for this stage only, `NODE_OPTIONS=--max-old-space-size=6144`, and `NEXT_PUBLIC_*` from bake args. The standalone tree gets `.next/static` and `public/` copied in.
  - Runtime stages (`node:22-slim`): copy the CA and set `DATABASE_SSL_CA`; run as a non-root user; `CMD` `node src/main.js` (api) or `node apps/<name>/server.js` (app, portal).
  - Bake file: `provenance=false`, `sbom=false`.
- [ ] **Step 4: Run** both; all PASS. Record image sizes in the commit body.
- [ ] **Step 5: Commit** `feat(deploy): arm64 images for api, app and portal`.

### Task 4: Database connection policy, production guard and job runtime

**Files:**
- Create: `packages/db/src/pg-adapter-options.ts` and test, `packages/db/scripts/vendor-db-for-trigger.ts` and test, `packages/db/scripts/prod-guard.ts` and test, `apps/{api,app}/src/trigger/lib/app-storage-client.ts` and tests
- Modify: `packages/db/src/client.ts`, `apps/{api,app,portal}/prisma/client.ts`, `packages/db/package.json` (test script includes `scripts`; `migrate dev`, `migrate reset`, `db push` and `db:seed` scripts run through the guard), the Prisma scripts in `apps/{api,app,portal}/package.json` (through the guard), `apps/{api,app}/customPrismaExtension.ts`, `apps/{api,app}/caBundleExtension.ts` (committed Supabase CA, no `rds-global-bundle.pem` requirement), `apps/app/trigger.config.ts` (register `caBundleExtension` if absent), Trigger tasks that touch application storage

**Interfaces:**
- Produces:
  - `buildPgAdapterOptions({ databaseUrl, env })`: TLS from `resolveSslConfig`; `max` from `DATABASE_POOL_MAX` (zod integer 1 to 50, default unchanged when unset). When `NODE_ENV=production` and the host is not local, `DATABASE_SSL_CA` is required (or an explicit `PRISMA_ALLOW_INSECURE_TLS=1`); otherwise it throws an error whose code is `ca_file_missing`. It logs the resolved TLS mode once at startup, without the URL. Used by every Prisma client.
  - `vendorWorkspaceDb({ repoRoot, outputPath })`: copies `packages/db/dist` and `package.json` into `<outputPath>/node_modules/@trycompai/db`. It throws `run bun run build in packages/db` when `dist/index.js` is missing, and it adds `packages/db`'s runtime `dependencies` (exact versions) to the layer.
  - `assertNotProduction({ databaseUrl, env })`: throws unless the host differs from `config.productionPoolerHost` or `COMP_I_AM_TOUCHING_PROD=1` is set.
  - `createAppStorageClient({ env })`: S3 client honoring `APP_AWS_ENDPOINT` with path-style access. Customer-cloud scanning clients stay separate.

- [ ] **Step 1: Write the failing tests.**
  - Adapter options: pool set, unset and invalid values; the production rule with and without the CA and with the explicit opt-out.
  - Vendoring: the output tree and dependency list are correct; a missing `dist` gives the named error.
  - Guard: the production host is refused; the opt-in is allowed; another host is allowed.
  - Storage client: the endpoint and path-style settings are applied.
- [ ] **Step 2: Run** `cd packages/db && bun test src scripts` and the app/api trigger storage tests; confirm FAIL.
- [ ] **Step 3: Implement** and wire every Prisma client, both Trigger extensions (drop `@trycompai/db` from the npm layer) and the storage call sites.
- [ ] **Step 4: Run** the suites (PASS), then `bunx trigger.dev@4.4.3 deploy --dry-run` in `apps/api` and `apps/app`: each output contains `node_modules/@trycompai/db/dist/index.js` exporting `resolveSslConfig` and `buildPgAdapterOptions`, and `certs/supabase-ca.crt`; no `@trycompai/db` npm dependency.
- [ ] **Step 5: Commit** `feat(db): one connection policy, production command guard and trigger runtime packaging`.

### Task 5: Terraform foundation, ECR and CodeBuild

**Files:**
- Create: `deploy/aws/terraform/bootstrap/` (state bucket `comp-terraform-state-455986776194`: versioned, encrypted, public access blocked; DynamoDB lock table `comp-release-lock`), `deploy/aws/terraform/main.tf`, `providers.tf` (pinned `aws` and `cloudflare`, S3 backend with native lockfile), `data.tf` (cluster, ALB, 443 listener, VPC, subnets as data sources), `ecr.tf`, `codebuild.tf`, `outputs.tf`, `deploy/aws/buildspec.yml`, `deploy/aws/terraform-apply.sh` (takes the release lock, runs `plan`, waits for Kyle's confirmation, applies), `deploy/aws/tests/terraform-plan.test.ts` and fixtures, `deploy/aws/README.md` ("Bring-up" and "Builds")

**Interfaces:**
- Produces: ECR repositories with scan-on-push; lifecycle with a higher-priority rule protecting `cache`, keeping 30 SHA tags (record-based retention is a pruning script in Task 7b). CodeBuild project `comp-images`: `ARM_CONTAINER`, `BUILD_GENERAL1_LARGE`, privileged, a build timeout, source `revola-ai/comp` through CodeConnections `revola-ai-github`, and a webhook building every push to `revola/self-host` (CEO-E7). Its role has ECR push on the three repos, Logs `/codebuild/comp-images`, and `codeconnections:UseConnection`, `GetConnectionToken`, `GetConnection`. `buildspec.yml` bakes with `TAG` = the first 12 characters of `CODEBUILD_RESOLVED_SOURCE_VERSION`, the registry cache flags, `NODE_OPTIONS` raised for build stages, and app and portal built one after another if parallel builds exceed memory. Terraform outputs used by scripts are named in `config.ts`; origin-header values and outputs are `sensitive`, and the state bucket policy limits readers to the Terraform role and Kyle.

- [ ] **Step 1: Write the failing test** `terraform-plan.test.ts` against `terraform show -json` fixtures:
  - fails if any `aws_lb`, `aws_lb_listener`, `aws_ecs_cluster`, `aws_vpc` or `aws_subnet` is managed;
  - fails if a listener rule priority is outside 1 to 4;
  - fails if an Access application covers `api.comp.revola.ai`;
  - asserts the cache-protection lifecycle rule and the CodeBuild role actions.
- [ ] **Step 2: Run** `cd deploy/aws && bun test tests/terraform-plan.test.ts`; confirm FAIL.
- [ ] **Step 3: Write** the bootstrap and foundation Terraform and `buildspec.yml`. `terraform fmt -check`, `terraform validate` and `tflint` run in `deploy/aws`'s `lint`.
- [ ] **Step 4: Kyle creates** the CodeConnections connection `revola-ai-github` (AWS console) and confirms `AVAILABLE`. Then, each after Kyle reviews the plan: apply bootstrap, then the foundation through `terraform-apply.sh`. Then `aws codebuild start-build --project-name comp-images --source-version revola/aws-hosting`; expect `SUCCEEDED` and three 12-character tags whose manifests include `linux/arm64`. The tests PASS against a fixture regenerated from the real plan.
- [ ] **Step 5: Commit** `feat(deploy): terraform foundation, ecr and codebuild for comp images`.

### Task 6: Production secrets, overrides and data readiness

**Files:**
- Create: `deploy/aws/secret-keys.ts`, `deploy/aws/secret-keys.test.ts`, `deploy/aws/trigger-env-keys.ts` and test, `deploy/aws/env-coverage.test.ts`, `deploy/aws/sync-secrets.ts` and test, `deploy/aws/terraform/secrets.tf` (secret containers; `comp/production/origin-auth` value from `random_password`, 64 characters, alphanumeric, `sensitive`)

**Interfaces:**
- Produces:
  - `SECRET_KEYS`: each mapped to exactly one source env file. Values are today's shared values (D7): database (pooler URL plus `DATABASE_MIGRATION_URL` on the session pooler 5432 or direct), storage, Redis, `BETTER_AUTH_SECRET`/`SECRET_KEY`, `ENCRYPTION_KEY`, Google OAuth, Resend (including `RESEND_FROM_*`), Gemini, OpenAI, `INTERNAL_API_TOKEN`, `SERVICE_TOKEN_TRIGGER`, `SERVICE_TOKEN_PORTAL`, `REVALIDATION_SECRET`, `TRIGGER_SECRET_KEY_API`, `TRIGGER_SECRET_KEY_APP`, `TRIGGER_PROJECT_REF_API`, `TRIGGER_PROJECT_REF_APP`, plus every scanned key Kyle decides to set.
  - `INTENTIONALLY_UNSET`: key to one-line reason.
  - `secretsForService({ service }): { name: string; key: string }[]`.
  - `overridesForService({ service }): Record<string, string>`, rendered as `environment`:
    - every service: `NODE_ENV=production`, `SELF_HOSTED=true`, `NEXT_PUBLIC_SELF_HOSTED=true`, `DATABASE_SSL_CA`, `DATABASE_POOL_MAX` (from the budget in Step 4);
    - api only: `AUTH_COOKIE_DOMAIN`, `AUTH_TRUSTED_ORIGINS`, `AUTH_ALLOWED_EMAIL_DOMAINS=revola.ai`, `NEXT_PUBLIC_PORTAL_URL=https://portal.comp.revola.ai`, `NEXT_PUBLIC_BETTER_AUTH_URL=https://api.comp.revola.ai`;
    - app and portal only: `BACKEND_API_URL=http://comp-api.comp.internal:3333`.
  - `triggerOverrides({ project })`: public URL keys (`BASE_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `API_BASE_URL`, `API_URL`, `NEXT_PUBLIC_API_URL` = `https://api.comp.revola.ai`; `NEXT_PUBLIC_APP_URL` = `https://app.comp.revola.ai`; `NEXT_PUBLIC_PORTAL_URL` = `https://portal.comp.revola.ai`) and a per-run `DATABASE_POOL_MAX`.
  - `triggerEnvKeys({ project })`: the matching service's secret and override keys, plus every `process.env.X` read under `apps/<project>/src/trigger`, its `trigger.config.ts` and its extensions; minus `TRIGGER_*` names and `BACKEND_API_URL`.

- [ ] **Step 1: Write the failing tests.**
  - Key mapping: every `secretsForService` key exists in `SECRET_KEYS`; no duplicate names per service; `TRIGGER_SECRET_KEY` maps to `TRIGGER_SECRET_KEY_API` (api) and `TRIGGER_SECRET_KEY_APP` (app); portal has no Trigger entries; each override key's service set is exactly as listed; no override value contains `localhost`; `BACKEND_API_URL` is never in `triggerEnvKeys`.
  - Env coverage, per ECS service: every `process.env.X` read in `apps/<service>/src` (outside `src/trigger`), `packages/email`, `packages/auth` and `packages/db` is in that service's secrets, overrides or `INTENTIONALLY_UNSET`.
  - Trigger env: every scanned Trigger read is in `SECRET_KEYS`, `triggerOverrides` or `INTENTIONALLY_UNSET`.
  - Sync: refuses any `COMP_ORIGIN_AUTH*` key; refuses to change the `ENCRYPTION_KEY` hash; fails on a key that disagrees between source files (naming the key and files, never values) and on a key missing from its file (`KEY not found in <file>; add it or list it in INTENTIONALLY_UNSET`); prints a name-only diff (added, removed, changed by hash) and requires confirmation to remove a key.
- [ ] **Step 2: Run** `cd deploy/aws && bun test secret-keys trigger-env-keys env-coverage sync-secrets`; confirm FAIL.
- [ ] **Step 3: Implement** the modules and `secrets.tf`. In `docs/self-hosting-aws.md`, classify each secret as rotatable with overlap (`SERVICE_TOKEN_*` via `_PREVIOUS`, origin header), rotatable by restart, or never rotated without a procedure (`ENCRYPTION_KEY`, blocked until a versioned keyring and re-encryption procedure exist).
- [ ] **Step 4: Kyle confirms the Supabase setup.** Kyle moves the project to Pro (or higher), decides point-in-time recovery, and records the regions of Supabase and Upstash. The implementer records the connection budget in `docs/self-hosting-aws.md` and sets `DATABASE_POOL_MAX` per service so the total stays under the session pooler's limit. The budget counts each ECS service's pool, Trigger `prod` concurrency per project times the per-run pool, and two local stacks; Kyle sets the Trigger concurrency limits in the dashboard. Kyle decides each scanned key as set or `INTENTIONALLY_UNSET` (`FIRECRAWL_API_KEY`, `NOVU_API_KEY`, `BACKGROUND_CHECK_API_KEY`, `BROWSER_AUTOMATION_*`, `APP_AWS_*_BUCKET`, `VERCEL_*`, `TRUST_APP_URL`, `MCP_RESOURCE_URL` and any others found), and creates Trigger prod keys for `comp-api` and `comp-app`. Then: apply `secrets.tf` after review; run `bun deploy/aws/sync-secrets.ts --dry-run`, then for real after confirmation. Tests PASS.
- [ ] **Step 5: Commit** `feat(deploy): production secrets, per-service overrides and env coverage`.

### Task 7: ECS services, Service Connect, load balancer rules and alarms

**Files:**
- Create: `deploy/aws/render-task-definition.ts` and test, `deploy/aws/listener-rules.ts` and test, `deploy/aws/terraform/iam.tf`, `logs.tf`, `network.tf` (`comp-tasks-sg`: 3000 and 3333 from the ALB SG, 3333 from itself), `alb.tf` (target groups, rules 1 to 4, ACM certificate and listener attachment), `service-connect.tf` (Cloud Map HTTP namespace `comp.internal`), `ecs.tf`, `alarms.tf`, `records.tf` (bucket `comp-release-records-455986776194`, versioned)

**Interfaces:**
- Consumes: Task 6 key and override functions, Task 5 images.
- Produces:
  - `renderTaskDefinition({ service, imageRef, secretArns, secretVersions })` returns `RegisterTaskDefinitionInput`:
    - family `comp-<service>`, `ARM64`/`LINUX`, `FARGATE`, `awsvpc`, the sizes from Global Constraints, execution role `comp-task-execution-role`;
    - port 3333 or 3000, with the api port named `api` (`appProtocol: 'http'`);
    - logs to `/ecs/comp-<service>`;
    - secrets as `{ name, valueFrom: '<full-arn>:<key>::<version-id>' }` (full ARN with its 6-character suffix), overrides only under `environment`;
    - the api mapping includes both origin-auth keys.
  - `buildListenerRules({ targetGroups, originHeaderValues })` returns rules 1 to 4 per Global Constraints.
  - Terraform services:
    - Service Connect: api is the server `comp-api` with alias `comp-api.comp.internal:3333`; app and portal are clients.
    - Deployment circuit breaker with rollback; health-check grace period on the api; `ignore_changes` on `task_definition` and `desired_count`.
    - Target groups: `comp-api-tg` (`/v1/health`), `comp-app-tg` (`/api/health/live`), `comp-portal-tg` (`/api/health`); type `ip`, healthy threshold 2, interval 30 s, deregistration delay 30 s.
  - Alarms to SNS `comp-alerts` (email from Kyle, confirmed):
    - per service: `HealthyHostCount` minimum `< 1` for 2 of 2 minutes (missing data breaching), `UnHealthyHostCount > 0` for 5 of 5, `HTTPCode_Target_5XX_Count > 10` over 5 minutes;
    - plus Service Connect `HTTPCode_Target_5XX_Count` for `comp-api`.

- [ ] **Step 1: Write the failing tests.**
  - Task definitions: every field above, for each service.
  - Listener rules: exactly four, with these priorities, both header values in each host rule, a header alphabet and length check, and the `403` body.
  - Terraform plan fixture: services ignore `task_definition`; no rule priority outside 1 to 4; no resource uses the shared account-wide execution role.
- [ ] **Step 2: Run** `cd deploy/aws && bun test render-task-definition listener-rules tests/terraform-plan.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** the modules and Terraform. ECS services are created after Task 7b's `release.sh bootstrap` has registered the first task definitions (the order is listed in Task 7b Step 4).
- [ ] **Step 4: Run** the tests (PASS) and `terraform validate`; the apply happens in Task 7b Step 4.
- [ ] **Step 5: Commit** `feat(deploy): ecs services, service connect, alb rules and alarms in terraform`.

### Task 7b: Release kit

**Files:**
- Create: `deploy/aws/release.sh`, `deploy/aws/release-lock.ts` and test, `deploy/aws/release-journal.ts` and test, `deploy/aws/release-record.ts` and test, `deploy/aws/migrate.ts`, `deploy/aws/migration-guard.ts` and test, `deploy/aws/image-arch.ts` and test (fixtures: image index with attestations, single manifest), `deploy/aws/smoke.sh`, `deploy/aws/trigger-deploy.sh`, `deploy/aws/trigger-env.ts`, `deploy/aws/prune-images.ts`, `deploy/aws/tests/release.test.sh`, `deploy/aws/tests/deploy.test.sh`

**Interfaces:**
- Consumes:
  - Task 7's `renderTaskDefinition` and outputs;
  - Task 6's key functions;
  - `config.ts`;
  - the DynamoDB table from Task 5 (conditional writes; acquire if absent or expired; renew and release only when owner and generation match; a fencing generation checked before every mutation). `terraform-apply.sh` takes the same lock.
- Produces `release.sh` subcommands:
  - `preflight`, `status`, `logs <service>` (exact `aws logs tail` commands);
  - `bootstrap --image-tag <sha>`;
  - `release <ref> [--service api|app|portal]... [--project api|app] [--skip-smoke --reason <text>] [--smoke=liveness] [--skip-migration-check]`;
  - `rollback [<release-id>]`, `restart [--service X]`, `migrate --sha <sha>`, `break-lock` (confirmed and logged).

- [ ] **Step 1: Write the failing tests.**
  - Lock: concurrent acquire; takeover after expiry with a stale owner resuming; the 30-minute TTL renewed while waiting; a lost lease aborts before the next mutation; the held-lock message shows owner, expiry and `release.sh break-lock`.
  - Journal: written to S3 before the first mutation (attempt ID, previous state) and checkpointed after each registered revision and deployment step. A kill between the ECS and Trigger steps resumes or rolls back from the journal.
  - Migration guard, `classifyMigrations({ inTree, applied })`:
    - pending migrations fail the release, printing the exact `release.sh migrate --sha <sha>` command;
    - extra applied migrations warn and continue (a colleague's branch on the shared database, D7);
    - started-but-unfinished rows fail, as does a checksum mismatch against that SHA's `migration.sql`;
    - `migration_lock.toml` is ignored.
  - Migration target: `migrate.ts` and the guard use `DATABASE_MIGRATION_URL` from `comp/production/config` (never local files, never printed); a transaction-pooler `:6543` URL is refused, and a pooler user or database whose ref differs from `config.productionDbRef` is refused.
  - Architecture check: requires an `arm64` entry and ignores attestation entries; a wrong platform prints the found and expected platforms and `rebuild with release.sh`.
  - Release flow (`release.test.sh` with stubbed `aws`, `git`, `bun`, `curl`):
    - success; a missing tag; a failed guard (exits before any `update-service`); a failed smoke (exits non-zero and prints the rollback release ID); resume;
    - `release` renders task definitions from the release commit with pinned secret versions and the image digest, so a newly required env var is deployed;
    - the order is api, then app, then portal;
    - a `services-stable` timeout prints the last 10 service events and each stopped task's `stoppedReason`;
    - `--skip-smoke` without `--reason` is refused;
    - the origin header value never appears in stdout or stderr.
  - Rollback: deploys the previous record's task definition ARNs and redeploys Trigger at the previous SHA with its env snapshot; refuses with an explanation for a record marked forward-fix-only or a pinned secret version that no longer exists.
  - Records: the record writer produces every field (image digests, task definition ARNs, Trigger deployment versions, secret version IDs, latest applied migration, stage timings and hands-on prompts, what changed) and refuses to write without digests; a partial record is written when a stage fails.
  - Ownership boundary: `release.sh` never passes Service Connect, network or load-balancer settings to ECS (Terraform owns them); a release that also needs a Terraform change is documented as apply first, then release.
  - Trigger: `trigger-deploy.sh` refuses unless its temporary worktree under `.worktrees/release-<sha>` is at `<sha>`; it builds `packages/db`, `packages/email` and `packages/integration-platform` there, prints the project ref and environment, runs `trigger-env.ts` (failing on a missing value), then deploys `--env prod`.
- [ ] **Step 2: Run** `cd deploy/aws && bun test && bash tests/release.test.sh && bash tests/deploy.test.sh`; confirm FAIL.
- [ ] **Step 3: Implement** the kit.
  - Smoke: uses `curl --connect-to <host>:443:<alb-dns>:443` with the origin header, read into a variable that is never printed. It checks `/v1/health/ready` (api) and `/api/health` (app, portal); `--smoke=liveness` uses `/v1/health` and `/api/health/live`. One pass/fail line per service.
  - Other pieces: `restart` re-renders with the latest secret versions, deploys, smokes and re-uploads Trigger env. `prune-images.ts` keeps every image referenced by the last 10 records.
  - Upstream's `.github/workflows/trigger-*-deploy-*.yml` are disabled on the fork, and the apps' `deploy:trigger-prod` scripts call `trigger-deploy.sh`.
- [ ] **Step 4: Bring up the infrastructure**, each step after Kyle confirms:
  1. `release.sh bootstrap --image-tag <sha from Task 5>` registers the first task definitions.
  2. `terraform-apply.sh` creates the Task 7 resources and the services from those ARNs.
  3. `release.sh release <sha> --skip-smoke --reason "listener has no comp certificate yet"`.
  Verify:
  - all three services are `RUNNING` with healthy targets;
  - `curl -sk -H 'Host: app.comp.revola.ai' https://<alb-dns>/` returns the `403` `comp-alb:` body;
  - with the header it reaches the app;
  - one server-rendered page that fetches API data raises the Service Connect `RequestCount` for `comp-api`;
  - `aws cloudwatch describe-alarms --alarm-name-prefix comp-` lists 10 alarms in `OK`;
  - `aws cloudwatch set-alarm-state` on one alarm delivers an email;
  - the api log shows the verified TLS mode.
- [ ] **Step 5: Commit** `feat(deploy): release kit with lock, journal, migration guard, smoke, records and rollback`.

### Task 8: Cloudflare edge, Access and origin header

**Files:**
- Create: `deploy/aws/terraform/cloudflare-dns.tf` (ACM validation record unproxied; proxied CNAMEs for the three hosts to the ALB), `cloudflare-rules.tf` (request-header transform rule for exactly the three hosts setting `X-Comp-Origin-Auth`; a configuration rule setting SSL Full (strict) for the three hosts only, if the zone is not already Full (strict)), `cloudflare-access.tf` (Access for `app.comp.revola.ai` and `portal.comp.revola.ai`, Google identity provider, allow `@revola.ai` plus the portal acknowledgment population Kyle confirms, email-OTP policy for named externals if any; Bypass applications for the app-host entries of `APP_MACHINE_ROUTES` that keep their own check, at minimum `/api/revalidate/path`), `cloudflare-cert.tf` (Advanced Certificate Manager edge certificate for `*.comp.revola.ai`), `edge-probes.tf` (external HTTPS checks through Cloudflare on `https://api.comp.revola.ai/v1/health` and the app's Access redirect, alarming to `comp-alerts`), `deploy/aws/access-bypass.ts` and `deploy/aws/cloudflare.test.ts` (with a per-path expected-response fixture), `deploy/aws/rotate-origin-header.sh`

**Interfaces:**
- Consumes: Task 2b's `APP_MACHINE_ROUTES`; the origin header values (two-value variable); Task 7's ACM certificate and ALB DNS name.
- Produces: `ACCESS_BYPASS_PATHS` (app host only, derived from `APP_MACHINE_ROUTES`); origin header rotation as three separately reviewed applies:
  1. the ALB accepts the old and new values;
  2. Cloudflare switches to the new value, and an edge probe through Cloudflare to `https://api.comp.revola.ai/v1/health` returns the API's own response;
  3. the old value is retired, and the API restarts so its secret mapping updates.

- [ ] **Step 1: Write the failing tests.**
  - Access: covers `app` and `portal` and never `api.comp.revola.ai`; no bypass covers `/` or `/api/auth/*`.
  - Bypass coverage scan: strip comments, then find every `fetch(...)`, `axios.<method>(...)` or allowlisted helper (`getApiBaseUrl`, `sendEmailViaApi`, `apiResponse` and any others found, listed in the test) in `apps/{api,app}/src/trigger` whose base resolves to `NEXT_PUBLIC_APP_URL`. Each must be covered by an app-host bypass. A base expression `process.env.X || '<literal>'` counts as `process.env.X`, and an unresolvable base fails the test.
  - Rules: the transform rule targets exactly the three hosts; the configuration rule never changes the zone-wide setting.
  - Rotation: plan fixtures assert the three-phase order, and recovery from an interrupted phase is documented.
- [ ] **Step 2: Run** `cd deploy/aws && bun test cloudflare`; confirm FAIL.
- [ ] **Step 3: Implement.** Kyle supplies `CLOUDFLARE_API_TOKEN` (Zone DNS edit, Transform Rules edit, Configuration Rules edit, SSL and Certificates edit, Zone Settings read, Access edit for `revola.ai`) and `CLOUDFLARE_ACCOUNT_ID`, and confirms the edge certificate cost.
- [ ] **Step 4: Apply in order, each after Kyle reviews the plan:**
  1. the validation record, then wait for ACM `ISSUED` (the listener attachment from Task 7 completes);
  2. the edge certificate and the SSL rule;
  3. the transform rule;
  4. the Access applications;
  5. the proxied CNAMEs last.
  Verify:
  - `curl -sv https://app.comp.revola.ai` shows a certificate whose SAN includes `*.comp.revola.ai` and a redirect to `*.cloudflareaccess.com`;
  - each bypass path returns its fixture `4xx` from the app itself, not a Cloudflare page or the ALB body;
  - a real Trigger job hitting `/api/revalidate/path` is not challenged by bot protection;
  - `release.sh release <same sha>` passes the full smoke;
  - the edge probes are healthy.
  Then the cross-host acceptance, recorded in the acceptance file:
  - a fresh browser profile signs in at the app, and the dashboard loads API data without visiting the API host directly; the same for the portal;
  - 30 page loads in a minute from one browser produce no `429`.
  A failure blocks cutover.
- [ ] **Step 5: Commit** `feat(deploy): cloudflare edge, access for app and portal, origin header and edge probes`.

### Task 9: Trigger.dev production

**Files:**
- Modify: `deploy/aws/README.md` ("Background jobs"); Trigger.dev dashboard settings (alert channel emailing prod run failures to Kyle; per-project concurrency from Task 6's budget)

**Interfaces:**
- Consumes: Task 4 vendoring, Task 6 `triggerEnvKeys`, Task 7b `trigger-deploy.sh`.

- [ ] **Step 1: Run** `bun deploy/aws/trigger-env.ts --project api --dry-run` and `--project app --dry-run`; the name lists equal `triggerEnvKeys`.
- [ ] **Step 2: Deploy** (after Kyle confirms) with `release.sh release <sha> --project api --project app`, or its Trigger stage alone.
- [ ] **Step 3: Verify** from the hosted app, with every laptop's `trigger dev` stopped:
  - regenerate one policy; the run completes in Trigger `prod`, the policy content updates, and Supabase's connection count stays under the budget;
  - one database-touching task logs the verified TLS mode;
  - knowledge-base document processing and questionnaire parsing work against Supabase Storage;
  - forcing one prod run failure emails Kyle.
- [ ] **Step 4: Commit** `docs(deploy): trigger.dev production runbook and alerting`.

### Task 10: Recovery gate, acceptance, documentation and ownership

**Files:**
- Create: `docs/self-hosting-aws.md` (architecture, Decisions, connection budget, regions and latency, secret classification, data boundary, migration compatibility rule, ownership contract and upstream-merge checklist), `docs/self-hosting-aws-acceptance-2026-10-xx.md`
- Modify: `deploy/aws/README.md` (operator runbook), `docs/self-hosting-local.md` ("Using hosted Comp"), root `README.md` (deployment section links both docs), `docs/specs/2026-10-05-aws-hosting-design.md` (decision record, maintainers and cadence)

- [ ] **Step 1: Kyle updates third parties.** Google OAuth client: origins `https://app.comp.revola.ai`, `https://api.comp.revola.ai`; redirect `https://api.comp.revola.ai/api/auth/callback/google`. Supabase: Enforce SSL on.
- [ ] **Step 2: Recovery gate (blocks the announcement).** Restore the database and a sample of Storage objects into an isolated Supabase project. Prove that one evidence file opens and one integration credential decrypts with the production `ENCRYPTION_KEY`. Record RPO, RTO, the drill date and steps, and how `ENCRYPTION_KEY`, `SECRET_KEY` and the Storage buckets are backed up outside Supabase.
- [ ] **Step 3: Acceptance.** Run the spec's acceptance criteria and these workflows, recording each command or browser action and its outcome in the acceptance file:
  - employee policy acknowledgment in the portal;
  - an auditor with a restricted role can read but not change evidence;
  - an evidence export;
  - offboarding: after a member is removed in People (and from Access), their session cookie, any API key they created, and their portal session get `401`/`403` on direct calls to `https://api.comp.revola.ai` from a non-browser client;
  - p95 latency of `/v1/health/ready` and one authenticated list call;
  - local development still works against the shared state (D7);
  - a second engineer completes a release from the runbook, with hands-on and wall-clock time recorded.
- [ ] **Step 4: Write the documents.**
  - `deploy/aws/README.md`, the operator runbook:
    - the bring-up order: decisions, tokens, Supabase gate, bootstrap and foundation, build, secrets, `release.sh bootstrap`, ECS, validation and ACM, edge, Trigger, acceptance;
    - release, rollback, single-service deploy, the change-a-secret recipe (sync, then `restart`), rotation, adding a user (People invite first; Access entries only for people outside `@revola.ai`), break lock, logs;
    - the ALB 60 s idle timeout, Cloudflare's 100 s origin timeout and 100 MB body cap;
    - that more than one task per service needs Redis-backed throttling and a shared Next cache handler;
    - a troubleshooting table: ALB 403, lost session, readiness 503 reasons, exec format error, Service Connect name, 429s, Trigger missing env, wrong AWS account.
  - `docs/self-hosting-aws.md`:
    - every `@Public()` API route as internet-reachable with its own check, and why each unused feature's guard suffices;
    - the processors and the data they see: Supabase, Upstash, Trigger.dev, Gemini, OpenAI, Resend, Firecrawl, Browserbase, Cloudflare, AWS. Note that `apps/api/src/trigger/policies/update-policy-prompts.ts` logs company context and policy content to Trigger logs;
    - the expand, release, contract migration rule;
    - the monthly cost from AWS pricing checked on the day, plus the edge certificate and Supabase Pro.
  - `docs/self-hosting-local.md`, "Using hosted Comp": the URL; why there are two Google sign-ins; wait for the invite email and do not create an organization; the portal URL; support contact.
- [ ] **Step 5: Ownership (UC3).** Record the decision (why self-host the fork rather than hosted Comp, naming the fork-only capabilities), the backup maintainer Kyle names, and the cadence checklist. After Kyle confirms, open upstream PRs on `trycompai/comp`, each tracked by an issue on `revola-ai/comp`, for:
  - `AUTH_COOKIE_DOMAIN` and the self-hosted origin policy;
  - `/v1/health/ready`;
  - the shared adapter options (pool size and the production TLS rule);
  - the revalidation and unsubscribe URL fixes;
  - the portal invite URL default;
  - the server API base URL helper;
  - verified-identity throttling.
  Also file issues on `revola-ai/comp`:
  - **P1:** separate development data before the audit window (D7 upgrade trigger);
  - **P2:** a staging environment with its own Supabase project;
  - **P2:** the fleet GitHub OIDC repair (cross-repo);
  - **P3:** migrations as an ECS task;
  - **P3:** scrubbing policy content from Trigger logs.
- [ ] **Step 6: Run** `bun run test` and `bun run typecheck` from the root; all PASS. Announcing the hosted URL to colleagues is the cutover; it happens only after Steps 2 and 3 pass.
- [ ] **Step 7: Commit** `docs(self-host): hosted comp runbook, acceptance record and ownership contract`.
