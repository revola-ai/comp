# Hosting Comp AI on AWS (design)

Status: draft for review, 2026-10-05.
Decisions taken with Kyle: Fargate on `revola-cluster`, Cloudflare Access for sign-in control, domain `*.comp.revola.ai`.

## 1. Goal

Run the Revola fork of Comp AI as a hosted web app that colleagues open in a browser, so nobody has to run the API, app and Trigger workers on a laptop.
The compliance data stays where it is today (Supabase Postgres and Storage, Upstash Redis); only the servers and background jobs move.

Non-goals for this design: automatic deploys from GitHub (the GitHub Actions OIDC trust in account `455986776194` is broken across Revola repos), autoscaling, a staging environment, and multi-region.

## 2. Current state (verified 2026-10-05)

- AWS account `455986776194`, region `us-east-2`, one ECS cluster `revola-cluster`; every Revola service runs there on Fargate (for example `content-backend`, `interaction-service-production`).
- Two internet-facing application load balancers, `revola-production-alb` and `revola-staging-alb`, each with an HTTPS listener on 443.
- `revola.ai` DNS is served by Cloudflare (`laila.ns.cloudflare.com`, `rocky.ns.cloudflare.com`); Route 53 holds only a private zone.
- Comp's state is already hosted: Supabase Postgres through the session pooler with verified TLS (`DATABASE_SSL_CA`), Supabase Storage through its S3 endpoint, Upstash Redis.
- Upstream ships a root `Dockerfile` with `app` and `portal` targets (Node 22, Next.js standalone output) that take `NEXT_PUBLIC_*` values as build arguments, and an API image (`apps/api/Dockerfile`, `node:20-slim`) whose build context is assembled by `apps/api/buildspec.yml` for AWS CodeBuild.
- Health endpoints: API `GET /v1/health`, app `GET /api/health`.

## 3. Target architecture

```
browser ──HTTPS──> Cloudflare (proxied DNS, Access: @revola.ai Google accounts only,
                   adds X-Comp-Origin-Auth header)
          ──HTTPS──> revola-production-alb (host + header rules)
                   ├─ app.comp.revola.ai    -> ECS service comp-app    (Next.js, :3000)
                   ├─ api.comp.revola.ai    -> ECS service comp-api    (NestJS, :3333)
                   └─ portal.comp.revola.ai -> ECS service comp-portal (Next.js, :3000)
ECS tasks ──> Supabase Postgres (verified TLS) and Storage (S3 API), Upstash Redis, Gemini/OpenAI/Resend
Trigger.dev cloud (prod environment of comp-app and comp-api) runs background jobs and calls api.comp.revola.ai
```

### 3.1 Services

| Service | Image | Task size (ARM64) | Port | Health check | Desired count |
|---|---|---|---|---|---|
| `comp-api` | ECR `comp-api` | 1 vCPU, 2 GB | 3333 | `/v1/health` | 1 |
| `comp-app` | ECR `comp-app` | 1 vCPU, 2 GB | 3000 | `/api/health` | 1 |
| `comp-portal` | ECR `comp-portal` | 0.5 vCPU, 1 GB | 3000 | `/api/health` (added by this work, see 3.4) | 1 |

Tasks run on Fargate with the ARM64 runtime platform in the same subnets and security-group pattern as the existing services.
ARM64 lets images build natively on Apple silicon and on ARM CodeBuild, and Fargate ARM is priced about 20% below x86.
Logs go to CloudWatch log groups `/ecs/comp-api`, `/ecs/comp-app`, `/ecs/comp-portal`.

### 3.2 Configuration and secrets

