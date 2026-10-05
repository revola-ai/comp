# Comp AI on AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Revola fork of Comp AI as a hosted web app at `https://app.comp.revola.ai`, so colleagues use it in a browser and nobody runs the servers or Trigger workers locally.

**Architecture:** Three ARM64 Fargate services (`comp-api`, `comp-app`, `comp-portal`) on `revola-cluster` behind `revola-production-alb`, reached only through Cloudflare (proxied DNS, Access for `@revola.ai`, an origin header the ALB requires). Images are built by AWS CodeBuild from a fork-owned Dockerfile; secrets come from Secrets Manager `comp/production/config`; background jobs run on Trigger.dev `prod`. Data stays on Supabase and Upstash.

**Tech Stack:** NestJS API, Next.js 16 app and portal, Bun 1.3.4 + Turbo, Prisma 7.6, Docker buildx (bake), AWS ECS Fargate / ECR / CodeBuild / ELBv2 / ACM / Secrets Manager / CloudWatch Logs, Cloudflare API (DNS, Rulesets, Access), Trigger.dev v4.4.3.

**Spec:** `docs/specs/2026-10-05-aws-hosting-design.md`

## Global Constraints

- Branch `revola/aws-hosting` off `revola/self-host`; PR into `revola/self-host` on `revola-ai/comp`. Conventional commits with lowercase subjects; never `--no-verify`, never `git stash`.
- Repo rules (`CLAUDE.md`): bun only; no `as any`, no `@ts-ignore`; named parameters for functions with 2+ arguments; files at most 300 lines; zod at runtime boundaries; TDD for code.
- No em dashes in any file. Long Markdown: one sentence per line.
- AWS: account `455986776194`, region `us-east-2`, cluster `revola-cluster`, ALB `revola-production-alb` (DNS `revola-production-alb-1399285125.us-east-2.elb.amazonaws.com`, SG `sg-0eb10c6d5c5fd239b`, VPC `vpc-06b67bec700b38a10`), subnets `subnet-08095a4ada58a9eef`, `subnet-0284c89a912e76d71`, `subnet-0d4308baa95e7f157`, `assignPublicIp` `DISABLED`, execution role `ecsTaskExecutionRole`.
- Hosts: `app.comp.revola.ai`, `api.comp.revola.ai`, `portal.comp.revola.ai`; cookie domain `.comp.revola.ai`; certificate `*.comp.revola.ai` in ACM `us-east-2`.
- Fargate runtime platform `ARM64`/`LINUX`; sizes: api 1024 CPU / 2048 MB, app 1024 / 2048, portal 512 / 1024; desired count 1 each.
- ECR repositories `comp-api`, `comp-app`, `comp-portal`; image tag = git short SHA; buildx `docker-container` builder with `--cache-from=type=registry,ref=<repo>:cache` and `--cache-to=type=registry,ref=<repo>:cache,mode=max,image-manifest=true,oci-mediatypes=true`; never `type=inline`.
- Secrets: Secrets Manager `comp/production/config` (JSON object); task definitions reference `<arn>:KEY::`. Never print, log or commit a secret value; never read `.env*` files (scripts may source them in a subshell and pass values on without echoing).
- Node in images: `node:22` (>= 22.12); Bun `oven/bun:1.3.4` (matches `packageManager`).
- Supabase CA: Supabase's public root certificate is committed at `deploy/aws/certs/supabase-ca.crt` (copied from `packages/db/certs/prod-ca-2021.crt`, which stays gitignored for local use), so CodeBuild and Trigger deploys have it; every image carries it at `/app/certs/supabase-ca.crt` and sets `DATABASE_SSL_CA=/app/certs/supabase-ca.crt`.
- ALB listener rule priorities: 1 `api`, 2 `app`, 3 `portal` (host AND header `X-Comp-Origin-Auth`), 4 = host `*.comp.revola.ai` only, fixed response `403`.
- Every step that creates or changes AWS, Cloudflare, Google or Trigger.dev resources runs only after Kyle confirms at that step; the executor prints the exact command first.
- Deploys follow Revola's manual procedure: clone the running task definition, swap only the image, register, `update-service --force-new-deployment`, wait for `RUNNING` and `HEALTHY`.

## Review Focus