- A Secrets Manager secret `comp/production/config` (one JSON object of key/value pairs) holds every secret; task definitions reference individual keys as ECS `secrets` (`<secret-arn>:KEY::`), the same way the other Revola production services do (for example `interaction-service/production/config`). The shared `ecsTaskExecutionRole` already carries a `SecretsManagerRead` policy; the plan checks its resource scope covers `comp/*`.
- Shared values are the ones colleagues already use (Supabase, Upstash, Google OAuth, Resend, Gemini, OpenAI), plus `ENCRYPTION_KEY` and `SECRET_KEY`, which must equal the values the team already uses because integration credentials in the shared database are encrypted with `ENCRYPTION_KEY`.
- Public URLs: `BASE_URL`/`BETTER_AUTH_URL` = `https://api.comp.revola.ai`, `NEXT_PUBLIC_APP_URL`/`APP_URL` = `https://app.comp.revola.ai`, `PORTAL_URL` = `https://portal.comp.revola.ai`, `AUTH_TRUSTED_ORIGINS` = those three origins.
- `NEXT_PUBLIC_*` values are compiled into the app and portal images at build time, so the images are built for this domain.
- The Supabase CA certificate is public and is copied into each image at `/app/certs/supabase-ca.crt`; `DATABASE_SSL_CA` points there.

### 3.3 Edge, access control and origin lock

- Cloudflare DNS: proxied CNAMEs `app.comp`, `api.comp`, `portal.comp` to the ALB's DNS name.
- An ACM certificate for `*.comp.revola.ai` in `us-east-2`, validated with a CNAME in Cloudflare, attached to the ALB's 443 listener as an additional certificate.
- Cloudflare Access application covering `*.comp.revola.ai`, Google as identity provider, policy: allow emails ending in `@revola.ai`.
  This is what stops strangers from signing in, which matters because `SELF_HOSTED=true` auto-approves every new organization.
- ALB rule priorities: the production listener's existing rules are path-based at priorities 5 to 36 and its default action forwards to another service, so Comp's host-and-header rules take priorities 1 to 3 and a priority-4 rule answers `403` for any `*.comp.revola.ai` request that lacks the origin header.
- Origin lock: a Cloudflare Transform Rule adds `X-Comp-Origin-Auth: <secret>` to requests for `*.comp.revola.ai`, and every ALB listener rule for the three hosts requires that header.
  Without it, anyone who learns the ALB address could send `Host: app.comp.revola.ai` straight to the ALB and skip Access.
  Requests without the header get the priority-4 `403`; ALB target health checks do not pass through listener rules, so they are unaffected.
- Machine callers: Trigger.dev tasks call the API (internal email sending, revalidation) and cannot pass Access.
  The plan enumerates every endpoint called from Trigger tasks or external webhooks (the API's `@Public()` routes and the internal routes guarded by `INTERNAL_API_TOKEN` or service tokens) and adds Access Bypass policies for exactly those paths; those routes keep their own token checks.

### 3.4 Code changes in the fork

1. `AUTH_COOKIE_DOMAIN`: `getCookieDomain()` in `apps/api/src/auth/auth.server.ts` only enables cross-subdomain cookies for `trycomp.ai`.
   Add an `AUTH_COOKIE_DOMAIN` environment variable (here `.comp.revola.ai`) that takes precedence, with tests; without it the app at `app.comp.revola.ai` cannot see the session set by `api.comp.revola.ai`.
2. API image: move `apps/api/Dockerfile` to Node 22 (Prisma 7.6 requires `^22.12`), build for `linux/arm64`, and copy the Supabase CA.
   Adapt the context assembly from `apps/api/buildspec.yml` (built `dist`, `node_modules`, and the workspace packages copied in from their built output) into the fork's build.
3. Trigger.dev deploy: `apps/api/customPrismaExtension.ts` installs `@trycompai/db` from npm, which is upstream's package and lacks the fork's exports (`resolveSslConfig`, `buildManifestFromFramework`).
   Vendor the workspace `packages/db` build into the deploy, and extend `apps/api/caBundleExtension.ts` to ship the Supabase CA and set `DATABASE_SSL_CA`.
   Apply the same check to the `apps/app` Trigger project.
4. Portal health route `GET /api/health` returning 200 without touching the database, matching the app's, so the ALB health check does not depend on page rendering or session checks.

### 3.5 Builds

- AWS CodeBuild project `comp-images` in `455986776194`, ARM64 Linux environment, source from the `revola-ai/comp` GitHub fork through an AWS CodeConnections connection (authorized once in the console by Kyle).
- One build produces `comp-api`, `comp-app` and `comp-portal` images, tagged with the git short SHA, pushed to ECR.
- Builds use a `docker-container` buildx builder with a registry cache at `<repo>:cache` and `--cache-to=type=registry,...,mode=max,image-manifest=true,oci-mediatypes=true`, as Revola's build rules require.
- Started by hand (`aws codebuild start-build --project-name comp-images --source-version <sha>`), so nothing heavy runs on a laptop and the broken GitHub OIDC trust does not matter.

### 3.6 Deploys and migrations

- First deploy registers task definitions and creates the three services and target groups.
- Updates follow Revola's manual deploy procedure: clone the running task definition, swap only the image, register it, `aws ecs update-service --force-new-deployment`, and wait for `RUNNING` and `HEALTHY`.
- Database migrations stay a deliberate release step: `cd packages/db && bunx prisma migrate deploy` from an operator machine against Supabase, run before deploying images that need them.
  Migrations are rare and the database is shared; a one-off ECS migration task is a later improvement.
- Trigger.dev: `trigger deploy` for `comp-app` and `comp-api` to their `prod` environment, with environment variables set in the Trigger.dev dashboard (or `syncEnvVars`), pointing at `https://api.comp.revola.ai`.
  After this, colleagues no longer need `trigger dev` running for jobs to complete.

### 3.7 Third-party configuration

- Google OAuth client: add JavaScript origins `https://app.comp.revola.ai`, `https://api.comp.revola.ai` and redirect URI `https://api.comp.revola.ai/api/auth/callback/google`.
- Supabase: move to the Pro plan for daily backups (the free plan has none), and turn on "Enforce SSL".
- Resend: the existing sending domain keeps working; invitation links will point at `app.comp.revola.ai`.

## 4. Security notes

- Access at the edge plus the origin-lock header means the app is unreachable to anyone outside `@revola.ai`, including the sign-up flow that would otherwise auto-approve organizations.
- Secrets live only in Secrets Manager and in task memory; images contain no secrets (the Supabase CA is public).
- Bypass paths for machine callers stay narrow and keep their own token checks.
- Outside parties (an auditor, employees signing policies in the portal) need an Access policy entry before they can reach the site.

## 5. Cost estimate (monthly, us-east-2, on-demand)

- Fargate ARM64: about 2.5 vCPU and 5 GB running continuously, roughly $70 to $75.
- ALB: shared with existing services; new rules and target groups add no meaningful cost.
- CloudWatch logs and ECR storage: a few dollars.
- Supabase Pro: $25. Upstash and Trigger.dev: usage-based, small at this volume. Cloudflare Access: free plan covers up to 50 users.
- Figures are estimates to be confirmed against current AWS pricing in the plan.

## 6. Acceptance criteria

1. `https://app.comp.revola.ai` asks for Revola Google sign-in through Cloudflare Access, then loads the Revola AI organization with the same 28 policies and both frameworks as today.
2. A request to the ALB with `Host: app.comp.revola.ai` but without the origin header gets `403`, not the app and not another Revola service.
3. Signing in on `app.comp.revola.ai` keeps the session across app, API and portal (cookie domain `.comp.revola.ai`).
4. A background job started from the hosted app (for example policy regeneration) completes on Trigger.dev `prod` with no laptop running `trigger dev`.
5. Evidence upload to Supabase Storage and download back work from the hosted app.
6. Each ECS service reports `RUNNING` and `HEALTHY` on the image tag of the deployed commit.
7. Local development still works unchanged (`scripts/local-run.sh` against the same shared state).

## 7. Open items needing Kyle

- Authorize the CodeConnections GitHub connection for `revola-ai/comp` in the AWS console.
- Create the Cloudflare Access application and the Transform Rule (or grant a scoped Cloudflare API token so the plan can script them).
- Update the Google OAuth client.
- Choose the Supabase plan.