1. A wrong `AUTH_COOKIE_DOMAIN` (missing leading dot, or not a parent of the `BASE_URL` host) must stop the API at boot with a message, never silently drop sessions (Task 1 tests it).
2. A request that reaches the ALB with `Host: app.comp.revola.ai` but no origin header must get `403`, never the app or another Revola service (Task 7 verifies it).
3. A machine route opened by an Access Bypass must still reject a request without its token (`401`/`403`), so the bypass is never an open door (Task 8 verifies each one).
4. A task whose image lacks the CA file or whose `DATABASE_SSL_CA` is unset must fail health checks with the resolver's clear error, not connect without verification (Task 3 smoke test, Task 7 template test).
5. Deploying an image built for the wrong CPU architecture must be refused before `update-service`, not crash-loop with `exec format error` (Task 7 `deploy.sh` checks the manifest platform).

---

### Task 1: Configurable auth cookie domain

**Files:**
- Create: `apps/api/src/auth/cookie-domain.ts`
- Create: `apps/api/src/auth/cookie-domain.spec.ts`
- Modify: `apps/api/src/auth/auth.server.ts:52-62` (remove the local `getCookieDomain`, import the new one), `docs/self-hosting-local.md` (one line naming `AUTH_COOKIE_DOMAIN`)

**Interfaces:**
- Produces: `getCookieDomain({ env }: { env: Partial<NodeJS.ProcessEnv> }): string | undefined` exported from `apps/api/src/auth/cookie-domain.ts`; `auth.server.ts` calls `getCookieDomain({ env: process.env })`.

- [ ] **Step 1: Write the failing tests** in `cookie-domain.spec.ts` (jest):
  - `AUTH_COOKIE_DOMAIN='.comp.revola.ai'`, `BASE_URL='https://api.comp.revola.ai'` returns `'.comp.revola.ai'`.
  - `AUTH_COOKIE_DOMAIN` wins over a `trycomp.ai` `BASE_URL` when the BASE_URL host is inside it; with `BASE_URL='https://api.trycomp.ai'` and `AUTH_COOKIE_DOMAIN='.comp.revola.ai'` it throws `/AUTH_COOKIE_DOMAIN .* does not cover api.trycomp.ai/`.
  - `AUTH_COOKIE_DOMAIN='comp.revola.ai'` (no leading dot) throws `/must start with a dot/`.
  - Unset `AUTH_COOKIE_DOMAIN`: `BASE_URL` containing `staging.trycomp.ai` returns `'.staging.trycomp.ai'`, containing `trycomp.ai` returns `'.trycomp.ai'`, `http://localhost:3333` returns `undefined` (today's behaviour, unchanged).
- [ ] **Step 2: Run** `cd apps/api && npx jest src/auth/cookie-domain.spec.ts` and confirm FAIL (module not found).
- [ ] **Step 3: Implement `getCookieDomain({ env })`**: when `AUTH_COOKIE_DOMAIN` is set, require a leading `.`, and when `BASE_URL` parses, require its hostname to equal the domain without the dot or end with the domain; otherwise fall back to the existing `trycomp.ai` rules verbatim. Wire it into `auth.server.ts`.
- [ ] **Step 4: Run** the new spec plus `npx jest src/auth` and `npx turbo run typecheck --filter=@trycompai/api`; expect all auth specs PASS and no new type errors in touched files.
- [ ] **Step 5: Commit** `feat(api): configurable auth cookie domain for self-hosted domains`.

### Task 2: Portal health route

**Files:**
- Create: `apps/portal/src/app/api/health/route.ts`, `apps/portal/src/app/api/health/route.test.ts`

**Interfaces:**
- Produces: `GET /api/health` on the portal returning `200` with JSON `{ "status": "ok" }`, no database or session access (used by the ALB target group in Task 7).

- [ ] **Step 1: Write the failing test** (vitest): importing `GET` from `./route` and calling it returns status `200` and body `{ status: 'ok' }`; the module imports nothing from `@db`, auth or `next/headers` (assert by reading the source text in the test).
- [ ] **Step 2: Run** `cd apps/portal && npx vitest run src/app/api/health` and confirm FAIL.
- [ ] **Step 3: Implement `export async function GET(): Promise<NextResponse>`** with `export const dynamic = 'force-dynamic'`.
- [ ] **Step 4: Run** the test again; expect PASS.
- [ ] **Step 5: Commit** `feat(portal): add a dependency-free health route`.

### Task 3: Fork-owned container images

**Files:**
- Create: `deploy/aws/Dockerfile` (targets `api`, `app`, `portal`), `deploy/aws/docker-bake.hcl`, `deploy/aws/assemble-api-context.sh`, `deploy/aws/tests/images.smoke.sh`, `deploy/aws/certs/supabase-ca.crt` (public certificate, copied from `packages/db/certs/prod-ca-2021.crt`; the commit message notes its SHA-256)
- Modify: `.dockerignore` (create if absent) to exclude `**/.env*`, `**/node_modules`, `.local`, `.worktrees`, `.claude`, `packages/db/certs/*.pem`
- Do not modify upstream's root `Dockerfile` or `apps/api/Dockerfile`.

**Interfaces:**
- Consumes: Task 1 (`AUTH_COOKIE_DOMAIN` is runtime config only), Task 2 (portal health route).
- Produces: bake targets `api`, `app`, `portal`, each `linux/arm64`; bake variables `TAG`, `REGISTRY`, `APP_URL` (default `https://app.comp.revola.ai`), `API_URL` (default `https://api.comp.revola.ai`), `PORTAL_URL` (default `https://portal.comp.revola.ai`); images listen on 3333 (api) and 3000 (app, portal) and contain `/app/certs/supabase-ca.crt`.

- [ ] **Step 1: Write the smoke test** `deploy/aws/tests/images.smoke.sh`: builds the three targets locally with `docker buildx bake -f deploy/aws/docker-bake.hcl --load --set '*.platform=linux/arm64'` (TAG=`local`), then asserts: `node -v` in each image starts with `v22.`; `/app/certs/supabase-ca.crt` exists in each; the portal container started with `PORT=3000` answers `GET /api/health` with `200` within 30 s; the api container, started after sourcing `apps/api/.env` in a subshell and passing each variable by name only (`-e NAME` for every name matched by `^[A-Z][A-Z0-9_]*=` in the file, so values are never printed and Docker's literal `--env-file` quoting is avoided) plus `-e DATABASE_SSL_CA=/app/certs/supabase-ca.crt -e BASE_URL=http://localhost:3333`, answers `GET /v1/health` with `200` within 60 s (proves Prisma, verified TLS and the vendored workspace packages at runtime). The script never prints the env file.
- [ ] **Step 2: Run** `bash deploy/aws/tests/images.smoke.sh` and confirm FAIL (bake file missing).
- [ ] **Step 3: Write the Dockerfile and bake file.** Stages: `deps` (`oven/bun:1.3.4`, whole repo minus `.dockerignore`, `bun install --frozen-lockfile`), `libs` (`node_modules/.bin/turbo run build --ui=stream --filter='@trycompai/api^...' --filter='@trycompai/app^...' --filter='@trycompai/portal^...'`), `api-build` (`cd apps/api && bun run build`, then `assemble-api-context.sh` writes `/out`), `api` (`node:22-slim`, packages `openssl ca-certificates fontconfig fonts-dejavu-core wget`, copies `/out`, CA, non-root user, `CMD ["node","src/main.js"]`), `app-build`/`portal-build` (`bun run build:docker` with `NEXT_OUTPUT_STANDALONE=true`, `NEXT_PUBLIC_*` from bake variables: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`=API_URL, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_SELF_HOSTED=true`), `app`/`portal` (`node:22-alpine`, standalone output, CA, `CMD ["node","apps/<name>/server.js"]`). `assemble-api-context.sh` mirrors `apps/api/buildspec.yml` lines 55-100: copy `dist` (either layout) and `prisma`, copy root `node_modules`, replace each `@trycompai/{db,auth,company,billing,email,integration-platform,utils}` symlink with that package's built output and `package.json` (`utils` copies `src`), and fail if `src/main.js` is missing. Each runtime stage copies `deploy/aws/certs/supabase-ca.crt` to `/app/certs/supabase-ca.crt` and sets `ENV DATABASE_SSL_CA=/app/certs/supabase-ca.crt`.
- [ ] **Step 4: Run** the smoke test; expect every assertion PASS. Record image sizes in the commit message body.
- [ ] **Step 5: Commit** `feat(deploy): arm64 images for api, app and portal`.

### Task 4: Trigger.dev deploys use the fork's database package

**Files:**
- Create: `packages/db/scripts/vendor-db-for-trigger.ts`, `packages/db/scripts/vendor-db-for-trigger.test.ts`
- Modify: `apps/api/customPrismaExtension.ts`, `apps/app/customPrismaExtension.ts`, `apps/api/caBundleExtension.ts`, `apps/app/trigger.config.ts` (add `caBundleExtension`, moving it to a shared import path if the app has none)

**Interfaces:**
- Produces: `vendorWorkspaceDb({ repoRoot, outputPath }: { repoRoot: string; outputPath: string }): Promise<void>`: copies `packages/db/dist` and `packages/db/package.json` into `<outputPath>/node_modules/@trycompai/db`, throws when `dist/index.js` is missing (message tells the user to run `bun run build` in `packages/db`). Both Prisma extensions call it in `onBuildComplete` and drop `@trycompai/db` from their layer `dependencies`. `caBundleExtension()` also copies `deploy/aws/certs/supabase-ca.crt` to `certs/supabase-ca.crt` and adds `DATABASE_SSL_CA=/app/certs/supabase-ca.crt` to the deploy env.

- [ ] **Step 1: Write the failing tests** (bun test): with a temp repo containing `packages/db/dist/index.js` exporting `resolveSslConfig`, the function produces `<out>/node_modules/@trycompai/db/dist/index.js` and `package.json`; with no `dist` it rejects with `/run bun run build in packages\/db/`.
- [ ] **Step 2: Run** `cd packages/db && bun test scripts/vendor-db-for-trigger.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** the function and wire both extensions and the CA extension as described.
- [ ] **Step 4: Verify** with `cd apps/api && bunx trigger.dev@4.4.3 deploy --dry-run` and the same in `apps/app`: each build output contains `node_modules/@trycompai/db/dist/index.js` exporting `resolveSslConfig` and `certs/supabase-ca.crt`; the layer manifest has no `@trycompai/db` npm dependency. Run `bun test scripts` in `packages/db`.
- [ ] **Step 5: Commit** `fix(trigger): deploy the fork's database package and the supabase ca`.

### Task 5: ECR repositories and CodeBuild image builds

**Files:**
- Create: `deploy/aws/buildspec.yml`, `deploy/aws/provision-build.sh`, `deploy/aws/README.md` (section "Builds")

**Interfaces:**
- Consumes: Task 3 bake file and targets.
- Produces: CodeBuild project `comp-images` (environment `ARM_CONTAINER`, image `aws/codebuild/amazonlinux-aarch64-standard:3.0`, privileged mode on, source `revola-ai/comp` through the CodeConnections connection named `revola-ai-github`); `aws codebuild start-build --project-name comp-images --source-version <sha>` pushes `comp-{api,app,portal}:<short-sha>` and refreshes each `:cache`.

- [ ] **Step 1: Write `provision-build.sh`** (idempotent, `--dry-run` prints every AWS call without executing): create ECR repos with scan-on-push and a lifecycle policy keeping the last 20 SHA tags plus `cache`; IAM role `comp-codebuild-role` with ECR push to those three repos, CloudWatch Logs `/codebuild/comp-images`, and `codeconnections:UseConnection` on the connection; the CodeBuild project above. Run `shellcheck -S warning` and `bash deploy/aws/provision-build.sh --dry-run`; expect the call list and no errors.
- [ ] **Step 2: Kyle creates the CodeConnections GitHub connection** `revola-ai-github` in the AWS console (Developer Tools, Connections) and authorizes `revola-ai/comp`; confirm `aws codeconnections list-connections` shows it `AVAILABLE`.
- [ ] **Step 3: Write `buildspec.yml`**: log in to ECR, create the `docker-container` builder, `docker buildx bake -f deploy/aws/docker-bake.hcl --push` with `REGISTRY=455986776194.dkr.ecr.us-east-2.amazonaws.com`, `TAG=$(git rev-parse --short HEAD)` and the registry cache flags from Global Constraints per target.
- [ ] **Step 4: Run** `bash deploy/aws/provision-build.sh` (after Kyle confirms), then `aws codebuild start-build --project-name comp-images --source-version revola/aws-hosting`; expect `SUCCEEDED` and three tags in ECR whose manifests list `linux/arm64`.
- [ ] **Step 5: Commit** `feat(deploy): codebuild project and ecr repositories for comp images`.

### Task 6: Production secrets in Secrets Manager

**Files:**
- Create: `deploy/aws/secret-keys.ts` (allowlist and per-app mapping), `deploy/aws/secret-keys.test.ts`, `deploy/aws/sync-secrets.ts`

**Interfaces:**
- Produces: `PRODUCTION_OVERRIDES: Record<string, string>` (non-secret values fixed by the spec: `NODE_ENV=production`, `SELF_HOSTED=true`, `NEXT_PUBLIC_SELF_HOSTED=true`, `BASE_URL`/`BETTER_AUTH_URL=https://api.comp.revola.ai`, `APP_URL`/`NEXT_PUBLIC_APP_URL=https://app.comp.revola.ai`, `PORTAL_URL=https://portal.comp.revola.ai`, `AUTH_COOKIE_DOMAIN=.comp.revola.ai`, `AUTH_TRUSTED_ORIGINS` = the three https origins comma-separated, `DATABASE_SSL_CA=/app/certs/supabase-ca.crt`); `SECRET_KEYS: readonly string[]` (values copied from the team's current env files: database, storage, Redis, auth secrets, Google OAuth, Resend, Gemini, OpenAI, `ENCRYPTION_KEY`, `SECRET_KEY`, `INTERNAL_API_TOKEN`, `SERVICE_TOKEN_TRIGGER`, `SERVICE_TOKEN_PORTAL`, `REVALIDATION_SECRET`, Trigger prod keys `TRIGGER_SECRET_KEY_API`, `TRIGGER_SECRET_KEY_APP` and refs `TRIGGER_PROJECT_REF_API`, `TRIGGER_PROJECT_REF_APP`); `secretsForService({ service }: { service: 'api' | 'app' | 'portal' }): { name: string; key: string }[]` (container env name to secret key; `TRIGGER_SECRET_KEY` maps to `TRIGGER_SECRET_KEY_API` for api and `TRIGGER_SECRET_KEY_APP` for app, likewise `TRIGGER_PROJECT_REF`), used by Tasks 7 and 9.

- [ ] **Step 1: Write the failing tests**: every `key` that `secretsForService` returns is in `SECRET_KEYS` or `PRODUCTION_OVERRIDES` and no service has two entries with the same `name`; no override value contains `localhost`; `AUTH_COOKIE_DOMAIN` covers the `BASE_URL` host (reuse the rule from Task 1 by importing it if the import path is clean, otherwise assert the literal pair); the `TRIGGER_SECRET_KEY` entry for `api` has key `TRIGGER_SECRET_KEY_API` and for `app` has key `TRIGGER_SECRET_KEY_APP`; `portal` has no Trigger entries.
- [ ] **Step 2: Run** `bun test deploy/aws/secret-keys.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** `secret-keys.ts` and `sync-secrets.ts`: sources the local env files in a child process, builds the JSON object from `SECRET_KEYS` plus `PRODUCTION_OVERRIDES` and the two Trigger prod keys supplied as environment variables, prints only key names and counts, and `put-secret-value` (or `create-secret`) on `comp/production/config`. `--dry-run` prints key names only.
- [ ] **Step 4: Run** tests (PASS) and `bun deploy/aws/sync-secrets.ts --dry-run`; Kyle runs it for real after creating Trigger prod keys (Task 9 Step 1 can run first) and confirms `aws secretsmanager describe-secret --secret-id comp/production/config` exists. Check `ecsTaskExecutionRole`'s `SecretsManagerRead` policy resource covers `arn:aws:secretsmanager:us-east-2:455986776194:secret:comp/*`; if not, add that ARN pattern to the policy (Kyle confirms).
- [ ] **Step 5: Commit** `feat(deploy): production secret sync for comp`.

### Task 7: ECS services, target groups and ALB rules

**Files:**
- Create: `deploy/aws/render-task-definition.ts`, `deploy/aws/render-task-definition.test.ts`, `deploy/aws/listener-rules.ts`, `deploy/aws/listener-rules.test.ts`, `deploy/aws/ecs-up.sh`, `deploy/aws/deploy.sh`

**Interfaces:**
- Consumes: Task 5 image URIs, Task 6 `secretsForService`, secret ARN of `comp/production/config`.
- Produces: `renderTaskDefinition({ service, imageUri, secretArn }: { service: 'api' | 'app' | 'portal'; imageUri: string; secretArn: string }): RegisterTaskDefinitionInput` and `buildListenerRules({ targetGroups, originHeaderValue }: { targetGroups: Record<'api' | 'app' | 'portal', string>; originHeaderValue: string }): ListenerRule[]`; `deploy.sh <short-sha>` deploys all three services.

- [ ] **Step 1: Write the failing tests**: the task definition for each service has family `comp-<service>`, `runtimePlatform` `ARM64`/`LINUX`, `requiresCompatibilities` `FARGATE`, network mode `awsvpc`, the CPU/memory from Global Constraints, execution role `ecsTaskExecutionRole`, port 3333 or 3000, log group `/ecs/comp-<service>` in `us-east-2`, every `secretsForService` entry as a secret `{ name, valueFrom: '<secretArn>:<key>::' }` and no secret as a plain `environment` entry, and `DATABASE_SSL_CA` present; listener rules are exactly priorities 1 (`api.comp.revola.ai` + header), 2 (`app`), 3 (`portal`) forwarding to their target groups, and 4 (host `*.comp.revola.ai`, no header condition) with fixed response `403`; no rule uses a priority from 5 upward.
- [ ] **Step 2: Run** `bun test deploy/aws/render-task-definition.test.ts deploy/aws/listener-rules.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** both modules. `ecs-up.sh` (idempotent, `--dry-run`): log groups (30-day retention); security group `comp-tasks-sg` in the VPC allowing 3000 and 3333 only from `sg-0eb10c6d5c5fd239b`; target groups `comp-api-tg` (port 3333, health `/v1/health`), `comp-app-tg` (3000, `/api/health`), `comp-portal-tg` (3000, `/api/health`), target type `ip`, healthy threshold 2, interval 30 s; register task definitions; request the ACM certificate for `*.comp.revola.ai` (DNS validation; prints the CNAME for Task 8) and, once `ISSUED`, add it to the 443 listener; create the four listener rules; create the three services with the subnets, `comp-tasks-sg`, `assignPublicIp=DISABLED` and the target groups. The origin header value is generated once and stored as key `COMP_ORIGIN_AUTH` in `comp/production/config`. `deploy.sh <sha>`: for each service, check `docker buildx imagetools inspect` reports `linux/arm64` for the tag (abort otherwise), clone the running task definition, swap only the image, register, `update-service --force-new-deployment`, and `aws ecs wait services-stable`.
- [ ] **Step 4: Run** tests (PASS), `ecs-up.sh --dry-run`, then for real after Kyle confirms, then `deploy.sh <sha from Task 5>`. Verify: all three services `RUNNING` with healthy targets; `curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.comp.revola.ai' https://revola-production-alb-1399285125.us-east-2.elb.amazonaws.com/ -k` prints `403`; the same with the origin header prints `200` or a redirect from the app.
- [ ] **Step 5: Commit** `feat(deploy): ecs services, target groups and alb rules for comp`.

### Task 8: Cloudflare DNS, origin header and Access

**Files:**
- Create: `deploy/aws/cloudflare.ts`, `deploy/aws/cloudflare.test.ts`, `deploy/aws/access-bypass.ts`

**Interfaces:**
- Consumes: ACM validation CNAME (Task 7), `COMP_ORIGIN_AUTH` (Task 7), ALB DNS name.
- Produces: `ACCESS_BYPASS_PATHS: readonly { host: 'api.comp.revola.ai' | 'app.comp.revola.ai'; path: string }[]` = `api.comp.revola.ai/v1/internal/*`, `api.comp.revola.ai/v1/integrations/internal/*`, `api.comp.revola.ai/v1/integrations/sync/*`, `api.comp.revola.ai/v1/cloud-security/*`, `api.comp.revola.ai/v1/email/unsubscribe*`, `app.comp.revola.ai/api/revalidate/path` (the routes Trigger tasks and email recipients call, found with `grep` over `apps/*/src/trigger`).

- [ ] **Step 1: Write the failing tests**: the DNS records built are proxied CNAMEs for the three hosts to the ALB DNS name plus an unproxied validation CNAME; the request-header transform rule targets `http.host in {...}` for exactly the three hosts and sets `X-Comp-Origin-Auth`; the Access application covers `*.comp.revola.ai` with one Allow policy, `emails_ending_in: ['@revola.ai']`, Google as the only identity provider; each `ACCESS_BYPASS_PATHS` entry becomes its own Access application with a Bypass policy; no bypass covers `/` or `/api/auth/*`.
- [ ] **Step 2: Run** `bun test deploy/aws/cloudflare.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** `cloudflare.ts` (Cloudflare API with `CLOUDFLARE_API_TOKEN` scoped to Zone DNS edit, Zone Transform Rules edit and Access edit for `revola.ai`, and `CLOUDFLARE_ACCOUNT_ID`, both supplied by Kyle; `--dry-run` prints the payloads with the header value redacted).
- [ ] **Step 4: Run** tests (PASS), then for real after Kyle confirms, in this order: validation CNAME, wait for ACM `ISSUED` and finish Task 7's listener step, transform rule, Access applications, then the three proxied CNAMEs last. Verify: `curl -sI https://app.comp.revola.ai` returns a redirect to `*.cloudflareaccess.com`; for every bypass path, an unauthenticated request returns `401` or `403` from the API or app itself (not a Cloudflare page).
- [ ] **Step 5: Commit** `feat(deploy): cloudflare dns, origin header and access for comp`.

### Task 9: Trigger.dev production deploy

**Files:**
- Create: `deploy/aws/trigger-env.ts`
- Modify: `deploy/aws/README.md` (section "Background jobs")

**Interfaces:**
- Consumes: Task 4 vendoring, Task 6 `secretsForService`.
- Produces: both Trigger projects deployed to `prod`; their prod environment variables set from `comp/production/config` (same keys as the matching ECS service) by `bun deploy/aws/trigger-env.ts --project <app|api>` using `envvars.upload` from `@trigger.dev/sdk`, printing key names only.

- [ ] **Step 1: Kyle creates prod secret keys** for `comp-app` and `comp-api` in the Trigger.dev dashboard and passes them to Task 6's sync.
- [ ] **Step 2: Run** `bun deploy/aws/trigger-env.ts --project api --dry-run` and `--project app --dry-run`; expect env-name lists matching `secretsForService` for `api` and `app`.
- [ ] **Step 3: Deploy** (after Kyle confirms) `cd apps/api && bunx trigger.dev@4.4.3 deploy --env prod` and the same in `apps/app`, then run `trigger-env.ts` for both without `--dry-run`.
- [ ] **Step 4: Verify** from the hosted app with every laptop's `trigger dev` stopped: regenerate one policy; the run completes in the Trigger.dev `prod` dashboard and the policy content updates in the app.
- [ ] **Step 5: Commit** `feat(deploy): trigger.dev production environment for comp`.

### Task 10: Third-party settings, acceptance and docs

**Files:**
- Create: `docs/self-hosting-aws.md`
- Modify: `docs/self-hosting-local.md` (link to the hosted setup; colleagues no longer need a local stack to use Comp), `deploy/aws/README.md`

- [ ] **Step 1: Kyle updates** the Google OAuth client (origins `https://app.comp.revola.ai`, `https://api.comp.revola.ai`; redirect `https://api.comp.revola.ai/api/auth/callback/google`), moves Supabase to Pro and turns on Enforce SSL.
- [ ] **Step 2: Run the spec's acceptance criteria 1 to 7** and record each result (command or browser action, observed outcome) in `docs/self-hosting-aws.md` under "Acceptance, 2026-10-xx". Criterion 7: `scripts/local-run.sh build && start` still works against the shared state.
- [ ] **Step 3: Write `docs/self-hosting-aws.md`**: architecture, how to deploy a new commit (CodeBuild build, `deploy.sh <sha>`, migrations first when the commit adds any), how to roll back (`deploy.sh <previous sha>`), how to add a colleague or an auditor (Access policy plus People invite), where logs are, and the monthly cost from AWS pricing checked on the day.
- [ ] **Step 4: Run** `bun test deploy/aws` and the Task 1 and Task 2 suites once more; all PASS.
- [ ] **Step 5: Commit** `docs(self-host): hosted comp on aws runbook and acceptance record`.
