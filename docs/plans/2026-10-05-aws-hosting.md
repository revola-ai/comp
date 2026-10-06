<!-- /autoplan restore point: "/Users/kylezhang/.gstack/projects/trycompai-comp/claude-aws-hosting-plan-030916-autoplan-restore-20261005-144655.md" -->
## Implementation plan
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
3. A machine route opened by an Access Bypass must still reject a request without its token with the origin's own `4xx` (per-path expectation in the test fixture), so the bypass is never an open door (Task 8 verifies each one).
4. An API task whose image lacks the CA file or whose `DATABASE_SSL_CA` is unset must fail the readiness probe `GET /v1/health/ready` with a `503` naming the TLS error class, not connect without verification (Task 3 smoke test, `deploy.sh` smoke, Task 7 template test).
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
  - `AUTH_COOKIE_DOMAIN='.trycomp.ai'` with `BASE_URL='https://api.staging.trycomp.ai'` returns `'.trycomp.ai'` (the variable wins over the built-in `staging` rule); `AUTH_COOKIE_DOMAIN='.comp.revola.ai'` with `BASE_URL='https://api.trycomp.ai'` throws `/AUTH_COOKIE_DOMAIN .* does not cover api.trycomp.ai/`.
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

- [ ] **Step 1: Write the smoke test** `deploy/aws/tests/images.smoke.sh`: builds the three targets locally with `docker buildx bake -f deploy/aws/docker-bake.hcl --load --set '*.platform=linux/arm64'` (TAG=`local`), then asserts: `node -v` in each image starts with `v22.`; `/app/certs/supabase-ca.crt` exists in each; the portal container started with `PORT=3000` answers `GET /api/health` with `200` within 30 s; the api container, started after sourcing `apps/api/.env` in a subshell and passing each variable by name only (`-e NAME` for every name matched by `^[A-Z][A-Z0-9_]*=` in the file, so values are never printed and Docker's literal `--env-file` quoting is avoided) plus `-e DATABASE_SSL_CA=/app/certs/supabase-ca.crt -e BASE_URL=http://localhost:3333`, answers `GET /v1/health/ready` with `200` within 60 s (its `SELECT 1` proves Prisma, verified TLS and the vendored workspace packages at runtime), and a second api container started without `DATABASE_SSL_CA` answers `/v1/health/ready` with `503` naming the TLS error class. The script never prints the env file.
- [ ] **Step 2: Run** `bash deploy/aws/tests/images.smoke.sh` and confirm FAIL (bake file missing).
- [ ] **Step 3: Write the Dockerfile and bake file.** Stages: `deps` (`oven/bun:1.3.4`, whole repo minus `.dockerignore`, `bun install --frozen-lockfile`), `libs` (`node_modules/.bin/turbo run build --ui=stream --filter='@trycompai/api^...' --filter='@trycompai/app^...' --filter='@trycompai/portal^...'`), `api-build` (`cd apps/api && bun run build`, then `assemble-api-context.sh` writes `/out`), `api` (`node:22-slim`, packages `openssl ca-certificates fontconfig fonts-dejavu-core wget`, copies `/out`, CA, non-root user, `CMD ["node","src/main.js"]`), `app-build`/`portal-build` (`bun run build:docker` with `NEXT_OUTPUT_STANDALONE=true`, `NEXT_PUBLIC_*` from bake variables: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`=API_URL, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_SELF_HOSTED=true`), `app`/`portal` (`node:22-alpine`, standalone output, CA, `CMD ["node","apps/<name>/server.js"]`). `assemble-api-context.sh` mirrors `apps/api/buildspec.yml` lines 55-100: copy `dist` (either layout) and `prisma`, copy root `node_modules`, replace each `@trycompai/{db,auth,company,billing,email,integration-platform,utils}` symlink with that package's built output and `package.json` (`utils` copies `src`), and fail if `src/main.js` is missing. Each runtime stage copies `deploy/aws/certs/supabase-ca.crt` to `/app/certs/supabase-ca.crt` and sets `ENV DATABASE_SSL_CA=/app/certs/supabase-ca.crt`.
- [ ] **Step 4: Run** the smoke test; expect every assertion PASS. Record image sizes in the commit message body.
- [ ] **Step 5: Commit** `feat(deploy): arm64 images for api, app and portal`.

### Task 4: Trigger.dev deploys use the fork's database package

**Files:**
- Create: `packages/db/scripts/vendor-db-for-trigger.ts`, `packages/db/scripts/vendor-db-for-trigger.test.ts`
- Modify: `apps/api/customPrismaExtension.ts`, `apps/app/customPrismaExtension.ts`, `apps/api/caBundleExtension.ts`, `apps/app/caBundleExtension.ts` (exists; edited in place), `apps/app/trigger.config.ts` (register `caBundleExtension` if it is not already registered)

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
- [ ] **Step 3: Write `buildspec.yml`**: log in to ECR, create the `docker-container` builder, `docker buildx bake -f deploy/aws/docker-bake.hcl --push` with `REGISTRY=455986776194.dkr.ecr.us-east-2.amazonaws.com`, `TAG` = the first 12 characters of `CODEBUILD_RESOLVED_SOURCE_VERSION` and the registry cache flags from Global Constraints per target.
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
- [ ] **Step 4: Run** tests (PASS) and `bun deploy/aws/sync-secrets.ts --dry-run`; Kyle runs it for real after creating Trigger prod keys (Task 9 Step 1 can run first) and confirms `aws secretsmanager describe-secret --secret-id comp/production/config` exists. `ecsTaskExecutionRole`'s inline `SecretsManagerRead` policy already allows `arn:aws:secretsmanager:us-east-2:455986776194:secret:*` (verified 2026-10-05), so no IAM change is needed (known risk: every task using this role can read every secret in the account); re-check with `aws iam get-role-policy --role-name ecsTaskExecutionRole --policy-name SecretsManagerRead` before the first deploy.
- [ ] **Step 5: Commit** `feat(deploy): production secret sync for comp`.

### Task 7: ECS services, target groups and ALB rules

**Files:**
- Create: `deploy/aws/render-task-definition.ts`, `deploy/aws/render-task-definition.test.ts`, `deploy/aws/listener-rules.ts`, `deploy/aws/listener-rules.test.ts`, `deploy/aws/ecs-up.sh`, `deploy/aws/deploy.sh`

**Interfaces:**
- Consumes: Task 5 image URIs, Task 6 `secretsForService`, secret ARN of `comp/production/config`.
- Produces: `renderTaskDefinition({ service, imageUri, secretArn }: { service: 'api' | 'app' | 'portal'; imageUri: string; secretArn: string }): RegisterTaskDefinitionInput` and `buildListenerRules({ targetGroups, originHeaderValues }: { targetGroups: Record<'api' | 'app' | 'portal', string>; originHeaderValues: readonly [string] | readonly [string, string] }): ListenerRule[]`; `deploy.sh <short-sha>` deploys all three services.

- [ ] **Step 1: Write the failing tests**: the task definition for each service has family `comp-<service>`, `runtimePlatform` `ARM64`/`LINUX`, `requiresCompatibilities` `FARGATE`, network mode `awsvpc`, the CPU/memory from Global Constraints, execution role `ecsTaskExecutionRole`, port 3333 or 3000, log group `/ecs/comp-<service>` in `us-east-2`, every `secretsForService` entry as a secret `{ name, valueFrom: '<secretArn>:<key>::' }` and no secret as a plain `environment` entry, and `DATABASE_SSL_CA` present; listener rules are exactly priorities 1 (`api.comp.revola.ai` + header), 2 (`app`), 3 (`portal`) forwarding to their target groups, and 4 (host `*.comp.revola.ai`, no header condition) with fixed response `403`; no rule uses a priority from 5 upward.
- [ ] **Step 2: Run** `bun test deploy/aws/render-task-definition.test.ts deploy/aws/listener-rules.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** both modules. `ecs-up.sh` (idempotent, `--dry-run`): log groups (30-day retention); security group `comp-tasks-sg` in the VPC allowing 3000 and 3333 from `sg-0eb10c6d5c5fd239b` and 3333 from itself (Service Connect); target groups `comp-api-tg` (port 3333, health `/v1/health`), `comp-app-tg` (3000, `/api/health`), `comp-portal-tg` (3000, `/api/health`), target type `ip`, healthy threshold 2, interval 30 s; register task definitions; request the ACM certificate for `*.comp.revola.ai` (DNS validation; prints the CNAME for Task 8) and, once `ISSUED`, add it to the 443 listener; create the four listener rules; create the three services with the subnets, `comp-tasks-sg`, `assignPublicIp=DISABLED` and the target groups. The origin header value is generated once and stored as key `COMP_ORIGIN_AUTH` in its own secret `comp/production/origin-auth` (not in `comp/production/config`, so secret re-syncs cannot remove it); during a rotation the outgoing value sits in `COMP_ORIGIN_AUTH_PREVIOUS` until retired. `deploy.sh <sha>`: for each service, check `docker buildx imagetools inspect` reports `linux/arm64` for the tag (abort otherwise), clone the running task definition, swap only the image, register, `update-service --force-new-deployment`, and `aws ecs wait services-stable`.
- [ ] **Step 4: Run** tests (PASS), `ecs-up.sh --dry-run`, then for real after Kyle confirms, then `deploy.sh <sha from Task 5>`. Verify: all three services `RUNNING` with healthy targets; `curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.comp.revola.ai' https://revola-production-alb-1399285125.us-east-2.elb.amazonaws.com/ -k` prints `403`; the same with the origin header prints `200` or a redirect from the app.
- [ ] **Step 5: Commit** `feat(deploy): ecs services, target groups and alb rules for comp`.

### Task 8: Cloudflare DNS, origin header and Access

**Files:**
- Create: `deploy/aws/cloudflare.ts`, `deploy/aws/cloudflare.test.ts`, `deploy/aws/access-bypass.ts`

**Interfaces:**
- Consumes: ACM validation CNAME (Task 7), `COMP_ORIGIN_AUTH` read from `comp/production/origin-auth` with `aws secretsmanager get-secret-value` and never printed (Task 7), ALB DNS name.
- Produces: `ACCESS_BYPASS_PATHS: readonly { host: 'api.comp.revola.ai' | 'app.comp.revola.ai'; path: string }[]` = `api.comp.revola.ai/v1/internal/*`, `api.comp.revola.ai/v1/integrations/internal/*`, `api.comp.revola.ai/v1/integrations/sync/*`, `api.comp.revola.ai/v1/cloud-security/*`, `api.comp.revola.ai/v1/email/unsubscribe*`, `app.comp.revola.ai/api/revalidate/path` (the routes Trigger tasks and email recipients call, found with `grep` over `apps/*/src/trigger`).

- [ ] **Step 1: Write the failing tests**: the DNS records built are proxied CNAMEs for the three hosts to the ALB DNS name plus an unproxied validation CNAME; the request-header transform rule targets `http.host in {...}` for exactly the three hosts and sets `X-Comp-Origin-Auth`; the Access application covers `*.comp.revola.ai` with one Allow policy, `emails_ending_in: ['@revola.ai']`, Google as the only identity provider; each `ACCESS_BYPASS_PATHS` entry becomes its own Access application with a Bypass policy; no bypass covers `/` or `/api/auth/*`.
- [ ] **Step 2: Run** `bun test deploy/aws/cloudflare.test.ts`; confirm FAIL.
- [ ] **Step 3: Implement** `cloudflare.ts` (Cloudflare API with `CLOUDFLARE_API_TOKEN` scoped to Zone DNS edit, Zone Transform Rules edit, SSL and Certificates edit, Zone Settings read, Configuration Rules edit and Access edit for `revola.ai`, and `CLOUDFLARE_ACCOUNT_ID`, both supplied by Kyle; `--dry-run` prints the payloads with the header value redacted).
- [ ] **Step 4: Run** tests (PASS), then for real after Kyle confirms, in this order: validation CNAME, wait for ACM `ISSUED` and finish Task 7's listener step, transform rule, Access applications, then the three proxied CNAMEs last. Verify: `curl -sI https://app.comp.revola.ai` returns a redirect to `*.cloudflareaccess.com`; for every bypass path, an unauthenticated request returns that path's expected origin `4xx` from the API or app itself (not a Cloudflare page or the ALB's `403`).
- [ ] **Step 5: Commit** `feat(deploy): cloudflare dns, origin header and access for comp`.

### Task 9: Trigger.dev production deploy

**Files:**
- Create: `deploy/aws/trigger-env.ts`
- Modify: `deploy/aws/README.md` (section "Background jobs")

**Interfaces:**
- Consumes: Task 4 vendoring, Task 6 `secretsForService`.
- Produces: both Trigger projects deployed to `prod`; their prod environment variables set from `comp/production/config` (the keys from `triggerEnvKeys({ project })`: the matching ECS service's keys plus every key Trigger code reads) by `bun deploy/aws/trigger-env.ts --project <app|api>` using `envvars.upload` from `@trigger.dev/sdk`, printing key names only.

- [ ] **Step 1: Kyle creates prod secret keys** for `comp-app` and `comp-api` in the Trigger.dev dashboard and passes them to Task 6's sync.
- [ ] **Step 2: Run** `bun deploy/aws/trigger-env.ts --project api --dry-run` and `--project app --dry-run`; expect env-name lists equal to `triggerEnvKeys({ project })` for `api` and `app`.
- [ ] **Step 3: Upload env, then deploy** (after Kyle confirms): run `trigger-env.ts` for both projects without `--dry-run`, then `cd apps/api && bunx trigger.dev@4.4.3 deploy --env prod` and the same in `apps/app` (the order `trigger-deploy.sh` uses).
- [ ] **Step 4: Verify** from the hosted app with every laptop's `trigger dev` stopped: regenerate one policy; the run completes in the Trigger.dev `prod` dashboard and the policy content updates in the app.
- [ ] **Step 5: Commit** `feat(deploy): trigger.dev production environment for comp`.

### Task 10: Third-party settings, acceptance and docs

**Files:**
- Create: `docs/self-hosting-aws.md`
- Modify: `docs/self-hosting-local.md` (link to the hosted setup; colleagues no longer need a local stack to use Comp), `deploy/aws/README.md`, `docs/specs/2026-10-05-aws-hosting-design.md` (section 3.3 rule priorities; section 3.5 only if CEO-E7 is approved)

- [ ] **Step 1: Kyle updates** the Google OAuth client (origins `https://app.comp.revola.ai`, `https://api.comp.revola.ai`; redirect `https://api.comp.revola.ai/api/auth/callback/google`) and turns on Supabase Enforce SSL (the Supabase plan itself is chosen before Task 7, CEO-T2).
- [ ] **Step 2: Run the spec's acceptance criteria 1 to 7** and record each result (command or browser action, observed outcome) in `docs/self-hosting-aws.md` under "Acceptance, 2026-10-xx". Criterion 7: `scripts/local-run.sh build && start` still works against the shared state.
- [ ] **Step 3: Write `docs/self-hosting-aws.md`**: architecture, how to release a commit (CodeBuild build, migrations first when the commit adds any, `deploy.sh <sha>`, then `trigger-deploy.sh <sha>`), how to roll back (`deploy.sh <previous sha>` and `trigger-deploy.sh <previous sha>`), how to add a colleague or an auditor (Access policy plus People invite), where logs are, and the monthly cost from AWS pricing checked on the day.
- [ ] **Step 4: Run** `bun test deploy/aws` and the Task 1 and Task 2 suites once more; all PASS.
- [ ] **Step 5: Commit** `docs(self-host): hosted comp on aws runbook and acceptance record`.

<!-- autoplan-accepted:ceo -->
- CEO-PLACE Task placement and order: CEO-E1 and CEO-R1 join Task 1 (API auth and health, same TDD steps; Task 1's Files list gains `apps/api/src/auth/email-domain-allowlist.ts`, its spec, `apps/api/src/health/health.controller.ts` and its spec; commit `feat(api): self-host auth config, sign-up allowlist, readiness probe and proxy-aware rate limits`); CEO-2's code helpers, CEO-3b and CEO-S1 land as a new Task 2b "Server-side API base URL, revalidation host and dev schedules" (failing tests, run, implement, run, commit `fix(app): server-side api base url, revalidation host and dev schedule guard`) before Task 3 builds images; CEO-P1 lands in Task 4 (database package); CEO-3, CEO-OV, CEO-OA and CEO-ENV extend Task 6; CEO-4, CEO-PF, CEO-PUB, CEO-TLS and CEO-A8 extend Task 8; CEO-O1 is a Task 10 step; CEO-RL joins Task 1; CEO-E7 extends Task 5; CEO-2's infra, CEO-E2, CEO-E3, CEO-E4 and CEO-E9 extend Task 7; CEO-T1 extends Task 9; CEO-T2's Supabase plan decision moves from Task 10 Step 1 to before Task 7; CEO-5 and CEO-TLS run in Task 8 Step 4. Each extension keeps the task's failing-test, run, implement, run, commit sequence.
- CEO-2 Internal API route for server-side calls (taste under UC1 option B, required under option A): rationale independent of UC1 is that server-side calls forward users' session cookies, and routing them through NAT, the public internet and Cloudflare adds latency, NAT data charges and an edge dependency for internal traffic. Task 7 creates a Cloud Map HTTP namespace `comp.internal` and enables ECS Service Connect on the three services (api as server with discovery name `comp-api` and client alias `comp-api.comp.internal:3333`; app and portal as clients). `renderTaskDefinition` gives the api container a named port mapping (`name: 'api'`, `appProtocol: 'http'`) and the test asserts it. `comp-tasks-sg` also allows 3333 from itself. `BACKEND_API_URL=http://comp-api.comp.internal:3333` is an override for app and portal only. Helpers `apps/app/src/lib/server-api-base-url.ts` and `apps/portal/src/app/lib/server-api-base-url.ts` export `getServerApiBaseUrl()` (returns `BACKEND_API_URL`, else `NEXT_PUBLIC_API_URL`, else `http://localhost:3333`; empty string counts as unset). Every server-only API caller uses it: app (8) `lib/api-server.ts`, `lib/server-api-client.ts`, `utils/auth.ts`, `app/api/training/certificate/route.ts`, `app/api/offboarding-export/route.ts`, `people/[employeeId]/actions/download-training-certificate.ts`, `people/[employeeId]/actions/download-hipaa-certificate.ts`, `policies/[policyId]/editor/tools/policy-tools.ts`; portal (6) `app/lib/auth.ts`, `app/api/auth/get-session/route.ts`, `app/api/device-agent/proxy.ts`, `app/api/portal/complete-training/route.ts`, `documents/[formType]/page.tsx`, `documents/[formType]/submissions/page.tsx`. Browser modules (`auth-client.ts`, `api-client.ts`, `evidence-download.ts`, `hooks/use-training-completions.ts`, `auth/device-callback/page.tsx`) keep `NEXT_PUBLIC_API_URL`. Tests: vitest per helper (set, unset, empty); a guard test per app scans files outside `src/trigger` that are server-only by marker (`'use server'`, a `route.ts`, `import 'server-only'`, an import of `next/headers`, or a `page.tsx`/`layout.tsx` without `'use client'`) and fails if any reads `NEXT_PUBLIC_API_URL` directly. Verify after deploy: render one server page that fetches API data and confirm the `AWS/ECS` Service Connect `RequestCount` metric for discovery name `comp-api` increases.
- CEO-OV Per-service overrides: `PRODUCTION_OVERRIDES` becomes `overridesForService({ service })` returning only that service's non-secret values, rendered as task-definition `environment` entries (never stored in `comp/production/config`, so per-service values such as `DATABASE_POOL_MAX` can differ); `triggerOverrides({ project })` is the Trigger counterpart and holds the public URL keys from CEO-3 plus the per-run `DATABASE_POOL_MAX`; `renderTaskDefinition`'s test asserts overrides appear only under `environment` and secrets only under `secrets`; `BACKEND_API_URL` is app and portal only; `AUTH_ALLOWED_EMAIL_DOMAINS`, `AUTH_COOKIE_DOMAIN` and `AUTH_TRUSTED_ORIGINS` are api only. Test: each key's service set is exactly as listed, and `BACKEND_API_URL` never appears in `triggerEnvKeys`.
- CEO-3 Trigger env derived from code: `deploy/aws/trigger-env-keys.ts` exports `triggerEnvKeys({ project })` = the matching service's secret and override keys plus the scanned reads (every `process.env.X` read directly under `apps/<project>/src/trigger`, `apps/<project>/trigger.config.ts` and the project's Trigger extensions, minus `TRIGGER_*` names Trigger provides), minus app-only internal keys (`BACKEND_API_URL`). Non-tautological test: every scanned read must be in `SECRET_KEYS`, `triggerOverrides({ project })`, or an explicit `INTENTIONALLY_UNSET` list with a one-line reason per key (for example `RESEND_TO_TEST`); `SECRET_KEYS` gains the scanned production keys that have values today (`FIRECRAWL_API_KEY`, `NOVU_API_KEY`, `BACKGROUND_CHECK_API_KEY`, `BROWSER_AUTOMATION_*`, `RESEND_FROM_*`, `APP_AWS_*_BUCKET`, `VERCEL_*` and any other the scan finds), each decided by Kyle in Task 6 Step 4 as set or intentionally unset. `trigger-env.ts` fails, naming the key, when a key in the set has no value in `comp/production/config`. URL keys resolve to public origins because Trigger workers run outside the VPC: `BASE_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `API_BASE_URL`, `API_URL`, `NEXT_PUBLIC_API_URL` = `https://api.comp.revola.ai`; `NEXT_PUBLIC_APP_URL` = `https://app.comp.revola.ai`; `NEXT_PUBLIC_PORTAL_URL` = `https://portal.comp.revola.ai`.
- CEO-3b Revalidation host fix: the six app Trigger call sites that build the revalidation URL, the two `onboard-organization*.ts` calls that pass `${BETTER_AUTH_URL}/${orgId}` as the revalidation `path` (must be `/${orgId}`), and `apps/app/src/lib/unsubscribe.ts`'s base URL (must be `NEXT_PUBLIC_APP_URL`, since `/unsubscribe/preferences` is an app page) are fixed; the call sites that build `${NEXT_PUBLIC_BETTER_AUTH_URL}/api/revalidate/path` or `${BETTER_AUTH_URL}/api/revalidate/path` call `getRevalidateUrl()` from new `apps/app/src/trigger/lib/revalidate-url.ts`, which reads `NEXT_PUBLIC_APP_URL` and throws a named error when it is unset. Vitest: set returns `https://app.comp.revola.ai/api/revalidate/path`; unset throws; trailing slash normalized; a scan test fails if any trigger file still joins `BETTER_AUTH_URL` with `/api/revalidate`.
- CEO-S1 Dev schedules do not double-fire on the shared database: new `apps/{api,app}/src/trigger/lib/schedule-guard.ts` exports `shouldRunScheduledTask({ environmentType, env })`, true only for `PRODUCTION`; `DEVELOPMENT`, `STAGING` and `PREVIEW` return false unless `COMP_RUN_SCHEDULES_IN_DEV=true`; every `schedules.task` run function returns early (logging the skip) when it is false. Tests: the guard's truth table, and a scan test that fails when a `schedules.task` file does not call the guard. `docs/self-hosting-local.md` states that local `trigger dev` skips schedules by default.
- CEO-4 Bypass coverage: `cloudflare.test.ts` scans code (comments stripped) under `apps/{api,app}/src/trigger` for the URL argument of `fetch(...)`, `axios.<method>(...)` and an allowlist of wrapper helpers (`getApiBaseUrl`, `sendEmailViaApi`, `apiResponse` and any others the implementer finds, listed in the test); a base expression `process.env.X || '<literal>'` counts as `process.env.X`; the base must be one of `API_BASE_URL`, `API_URL`, `BASE_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `params.apiUrl` or an allowlisted helper's return; a request URL whose base the scan cannot resolve fails the test. URLs that only appear in email bodies or links are not requests and are not scanned. App-host paths must always be covered by an app-host bypass (Access protects the app under both UC1 options); API-host paths must be covered only under UC1 option A. Third-party hosts are ignored. Task 8's list gains `api.comp.revola.ai/v1/integrations/connections/*/ensure-valid-credentials` (option A).
- CEO-PUB External callers, decided explicitly: under UC1 option A these `@Public()` or third-party-called routes stay behind Access and are documented in `docs/self-hosting-aws.md` as unsupported, with the reason, unless Kyle names one in use: `/v1/billing/webhook` (no billing when self-hosted), `/v1/people/webhook` and `/v1/background-checks/*` webhooks (no background-check vendor), `/v1/security-penetration-tests/webhook` (no pentest vendor), integration-platform webhook routes, `/v1/device-agent/exchange-code` and `/v1/device-agent/updates/*` (no device agent rollout), `/v1/questionnaire/parse/upload/token`, `/mcp/download`, `/v1/trust-access/*` (no public trust portal). Under option B they are reachable through Cloudflare with their own checks, and the doc says so.
- CEO-PF Access preflights (option A only): the API Access application sets `options_preflight_bypass: true`, and `cloudflare.test.ts` asserts it.
- CEO-TLS Edge certificate for second-level hosts: Cloudflare Universal SSL does not cover `*.comp.revola.ai` (Cloudflare docs: deeper subdomains "will not serve a valid certificate"). Task 8, before the proxied CNAMEs, orders an Advanced Certificate Manager edge certificate for `*.comp.revola.ai` (Kyle confirms the about $10 per month, or reuses the zone's existing ACM subscription) and checks the zone SSL mode is Full (strict). Verify: `curl -sv https://app.comp.revola.ai` completes the handshake with a certificate whose SAN includes `*.comp.revola.ai`. Task 10's cost section includes it.
- CEO-5 Cross-host browser acceptance: Task 8 Step 4, right after the proxied CNAMEs go live, runs "fresh browser profile, sign in at `https://app.comp.revola.ai`, the dashboard loads API data without visiting `https://api.comp.revola.ai` directly", plus the same for the portal, and records the result in `docs/self-hosting-aws.md`. Cutover means announcing the hosted URL to colleagues and merging Task 10's change to `docs/self-hosting-local.md`; a CEO-5 failure blocks cutover until the Access design is fixed.
- CEO-E1 Sign-up domain allowlist: new `apps/api/src/auth/email-domain-allowlist.ts` exports `parseAllowedDomains({ env })` (reads `AUTH_ALLOWED_EMAIL_DOMAINS`, comma-separated, lowercased, `@` stripped), `isEmailAllowed({ email, allowedDomains, hasPendingInvitation })`, and `createEmailDomainAllowlistHook({ env, db })`, which returns the `databaseHooks.user.create.before` handler; `auth.server.ts` gains only the import and one `databaseHooks.user.create.before` entry calling the factory. The handler throws `APIError('FORBIDDEN')` naming the domain when the email's exact domain is not listed and no invitation exists for that email with `status = 'pending'` and `expiresAt` in the future (Prisma lookup scoped by email; jest adds expired and accepted invitations as rejected cases). Unset or empty allows everyone. Jest `email-domain-allowlist.spec.ts`: listed domain allowed; other domain rejected; `Person@Revola.AI` normalized and allowed; `x.revola.ai` rejected unless listed; invited outside email allowed; unset allows all; malformed email rejected. The api override is `AUTH_ALLOWED_EMAIL_DOMAINS=revola.ai`; the runbook's "add an auditor" is an Access policy entry plus a People invite.
- CEO-R1 Database readiness probe: new `@Public()` `GET /v1/health/ready` in the API health controller runs `SELECT 1` with a 2-second timeout and returns `200 {status:'ok'}` or `503 {status:'unavailable', reason}` with no connection details, where `reason` is the Prisma error code when present (for example `P1011`), else `ca_file_missing` for the resolver's missing-CA error, else `timeout`, else `unknown`. The Task 3 negative smoke container runs with `-e DATABASE_SSL_CA=` and `-e PRISMA_ALLOW_INSECURE_TLS=` explicitly emptied. The ALB target group keeps `/v1/health` (liveness), so a database outage does not cycle healthy tasks. The Task 3 image smoke and the CEO-E4 smoke call `/v1/health/ready`. Jest: ok, timeout, Prisma-coded and missing-CA cases map to `200`, `503 timeout`, `503 P1011` and `503 ca_file_missing`. Review Focus 4 is narrowed accordingly (baseline edit).
- CEO-P1 Database pool size: `packages/db/src/client.ts` passes `max` from `DATABASE_POOL_MAX` (integer 1 to 50, validated with zod, default unchanged when unset) to `PrismaPg`. Test: set, unset and invalid values. Per-service overrides set it (values from CEO-T2).
- CEO-T2 Connection budget: before Task 7, Kyle picks the Supabase plan (moved from Task 10 Step 1); the implementer records in `docs/self-hosting-aws.md` the session pooler's limit for that plan, each consumer's pool (`DATABASE_POOL_MAX` per ECS service, Trigger prod concurrency per project times the per-run pool, and two local stacks) and sets the overrides and the Trigger `prod` environment concurrency limit (set by Kyle in the Trigger.dev dashboard per project, recorded in the doc) so the sum stays under the limit. Verify: Supabase's connection count stays under the limit during Task 9's policy regeneration.
- CEO-OA Origin header in its own secret: `COMP_ORIGIN_AUTH` and `COMP_ORIGIN_AUTH_PREVIOUS` live in a separate secret `comp/production/origin-auth`, so `sync-secrets.ts` re-syncs of `comp/production/config` cannot remove them; `deploy.sh` and `cloudflare.ts` read it with `aws secretsmanager get-secret-value` into a variable that is never printed (`cloudflare.ts --dry-run` redacts it). Test: `sync-secrets.ts` refuses to write any `COMP_ORIGIN_AUTH*` key.
- CEO-E2 Alarms (no cluster-wide change): `ecs-up.sh` creates SNS topic `comp-alerts` with an email subscription to an address Kyle supplies and confirms, and per service three alarms on `AWS/ApplicationELB` with dimensions `LoadBalancer` and `TargetGroup`: `HealthyHostCount` (statistic `Minimum`) `< 1` for 2 of 2 one-minute periods with `treat-missing-data breaching` (silence during an outage alarms), `UnHealthyHostCount > 0` for 5 of 5 and `HTTPCode_Target_5XX_Count > 10` summed over 5 minutes, both `notBreaching`. Container Insights on `revola-cluster` is unchanged. Verify: `aws cloudwatch describe-alarms --alarm-name-prefix comp-` lists 9 alarms in `OK` once targets are healthy; `aws cloudwatch set-alarm-state` on one alarm delivers an email.
- CEO-E3 Migration guard: new `deploy/aws/migration-guard.ts` exports pure `classifyMigrations({ inTree, applied })` returning `{ pending, extra }`; the CLI lists migration directory names at `<sha>` with `git ls-tree --name-only <sha> packages/db/prisma/migrations/` (no worktree), reads applied names from `_prisma_migrations` (`finished_at` not null, `rolled_back_at` null) over the verified-TLS connection with env sourced in a subshell (never printed), exits non-zero listing `pending`, and warns on `extra` (rollback or a colleague's branch on the shared database). `deploy.sh <sha>` runs it before any `update-service`; `--skip-migration-check` prints a warning and is for outages only. The tree listing uses `git ls-tree -d --name-only <sha> packages/db/prisma/migrations/` and basenames, so `migration_lock.toml` is never counted. Tests: `classifyMigrations` cases (none, pending, extra, both) plus a listing fixture containing `migration_lock.toml`.
- CEO-E4 Post-deploy smoke: after `services-stable`, `deploy.sh` reads the origin header value (CEO-OA) and runs `curl --connect-to <host>:443:revola-production-alb-1399285125.us-east-2.elb.amazonaws.com:443` with the header against `/v1/health/ready` (api) and `/api/health` (app, portal), so SNI and certificate checks use the real host; one pass/fail line per service; failure exits non-zero and prints the rollback command with the previous tag from the old task definition. The first `deploy.sh` in Task 7 runs with `--skip-smoke` (warned; allowed only while the listener has no `*.comp.revola.ai` certificate), and Task 8 Step 4 reruns the smoke after the certificate is attached.
- CEO-E3/E4 tests: `deploy/aws/tests/deploy.test.sh` puts stub `aws`, `docker`, `bun`, `git` and `curl` on `PATH` and asserts: a pending-migration result exits non-zero before any `aws ecs update-service`; an extra-migration result warns and continues; a wrong-arch manifest aborts; a failed smoke exits non-zero and prints the rollback tag; `--skip-smoke` is refused when the stubbed listener lists the certificate; the header value never appears in stdout or stderr. Functions are called as plain statements, not inside `&&` lists (prior learning: errexit is disabled there).
- CEO-E7 Build on merge (taste, provisional until the final gate): if approved, `provision-build.sh` adds a CodeBuild webhook filter for pushes to `revola/self-host` (deploys stay manual) and Task 10 updates spec section 3.5; if rejected, neither the webhook nor the spec edit is made. Verify: a push produces a `comp-images` build whose source version equals the pushed SHA.
- CEO-E9 Origin header rotation: `buildListenerRules` takes `originHeaderValues` (one or two values) and the test asserts both appear in each host rule's header condition. Rotation, run by Kyle in one session: `ecs-up.sh --rotate-origin-header` moves the current value to `COMP_ORIGIN_AUTH_PREVIOUS`, writes a new `COMP_ORIGIN_AUTH`, and updates the rules to accept both; `bun deploy/aws/cloudflare.ts --rotate-origin-header` switches the transform rule; an edge probe through Cloudflare then must get the origin's own response, not the ALB's `403` (option B: `https://api.comp.revola.ai/v1/health`; option A: an unauthenticated request to the bypassed `https://api.comp.revola.ai/v1/email/unsubscribe` must return the API's own 4xx); only then `ecs-up.sh --retire-origin-header` drops the previous value. Documented in `docs/self-hosting-aws.md`.
- CEO-T1 Trigger release path: new `deploy/aws/trigger-deploy.sh <sha>` refuses unless the working tree is clean and `HEAD` equals `<sha>`, runs `bun install --frozen-lockfile` and builds `packages/db` at that SHA, runs `trigger-env.ts` for both projects (failing on a missing value), then `bunx trigger.dev@4.4.3 deploy --env prod` in `apps/api` and `apps/app`. `deploy.sh` ends by printing the matching `trigger-deploy.sh <sha>` command; the runbook's release and rollback both run it at the same SHA.
- CEO-O1 Deferred follow-ups filed: Task 10 adds a step that opens GitHub issues on `revola-ai/comp` (after Kyle confirms) for IaC for `deploy/aws` (P3), a staging environment with its own Supabase project (P2), migrations as an ECS task (P3), and the fleet GitHub OIDC repair (P2, cross-repo).
- CEO-F1 Factual corrections, applied in place to Tasks 1, 4, 6, 10 and Review Focus 4: Task 1's second test case is stated concretely; Task 4 lists `apps/app/caBundleExtension.ts`; Task 6 Step 4 records that `ecsTaskExecutionRole` already reads `secret:*` and that this broad scope is a known risk; Task 10 lists the spec file and updates spec section 3.3's "priorities 5 to 36" to "5 to 62"; Review Focus 4 names the readiness probe instead of health checks.
- CEO-ENV ECS env coverage: a test per ECS service scans `process.env.X` reads in `apps/<service>/src` (outside `src/trigger`) and in the workspace packages that service bundles (`packages/email`, `packages/auth`, `packages/db`), and fails unless each is in that service's secrets, `overridesForService`, or `INTENTIONALLY_UNSET` with a reason. The api overrides gain `NEXT_PUBLIC_PORTAL_URL=https://portal.comp.revola.ai` and `NEXT_PUBLIC_BETTER_AUTH_URL=https://api.comp.revola.ai`; `TRUST_APP_URL` and `MCP_RESOURCE_URL` are set or listed as intentionally unset by Kyle. Without this, `people-invite.service.ts:681` sends employees to `portal.trycomp.ai`.
- CEO-RL Proxy-aware rate limiting: the API sets Express `trust proxy` to the number of proxy hops it sits behind (ALB, plus Envoy for Service Connect callers) and a custom `ThrottlerGuard` tracker keys requests on `CF-Connecting-IP` when present, else the client entry of `X-Forwarded-For`, else `req.ip`; requests authenticated by a valid service token or `INTERNAL_API_TOKEN`, and Service Connect calls from app and portal (which forward the end user's `X-Forwarded-For`), are keyed per caller identity rather than sharing one bucket. Jest: two different `CF-Connecting-IP` values get separate buckets; a missing header falls back; a service-token caller is not limited with users. CEO-5 adds a burst check: 30 page loads in a minute from one browser produce no `429`.
- CEO-A8 Task 8 in both UC1 variants: option A (original) creates one Access application for `app.comp.revola.ai` and `portal.comp.revola.ai` plus a separate application for `api.comp.revola.ai` with `options_preflight_bypass: true` (CEO-PF), and the API-host bypass list; option B creates Access applications for `app.comp.revola.ai` and `portal.comp.revola.ai` only, and `ACCESS_BYPASS_PATHS` holds only app-host entries (`/api/revalidate/path`). `cloudflare.test.ts` takes the option as a parameter and asserts the matching configuration; in both, no bypass covers `/` or `/api/auth/*`. Under option A the cloud-security bypass narrows to the paths Trigger calls (`/v1/cloud-security/scan/*`, `/detect-services/*`, `/resolve-session/*`, `/remediation/preview`, `/remediation/execute`).
- CEO-BX Bypass verification: for each bypass path, the expected response is defined per path in the test fixture and must be served by the origin (any `4xx` whose body is the API's or app's JSON, never a Cloudflare page or the ALB's `403` body); Review Focus 3 and Task 8 Step 4 use that definition.
- CEO-UP `ecs-up.sh` re-runs: on first run it registers each task definition from `renderTaskDefinition` with the image tag passed as `--image-tag <sha>` (from Task 5's build); on a re-run it re-renders each task definition with the image currently running, registers it, and calls `update-service` with the rendered Service Connect configuration, so new secret mappings, overrides and port names reach running services; `deploy.sh` keeps cloning the running task definition for image-only releases.
- CEO-TAG Image tag length: CodeBuild, `deploy.sh`, `trigger-deploy.sh` and the runbook all use `git rev-parse --short=12`; `buildspec.yml` derives it from `CODEBUILD_RESOLVED_SOURCE_VERSION` truncated to 12 characters, and `deploy.sh` rejects a tag that is not 12 hex characters.
- CEO-CF Cloudflare token and SSL mode: the token adds SSL and Certificates edit and Zone Settings read; if the zone's SSL mode is not Full (strict), `cloudflare.ts` adds a Configuration Rule scoped to `http.host in {the three hosts}` setting SSL Full (strict), never changing the zone-wide setting.
- CEO-V1 Recovery gate before cutover: Supabase Pro (or higher) is active before Task 7, point-in-time recovery is evaluated and its decision recorded, and a restore drill restores the database and a sample of Storage objects into an isolated Supabase project, then proves one evidence file opens and one integration credential decrypts with the production `ENCRYPTION_KEY`. `docs/self-hosting-aws.md` records RPO, RTO, the drill date and steps, and how `ENCRYPTION_KEY`, `SECRET_KEY` and the Storage bucket are backed up outside Supabase. A failed drill blocks cutover.
- CEO-V2 Dedicated execution role: `ecs-up.sh` creates `comp-task-execution-role` (ECR pull for the three repos, CloudWatch Logs for `/ecs/comp-*`, `secretsmanager:GetSecretValue` on `comp/production/*` only) and `renderTaskDefinition` uses it; the test asserts the role name; the shared `ecsTaskExecutionRole` is not used by Comp. This supersedes the plan's `ecsTaskExecutionRole` constraint for Comp tasks.
- CEO-V3 Release record: `deploy.sh` and `trigger-deploy.sh` each append to `docs/releases/<YYYY-MM-DD>-<sha>.json` (committed by the operator) the image digests, registered task definition ARNs, Trigger deployment versions, Secrets Manager version IDs of `comp/production/config` and `comp/production/origin-auth`, and the latest applied migration name; rollback instructions cite the record. Test: the writer produces every field from stubbed inputs and refuses to write without digests.
- CEO-V4 Workflow acceptance: Task 10's acceptance adds employee policy acknowledgment in the portal, an auditor invited with a restricted role who can read but not change evidence, an evidence export, and offboarding: after a member is removed in People and from Access, their existing session cookie, any API key they created and their portal session all get `401`/`403` on direct API calls (tested from a non-browser client, which matters under UC1 option B).
- CEO-V5 Regions and latency: `docs/self-hosting-aws.md` records the Supabase and Upstash regions; acceptance records p95 latency of `/v1/health/ready` and one authenticated list call from the ECS task; if the database is not in `us-east-2`, the doc states the measured cost and the option to move.
- CEO-V6 Data boundary record: `docs/self-hosting-aws.md` lists each processor (Supabase, Upstash, Trigger.dev cloud, Gemini, OpenAI, Resend, Firecrawl, Browserbase, Cloudflare, AWS), the data classes it sees, and its log retention; it notes that `apps/api/src/trigger/policies/update-policy-prompts.ts:20-25` logs company context and policy content to Trigger.dev logs (scrubbing is a filed follow-up).
- CEO-V7 Migration compatibility rule: `docs/self-hosting-aws.md` states that migrations must stay compatible with the previous release (expand, release, then contract in a later release), so `deploy.sh <previous sha>` stays valid for one release; a release that breaks this is marked forward-fix-only in its release record.
- CEO-V8 Build-context drift test: a test derives the `@trycompai/*` workspace packages `apps/api` depends on (from its `package.json`, transitively) and fails if `assemble-api-context.sh`'s package list differs.
- CEO-V9 Environment-bound images: images carry `NEXT_PUBLIC_*` values for one environment; the bake file names the environment in the tag suffix only when a second environment exists, and the runbook says images are not promotable across environments.
- CEO-S2 Deploy safety additions: `deploy.sh` takes a lock (SSM parameter `comp/deploy-lock` holding owner and expiry; refuses when held and unexpired; releases on exit), and on a `services-stable` timeout prints the last 10 service events and each stopped task's `stoppedReason`; `deploy.test.sh` covers both. CEO-E2 adds a tenth alarm on the `AWS/ECS` Service Connect `HTTPCode_Target_5XX_Count` for `comp-api`.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- DX-FOLD Plan consolidation before execution: after the final gate decides UC1 to UC4 and the taste items, every accepted CEO and DX obligation is folded into its task's Files, Interfaces, steps and commit; superseded text (for example `PRODUCTION_OVERRIDES`, `ecsTaskExecutionRole` for Comp, the wildcard Access test, the 7-character tag, Review Focus 4's "TLS error class") is deleted; Task 2b becomes a numbered task; Global Constraints match. A "Decisions" table at the top lists each gate decision, its answer and the tasks it changes. Verify: a reviewer reading any single task sees no instruction that another section overrides.
- DX-PRE Shared config and preflight: `deploy/aws/config.ts` (zod-validated constants: account, region, cluster, ALB, SG, VPC, subnets, hosts, Trigger CLI version read from `apps/*/package.json`, UC1 option) and a generated `deploy/aws/config.env` for shell scripts; every script first runs a preflight that checks `aws sts get-caller-identity` returns account `455986776194` and region `us-east-2` ("wrong AWS account X, expected 455986776194; set AWS_PROFILE=..."), required tools and versions (aws v2, bun, git, curl), and for Cloudflare and Trigger steps the token or login. Test: stubbed wrong account exits non-zero before any mutating call.
- DX-REL One release entry point: `deploy/aws/release.sh` with subcommands `preflight`, `status`, `release <ref>`, `rollback [<release-id>]`, `restart [--service X]`, `logs <service>`. `release` resolves the ref to a 12-character SHA, starts or reuses the CodeBuild build and waits, verifies all three ECR tags and their `linux/arm64` manifests through `aws ecr batch-get-image` (no Docker), takes the release lock, runs the migration guard, `deploy.sh`, the smoke, and `trigger-deploy.sh` (from a temporary worktree under `.worktrees/release-<sha>` so the operator's checkout is untouched), records stage timings, and prints the summary. Errors name the stage, cause, resource, next command and whether retry is safe. Test: `release.test.sh` with stubs covers success, missing tag, failed guard, failed smoke and resume.
- DX-MIG Migration command and stronger guard: `deploy/aws/migrate.ts --sha <sha>` applies migrations from that SHA's tree (extracted with `git archive` into a temp dir outside the repo, run with the main checkout's pinned Prisma) using `DATABASE_URL` read from `comp/production/config` (never local env files, never printed); the guard also fails on `_prisma_migrations` rows that are started but unfinished and not rolled back, and on a checksum mismatch between the applied row and `sha256` of that SHA's `migration.sql`; its pending-migration message prints the exact `migrate.ts` command. Tests: wrong-target host refused, failed row, modified migration, lock file ignored.
- DX-REC Release records outside the checkout: CEO-V3 records go to an S3 bucket `comp-release-records-455986776194` (versioned, created by `ecs-up.sh`), written once after both ECS and Trigger stages finish, plus a partial record when a stage fails; `release.sh status` and `rollback` read them. This replaces CEO-V3's `docs/releases/` path.
- DX-RB Rollback restores configuration: task definitions reference secrets with pinned version IDs (`<arn>:KEY::<version-id>`); `release.sh rollback` calls `update-service` with the previous record's task definition ARNs (immutable revisions) instead of cloning and swapping, and redeploys Trigger at the previous SHA with the previous record's env snapshot; a record marked forward-fix-only (CEO-V7) makes rollback refuse with an explanation. ECR lifecycle keeps every image referenced by the last 10 records. Test: release with a config change, then rollback restores the prior task definition ARN.
- DX-RST Secret change path: `release.sh restart [--service X]` re-renders task definitions with the latest secret version IDs (CEO-UP logic), deploys them, runs the smoke, and re-uploads Trigger env with `trigger-env.ts` run standalone; runbook recipe "change a secret" is sync, then restart.
- DX-SVC Partial deploys and lock: `--service api|app|portal` (repeatable) and `--project api|app`; the release record lists what changed; one lock covers the whole `release.sh` run with a 30-minute TTL refreshed while waiting; a held lock prints owner, expiry and `release.sh --break-lock` (confirmed and logged).
- DX-HATCH Incident hatch: `--skip-smoke --reason "<text>"` is allowed at any time with a loud warning and the reason stored in the release record; `--smoke=liveness` uses `/v1/health` and `/api/health/live`. Supersedes CEO-E4's certificate-only restriction (the certificate check stays the default behaviour).
- DX-LIVE App liveness: new dependency-free `apps/app/src/app/api/health/live/route.ts` (like Task 2's portal route) is the ALB target-group health path for the app; the existing `/api/health` (`SELECT 1`) becomes the app's readiness check used by the smoke. Test mirrors Task 2's.
- DX-TRIG Reproducible Trigger builds: `trigger-deploy.sh` builds every package the Trigger extensions require (`packages/db`, `packages/email`, `packages/integration-platform`, by turbo filter) in the temporary worktree; `caBundleExtension` uses the committed Supabase CA and no longer requires the untracked `packages/db/certs/rds-global-bundle.pem`; the script prints the Trigger project ref and environment before uploading. Upstream's `.github/workflows/trigger-*-deploy-*.yml` are disabled on the fork and `deploy:trigger-prod` scripts call `trigger-deploy.sh`. Test: preparation from a fresh worktree with no `dist` and no local certificates succeeds.
- DX-SYNC Safe secret sync: each `SECRET_KEYS` entry maps to exactly one source env file; disagreement between files fails naming key and files (never values); a missing key fails with "KEY not found in <file>; add it or list it in INTENTIONALLY_UNSET"; before writing, a name-only diff (added, removed, changed by hash) prints and removal requires confirmation.
- DX-GATE Repo gates cover deploy code: `deploy/aws` becomes a workspace (`package.json` with zod and `@trigger.dev/sdk`, `tsconfig`, `typecheck`, `lint` with shellcheck, `test` running bun tests and the shell tests); `packages/db`'s test script includes `scripts`; `.github/workflows/check-types.yml` calls the existing `typecheck:ci` (today it calls a missing `type-check:ci`). Verify: `bun run typecheck` and `bun run test` from the root include `deploy/aws`.
- DX-GUARD Production database footgun: `packages/db` scripts refuse `prisma migrate dev`, `migrate reset` and `db:seed` when the `DATABASE_URL` host matches the production pooler host recorded in `deploy/aws/config.ts`, unless `COMP_I_AM_TOUCHING_PROD=1`; `docs/self-hosting-local.md` states prominently that local runs write production data until UC2 is resolved. Test: guarded and opted-in cases.
- DX-COL Colleague path: `docs/self-hosting-local.md` gains "Using hosted Comp" (URL, why two Google sign-ins, wait for the invite email and do not create an organization, portal URL, support contact); the runbook says colleagues are invited in People first, and Access entries are only for people outside `@revola.ai`; the app shows "Sign-ups are limited to revola.ai; ask an admin for an invite" when CEO-E1 rejects a sign-up.
- DX-DOC Documentation layout: `deploy/aws/README.md` is the operator runbook (prerequisites, bring-up order, release, rollback, single-service deploy, secret change, rotation, add user or auditor, break lock, logs with exact `aws logs tail` commands, troubleshooting table: ALB 403, Access CORS, lost session, readiness 503 codes, exec format error, Service Connect name, 429s, Trigger missing env); `docs/self-hosting-aws.md` holds architecture and decisions; acceptance evidence lives in its own dated file; the root README's "coming soon" deployment section links to both.
- DX-ORDER Bring-up order: the runbook opens with the phase list (decisions, tokens, Supabase gate, build, secrets, ECS without listener rules, validation and ACM, listener rules and smoke, edge, Trigger, acceptance), each with its prerequisites and outputs, and `ecs-up.sh` is resumable by phase (`--phase <name>`), exiting with the next command when it waits on ACM validation.
- DX-403 ALB 403 body: the priority-4 fixed response returns `text/plain` "comp-alb: origin header missing or invalid"; the listener-rules test asserts it and CEO-BX's fixture matches against it.
- DX-ERR Named error texts: `getCookieDomain` errors include an example and the variable's source; the wrong-arch abort prints found and expected platforms and "rebuild with release.sh"; tests assert those texts.
- DX-TIME Measurement: release records carry stage timings and hands-on prompts; acceptance includes a second engineer completing a release from the runbook, with hands-on and wall-clock time recorded.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- ENG-1 DX-FOLD is a hard gate: no task starts until the fold is done; a check (`deploy/aws/tests/plan-lint.test.ts` or a script in the workspace) fails if the plan still contains superseded identifiers (`PRODUCTION_OVERRIDES`, `ecsTaskExecutionRole` for Comp tasks, `docs/releases`, `--short HEAD`, Review Focus 4's "TLS error class").
- ENG-2 Cookie domain coverage: `getCookieDomain` requires `AUTH_COOKIE_DOMAIN` to cover the hosts of `BASE_URL`, `NEXT_PUBLIC_APP_URL` (or `APP_URL`) and `NEXT_PUBLIC_PORTAL_URL` (or `PORTAL_URL`) using `host === d.slice(1) || host.endsWith(d)`; throws when set while `BASE_URL` is missing or unparseable; rejects domains with fewer than three labels unless `AUTH_COOKIE_DOMAIN_ALLOW_BROAD=1`. Jest adds `.api.comp.revola.ai` (rejected: app not covered), `.revola.ai` (rejected), missing `BASE_URL` (throws).
- ENG-3 One database connection policy: `packages/db` exports `buildPgAdapterOptions({ databaseUrl, env })` used by `packages/db/src/client.ts` and `apps/{api,app,portal}/prisma/client.ts`; it applies `DATABASE_POOL_MAX` and a production TLS rule: when `NODE_ENV=production` and the host is not local, `DATABASE_SSL_CA` is required (or explicit `PRISMA_ALLOW_INSECURE_TLS=1`), otherwise it throws `ca_file_missing`. Readiness `reason` walks `err.cause` for a Node TLS `code` and returns `tls_<CODE>`, else a Prisma code, else `timeout` or `unknown`; the real Supabase error shape is captured once and used as the fixture. Supersedes CEO-P1's single-file scope and CEO-R1's `P1011` example.
- ENG-4 Image correctness: every runtime stage uses `node:22-slim`; build stages use `node:22-slim` with Bun copied from `oven/bun:1.3.4` and assert `node -v`; app and portal stages run the schema preparation `db:generate` path, set `SKIP_ENV_VALIDATION=1` for the build only, copy `.next/static` and `public/` into the standalone tree and set `HOSTNAME=0.0.0.0`; `.dockerignore` adds `**/dist`, `**/.next`, `**/.turbo`, `.git`; `assemble-api-context.sh` copies only schema assets from `apps/api/prisma` (never `client.js`), and the API runtime uses production-only dependencies; the image smoke asserts a static chunk referenced by `/` returns 200, one `/_next/image` request returns 200, the built output contains `api.comp.revola.ai` and not `localhost:3333`, every `NEXT_PUBLIC_*` read in code is a bake arg or `INTENTIONALLY_UNSET`, the API starts with only documented production config, and each image stays under a size threshold recorded in the plan.
- ENG-5 Trigger runtime dependencies: `vendorWorkspaceDb` adds `packages/db`'s `dependencies` (exact versions) to the layer and the test asserts them; before cutover one database-touching task runs in Trigger `prod`.
- ENG-6 Releases render config: `release.sh release` renders task definitions from the release commit's `renderTaskDefinition` with pinned secret versions and the image digest, registers them and records the revisions; clone-and-swap is removed. Test: a release that adds a required env var deploys it.
- ENG-7 Secret rotation semantics: secrets are classified (rotatable with overlap, rotatable by restart, never-rotate-without-procedure); the API accepts two service-token values during rotation (`SERVICE_TOKEN_*_PREVIOUS`) and the runbook retires the old after Trigger env is updated; `ENCRYPTION_KEY` rotation is refused by `sync-secrets.ts` (hash change blocked) until a versioned keyring and re-encryption procedure exist. Tests: overlap acceptance, refusal of an encryption-key change.
- ENG-8 Offboarding revokes API access (taste, provisional): removing a member revokes API keys they created; key validation rejects keys whose creator is inactive unless the key is explicitly marked organization-owned; `acting-user.service.ts`'s owner fallback applies only to legacy keys with no recorded creator. Tests: reads and mutations with a removed creator's key get 401.
- ENG-9 Endpoint-aware storage in jobs: Trigger tasks that touch application storage use one shared S3 client factory honoring `APP_AWS_ENDPOINT` and path-style access (customer-cloud scanning clients stay separate); acceptance covers knowledge-base document processing and questionnaire parsing.
- ENG-10 One production guard for all schema commands: `db:push` and the app-level Prisma scripts in `apps/{api,app,portal}/package.json` route through DX-GUARD's check.
- ENG-11 Rate limiting by verified identity: authenticated requests are throttled per session user or API key ID after authentication; unauthenticated requests use `CF-Connecting-IP` only when the request carries a valid origin header, else `req.ip`; no hop-count `trust proxy` arithmetic; `adminAuthRateLimiter` uses the same tracker; app and portal server calls forward a sanitized client IP and the portal stops forwarding arbitrary `x-*` headers. Supersedes CEO-RL's tracker details. Tests: forged headers ignored, two users through Service Connect get separate buckets, service-token caller separate.
- ENG-12 ECR and buildx: bake sets `provenance=false` and `sbom=false`; the arch check requires an arm64 entry and ignores attestation entries (fixture with attestations); the lifecycle policy protects `cache` with a higher-priority rule; record-based retention is a pruning script, not a lifecycle rule.
- ENG-13 CodeBuild sizing: `ARM_CONTAINER` with `BUILD_GENERAL1_LARGE`, `NODE_OPTIONS=--max-old-space-size` set in build stages, a build timeout, and app and portal built sequentially if parallel builds exceed memory.
- ENG-14 Origin header hygiene: `COMP_ORIGIN_AUTH` is 64 characters from `[A-Za-z0-9]` (ALB wildcard-safe, under 128); `buildListenerRules` tests the alphabet and length; the header is scrubbed from Sentry events and request logs in api, app and portal, with a test.
- ENG-15 Atomic deploy lock: acquire with `put-parameter` without overwrite; renew and release only when the stored owner matches; a process that loses the lease aborts before its next mutation; the lock covers migrations and every production-mutating subcommand. Tests: concurrent acquire, expiry takeover, stale owner abort.
- ENG-16 Allowlist edge cases: invitation lookup is case-insensitive; the OAuth-callback error path maps the allowlist rejection to the readable app message; tests for both.
- ENG-17 Operational details: `renderTaskDefinition` asserts the full secret ARN with its 6-character suffix; `comp-task-execution-role` includes `ecr:GetAuthorizationToken` on `*`; the runbook documents the ALB 60 s idle timeout, Cloudflare's 100 s origin timeout and 100 MB body cap; `release.sh` deploys api before app and portal; Task 8 Step 4 triggers a real job against a bypass path to confirm bot protection does not challenge it; `cloudflare.ts` is split into modules under 300 lines; the runbook notes that more than one task per service requires Redis-backed throttling.
- ENG-18 If UC1 option A is chosen: the Access session duration is at least the better-auth session length, the app turns an opaque redirect or CORS failure on API calls into a top-level navigation through an api-host bounce URL, and CEO-5 adds the "api-host Access cookie cleared, dashboard still loads" scenario.
- GATE-UC1 (approved by Kyle at the final gate, D2: option B): Cloudflare Access protects `app.comp.revola.ai` and `portal.comp.revola.ai` only; `api.comp.revola.ai` is proxied through Cloudflare with the origin header but no Access application, and is protected by its own auth (session, API key, service token), CEO-E1, ENG-11 and ENG-8. Superseded and removed: CEO-PF, ENG-18, the API-host parts of CEO-4 and CEO-A8, option A of CEO-PUB and CEO-E9. CEO-PUB becomes the option-B record: the runbook lists every `@Public()` route as internet-reachable with its own check, and for each feature Revola does not use it names the route and why its own guard suffices. `ACCESS_BYPASS_PATHS` holds only app-host machine paths (`/api/revalidate/path`). CEO-2 (Service Connect) stays accepted on its own merits. Acceptance CEO-5 keeps the fresh-profile check; offboarding (CEO-V4) is tested from a non-browser client against the public API host.
- GATE-UC2 (approved by Kyle at the final gate, D3: split): new Task 0 "Production state split", before Task 6 and the recovery gate. Steps: create a production Supabase project on the Pro plan in the region closest to `us-east-2` (record the choice), and a production Upstash database; generate fresh production values for `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SECRET_KEY`, `INTERNAL_API_TOKEN`, `SERVICE_TOKEN_*` and `REVALIDATION_SECRET` (third-party API keys may be shared or separate, decided per key in Task 6); apply migrations to the new database from the release SHA; copy data from the current shared project (schema-compatible dump and restore, recorded row counts per table, verified equal) and copy Storage objects bucket to bucket (object counts and checksums verified); re-encrypt integration credentials with a one-off `deploy/aws/reencrypt-credentials.ts` that decrypts with the old key and encrypts with the new one inside a transaction, has `--dry-run`, verifies every row decrypts with the new key afterwards, never prints plaintext, and is unit-tested with fixtures (round trip, wrong old key, partial failure rolls back). The existing shared project becomes the development project; laptops keep pointing at it; after Kyle confirms the production copy, development data is replaced with seed data so laptops no longer hold real evidence (destructive, Kyle confirms). Production secrets are generated or entered per key in Task 6, never copied wholesale from local env files. Superseded and removed: CEO-S1, DX-GUARD, ENG-10, the local-stack share of CEO-T2, CEO-E3's "extra migration is a colleague's branch" tolerance (extra applied migrations on production become an error), and spec acceptance criterion 7's "against the shared state" (now "local development works against the development project"). CEO-V1's restore drill runs against the new production project.
- GATE-UC3 (approved by Kyle at the final gate, D4: add contract): Task 10 adds to the spec a decision record (why self-host the fork rather than hosted Comp, with the fork-only capabilities named), a named primary maintainer (Kyle) and a backup maintainer Kyle names, an upstream-merge cadence (weekly, plus within 2 working days of any upstream security commit) with a checklist in `docs/self-hosting-aws.md` (merge, run gates, release, record), and opens upstream PRs on `trycompai/comp` (after Kyle confirms) for the generic changes: `AUTH_COOKIE_DOMAIN`, `/v1/health/ready`, shared adapter options with pool size and production TLS rule, the revalidation and unsubscribe URL fixes, the portal invite URL default, the server API base URL helper and verified-identity throttling. A GitHub issue on `revola-ai/comp` tracks each upstream PR.
- GATE-UC4 (approved by Kyle at the final gate, D5: Terraform): provisioning moves to Terraform under `deploy/aws/terraform/` with the `aws` and `cloudflare` providers (versions pinned), an S3 state backend `comp-terraform-state-455986776194` (versioned, encrypted, public access blocked, native S3 lockfile), created once by a documented bootstrap. Terraform owns: ECR repositories and lifecycle, CodeBuild project and role, `comp-task-execution-role`, log groups, `comp-tasks-sg`, target groups, listener rules 1 to 4 and the listener certificate attachment on the existing 443 listener, the ACM certificate with its Cloudflare validation record, the Cloud Map namespace, ECS services (with `ignore_changes` on `task_definition` so `release.sh` owns revisions), alarms and SNS, the release-record bucket, Secrets Manager secret containers (values set outside Terraform except the origin header, generated by `random_password` with an alphanumeric alphabet and stored in `comp/production/origin-auth`), Cloudflare DNS records, transform rule, Access applications, edge certificate and configuration rule. The shared `revola-production-alb`, its 443 listener, `revola-cluster`, VPC and subnets are referenced only as data sources. Tests: `terraform fmt -check`, `terraform validate`, `tflint`, and a bun test that parses `terraform plan -json` against a fixture and fails if any resource of type `aws_lb`, `aws_lb_listener`, `aws_ecs_cluster`, `aws_vpc` or `aws_subnet` is managed, if a listener rule priority is outside 1 to 4, or if Access covers `api.comp.revola.ai`. Origin header rotation becomes a two-value variable change followed by the edge probe. Superseded: `provision-build.sh`, `ecs-up.sh` and the provisioning parts of `cloudflare.ts` (DX-ORDER's phases become ordered `terraform apply` steps); scripts that remain: `release.sh` (with `migrate.ts`, `trigger-deploy.sh`, `trigger-env.ts`), `sync-secrets.ts`, `reencrypt-credentials.ts`. CEO-E5 moves from deferred to in scope. Every `terraform apply` runs only after Kyle reviews the plan output.
- ENG-R1 Fold is the executable gate (both re-run voices): before any implementation, the plan is rewritten as one clean document: a Decisions table (UC1 to UC4, taste items, their answers), Global Constraints matching the decisions, numbered Tasks 0 to 10 including Task 2b, with every accepted obligation folded into its task's Files, Interfaces, steps, tests and commit; superseded text and amendment prose move to a review-history appendix outside the executable plan; the spec is updated to the same design (shared-state text removed). A human reviewer (Kyle) signs off that each task reads standalone; ENG-1's identifier check is the backstop.
- ENG-R2 Encryption inventory for the key change (both): `reencrypt-credentials.ts` is driven by an explicit registry of every encrypted table, column and nested payload (integration credentials and their historical versions, OAuth application credentials, organization Secrets, legacy cloud-security settings, anything `apps/app/src/lib/encryption.ts` writes); a scan test fails when any `ENCRYPTION_KEY` consumer in `apps/` or `packages/` is not mapped to a registry entry; verification decrypts every populated row of every registered column with the new key before commit; tests cover mixed formats, wrong old key, rerun idempotence and partial failure rollback. `SECRET_KEY` consumers (for example the bearer check in `apps/app/src/app/api/user-frameworks/route.ts`) and `BETTER_AUTH_SECRET` usage are inventoried and recorded.
- ENG-R3 Credentials that must not carry over (Codex): during Task 0 all copied API keys, sessions, verification tokens and OAuth grants are revoked or excluded in production; production API keys are reissued; acceptance proves an old development API key and session get 401 against production. Copied live third-party integrations are disabled in development after the split so dev and production do not race on the same provider refresh tokens.
- ENG-R4 Cutover window for Task 0 (both): a maintenance window with an announced freeze; stop local stacks, `trigger dev` and Trigger schedules on the shared project, revoke or rotate the shared project's write credentials for laptops during the window, record the freeze time; take the final database snapshot and Storage copy after the freeze; reconcile attachment rows with copied objects (every referenced object exists with a matching checksum); scan every text column for the old project ref and Storage host (must be zero); only then enable production. The development wipe to seed data waits for CEO-V1's restore drill to pass against production plus a seven-day soak, and Kyle's confirmation.
- ENG-R5 Migration target identity (both): `migrate.ts` and the migration guard use a `DATABASE_MIGRATION_URL` (session pooler 5432 or direct, never `:6543`) from `comp/production/config`, and verify the full project identity (pooler user `postgres.<ref>` and database) against the production ref recorded in `deploy/aws/config.ts`. Tests: transaction-pooler URL refused, same host with the development ref refused.
- ENG-R6 Lock and release journal (Codex, with Claude's ordering points): the release lock moves to a Terraform-managed DynamoDB table with conditional writes (acquire if absent or expired, renew and release only when owner and generation match, a fencing generation checked before every mutation); `terraform apply` runs through a wrapper that takes the same lock. A release journal is written to S3 before the first mutation (attempt ID, previous deployment state) and checkpointed after each registered revision and deployment step; `release.sh status` and `rollback` read the journal. Tests: interleaved acquire, takeover after expiry with a stale owner resuming, kill after the ECS step and before the Trigger step. Supersedes the SSM lock in CEO-S2, DX-SVC and ENG-15.
- ENG-R7 Terraform bootstrap and ownership contract (both): fresh bring-up order is state bucket and lock table, then core resources, then image build and secret population, then `release.sh bootstrap` registers the initial task definitions, then the Terraform apply that creates ECS services from those ARNs (services ignore later `task_definition` and `desired_count` changes); `release.sh` never passes Service Connect, network or load-balancer settings; Terraform outputs consumed by `release.sh` are named in `deploy/aws/config.ts`. Origin-header values and outputs are `sensitive`; the state bucket policy limits readers to the Terraform role and Kyle. Origin header rotation keeps three separately applied phases (ALB accepts old and new; Cloudflare switches and the edge probe passes; old value retired), each a reviewed apply, with recovery from interruption documented and the ordering tested via plan fixtures. Tests cover fresh bring-up and a later change needing both Terraform and a release.
- ENG-R8 Boot versus readiness (Claude): production with no `DATABASE_SSL_CA` fails fast at boot; the negative image smoke asserts a non-zero exit with `ca_file_missing` in stderr; `/v1/health/ready` covers runtime TLS and connection failures with `tls_*`, Prisma codes or `timeout`; the ECS deployment circuit breaker with rollback is enabled; Review Focus 4 is rewritten accordingly. The app's `/api/health` readiness returns 503 with the same reason vocabulary.
- ENG-R9 Throttling mechanics (Claude): identity-based throttling runs where authentication is known (an interceptor after `HybridAuthGuard`, keeping the global IP limiter only for unauthenticated routes); app and portal Service Connect calls carry `INTERNAL_API_TOKEN` and only then is their forwarded client IP trusted; the API's secret mapping includes both origin-auth keys and a rotation restarts the API; tests run the real middleware chain; ENG-11 must land before cutover.
- ENG-R10 Self-hosted origin policy (Claude): when `SELF_HOSTED=true`, `origin-policy.ts` drops the hardcoded `*.trycomp.ai` and `*.trust.inc` acceptance and the `.trycomp.ai` cookie fallback, deriving trusted origins from `AUTH_TRUSTED_ORIGINS` and `AUTH_COOKIE_DOMAIN`; jest proves `https://x.trycomp.ai` is rejected when self-hosted. Included in the UC3 upstream PR list.
- ENG-R11 External edge probes and job alerts (Claude): an external HTTPS check through Cloudflare on `https://api.comp.revola.ai/v1/health` and on the app's Access redirect alarms to `comp-alerts`; a Trigger.dev alert channel emails prod run failures; a scheduled check compares Supabase connections with the CEO-T2 budget.
- ENG-R12 Machine routes on the app host (Claude): every app `route.ts` that authenticates by bearer or shared secret rather than session (for example `api/user-frameworks`, `api/retool`, `api/cloud-tests`, `api/revalidate/path`) is listed and each is bypassed with its own check, documented as unsupported, or removed; `/api/revalidate/path` requires a non-empty secret compared with `timingSafeEqual` and a relative path; the image smoke asserts `SKIP_ENV_VALIDATION` is absent from runtime env.
- ENG-R13 Smaller correctness items (Claude): CEO-2's guard markers include `proxy.ts` and `middleware.ts`; CodeBuild's role adds `codeconnections:GetConnectionToken` and `GetConnection`; the arch check handles both an image index and a single manifest (config blob) with fixtures; services set `healthCheckGracePeriodSeconds` for the API and a 30 s deregistration delay; preflight checks NAT routes for the subnets; rollback refuses with an explanation when a pinned secret version no longer exists; ENG-17's scale note adds a shared Next cache handler for more than one app task; ENG-5's prod task logs the `resolveSslConfig` mode to prove verified TLS before cutover; the portal Access policy covers every employee who must acknowledge policies (email-OTP policy for named externals if any; Kyle confirms the population).
<!-- /autoplan-accepted:eng -->
## Review record

### CEO review (autoplan, 2026-10-05)

Mode: SELECTIVE EXPANSION (autoplan override; plan adds hosting to an existing product).
Base branch: `revola/self-host`. Design source: `docs/specs/2026-10-05-aws-hosting-design.md` (no /office-hours doc; the committed spec serves that role).

#### System audit

- The fork (`revola-ai/comp`) is 7 merged PRs ahead of upstream on `revola/self-host`, all self-host and CSF work; the plan and spec are the only diff on `revola/aws-hosting-design`.
- No `TODOS.md` and no beads database exist in this repo, so deferrals below are listed here and filed only on approval.
- No stashes. Hot files in the last 30 days: `docs/self-hosting-local.md`, `scripts/local-run.sh`, CSF crosswalk scripts; none overlap with the plan's code changes except the self-hosting doc.
- Verified live (read-only AWS calls, 2026-10-05): the three subnets route `0.0.0.0/0` through `nat-0c959582c0eda33cd`; the 443 listener's rules now occupy priorities 5 to 62 (the spec says 5 to 36), so 1 to 4 are free; `ecsTaskExecutionRole`'s inline `SecretsManagerRead` already allows `secret:*` (Task 6's policy check passes as is, and every task using that role can read every secret); `revola-cluster` has no Service Connect default and one Cloud Map namespace (`retrieval.internal`).
- Taste calibration: good references are `apps/api/src/auth/origin-policy.ts` (small pure policy module with focused specs) and `packages/db` `resolveSslConfig` (one shared resolver reused by api, app and portal); the pattern to avoid is the hard-coded `trycomp.ai` branch in `auth.server.ts:52-62` and the copy-pasted `NEXT_PUBLIC_API_URL || 'http://localhost:3333'` fallbacks across `apps/app/src/lib/*`.

#### 0A. Premise challenge

1. **Real problem, valid.** Colleagues can only use Comp by running the API, app and `trigger dev` locally, and background jobs finish only while someone's laptop runs `trigger dev`. Hosting solves that pain directly, not a proxy. Do-nothing cost: every user keeps a three-process local stack, and jobs silently stall when nobody runs a worker.
2. **"Cloudflare Access on `*.comp.revola.ai` plus path bypasses" is infeasible as written (challenged).** Evidence:
   - Cloudflare's own docs: "Users who log in to `example.com` will be issued a cookie for `example.com`. When the user's browser requests `api.mysite.com`, Cloudflare Access looks for a cookie specific to `api.mysite.com`." The app's browser client (`authClient`, `apiClient`) calls `api.comp.revola.ai` cross-origin with credentials, so its first fetch gets a 302 to `cloudflareaccess.com` and fails CORS. Sign-in and every client-side data call break until the user visits `api.comp.revola.ai` by hand.
   - Server-side calls from the app go through the public URL: `apps/app/src/lib/api-server.ts:25` and `apps/app/src/lib/server-api-client.ts:3` use `NEXT_PUBLIC_API_URL` only, so every server component fetch from inside Fargate goes out through NAT to Cloudflare and meets Access with no Access cookie for the API host.
   - The bypass list is incomplete: `apps/api/src/trigger/integration-platform/ensure-valid-credentials.ts:57` calls `/v1/integrations/connections/:id/ensure-valid-credentials`, which no bypass covers. (Corrected after spec review: the `/v1/extract`, `/v1/questionnaire/*` and `/v1/background-checks/*` hits were Firecrawl URLs and doc comments, not Comp API calls.) A hand-kept list drifts with every upstream merge.
   - Revalidation goes to the wrong host: app Trigger tasks POST to `${NEXT_PUBLIC_BETTER_AUTH_URL}/api/revalidate/path` (`generate-risk-mitigation.ts:107,181`, `generate-vendor-mitigation.ts:94,157`, `onboard-organization.ts:238`) and `${BETTER_AUTH_URL}/api/revalidate/path` (`onboard-organization-helpers.ts:374`); the plan sets both to the API origin, but the route exists only in the app (`apps/app/src/app/api/revalidate/path/route.ts`).
   Queued as **User Challenge UC1** for the final gate; the original design stands until Kyle decides.
3. **Shared Supabase between local dev and the hosted app, accepted with a flag.** Criterion 7 keeps local dev on the same database; a developer running `prisma migrate dev` on a feature branch changes the database production reads. The plan's "migrations are a deliberate release step" covers deploys, not local branches.
4. **Fargate ARM64 on the shared ALB, accepted.** Decided with Kyle; headless browsers are remote (Browserbase, `playwright-core`), so no native Chromium blocks ARM64.
5. **Manual deploys through CodeBuild, accepted.** It sidesteps the broken GitHub OIDC trust documented in Revola's CLAUDE.md.

#### 0B. Existing code leverage

| Sub-problem | Existing code | Plan reuses? |
|---|---|---|
| Internal server-side API URL | `BACKEND_API_URL` already read by `apps/app/src/utils/auth.ts:19`, `apps/portal/src/app/lib/auth.ts:14`, portal `get-session` route and device-agent proxy | No; plan never sets it. Accepted CEO-2 extends it. |
| App health route | `apps/app/src/app/api/health/route.ts` | Yes (target group). |
| CA bundle for Trigger | `apps/api/caBundleExtension.ts` and `apps/app/caBundleExtension.ts` both exist | Partly; Task 4's "moving it to a shared import path if the app has none" is moot, the app has one. |
| API build context | `apps/api/buildspec.yml:55-100` | Mirrored into `assemble-api-context.sh`; duplication justified to avoid upstream merge conflicts. |
| App and portal images | root `Dockerfile` targets | Not reused; fork-owned Dockerfile justified the same way. |
| Trusted origins | `apps/api/src/auth/origin-policy.ts` | Yes via `AUTH_TRUSTED_ORIGINS`. |
| TLS to Supabase | `packages/db` `resolveSslConfig` | Yes. |
| Registry cache build | `interaction-service/aws/build_and_push.sh` (Revola reference) | Pattern reused in `buildspec.yml`. |
| Secrets layout | `interaction-service/production/config` | Pattern reused. |

#### 0C. Dream state

```
  CURRENT STATE                    THIS PLAN                          12-MONTH IDEAL
  each colleague runs api, app,    3 Fargate services behind the      push to revola/self-host builds and
  portal and trigger dev on a  ->  shared ALB, Access-gated, images -> deploys automatically; staging with its
  laptop against shared Supabase;  from CodeBuild, Trigger prod,      own database; migrations as an ECS task;
  jobs stall without a laptop      manual build + deploy scripts      infra as code; alarms paged; auditors
                                                                      reach a scoped portal
```

The plan moves toward the ideal; the remaining gaps are automation, staging and IaC, all listed under deferrals.

#### Decision ledger

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| UC1 (Kyle) | Edge gate for the API host; evidence in 0A item 2 | Access on all three hosts plus path bypasses | Access on `app` and `portal` only; `api` origin-locked by header and protected by its own auth (session, API key, service token) plus CEO-E1 | unresolved: User Challenge | Final gate only |
| CEO-2 (eng) | App and portal server-side calls must not depend on Cloudflare | Public URL | `BACKEND_API_URL=http://comp-api.comp.internal:3333` through ECS Service Connect; server-only modules (`api-server.ts`, `server-api-client.ts`, existing auth callers) prefer it; `'use client'` modules (`evidence-download.ts`, `api-client.ts`) keep `NEXT_PUBLIC_API_URL` | approved | autoplan P1, required for feasibility under either gate |
| CEO-3 (eng) | Trigger prod env must contain what tasks read | ECS service mapping | `trigger-env.ts` key set derived from `process.env.*` reads in `apps/{api,app}/src/trigger` (`API_BASE_URL`, `API_URL`, `BASE_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `SERVICE_TOKEN_TRIGGER`, ...), with a test that fails on an unmapped read | approved | autoplan P1 |
| CEO-4 (eng) | Bypass list must cover every machine-called path | Hand list | Test scans trigger sources for API path literals and fails on any path no bypass covers (moot if UC1 is approved) | approved | autoplan P1 |
| CEO-5 (eng) | Cross-host browser flow proven, not assumed | None | Acceptance: fresh browser profile signs in at `app.comp`, and the first client-side API call succeeds without visiting `api.comp` | approved | autoplan P1 |
| CEO-E1 (eng) | Sign-up cannot auto-approve outsiders if the edge gate fails | Access only | `AUTH_ALLOWED_EMAIL_DOMAINS` (here `revola.ai`) rejects user creation for other domains in better-auth's user-create hook; unset keeps today's behaviour | approved | autoplan P2, in blast radius (Task 1 auth module) |
| CEO-E2 (ops) | Directive 5: alerts are launch scope | None | CloudWatch alarms (running tasks < 1, unhealthy targets > 0 for 5 min, comp target 5xx) to an SNS topic emailing Kyle | approved | autoplan P1 |
| CEO-E3 (ops) | Deploy must not outrun migrations | Runbook text | `deploy.sh` runs `prisma migrate status` and refuses on pending migrations | approved | autoplan P2 |
| CEO-E4 (ops) | Post-deploy proof | `services-stable` | `deploy.sh` ends with health checks through the ALB with the origin header and prints pass/fail per service | approved | autoplan P1 |
| CEO-E5 | Infra as code | Bash scripts | Terraform or CDK | deferred | autoplan P3, outside blast radius |
| CEO-E6 | Staging with its own database | Spec non-goal | Staging env | deferred | spec non-goal kept |
| CEO-E7 (ops) | Builds start on merge without GitHub OIDC | Manual `start-build` | CodeBuild webhook on pushes to `revola/self-host` (deploy stays manual) | approved: taste | autoplan P2, surfaced at gate |
| CEO-E8 | Migrations as a one-off ECS task | Operator machine | ECS task | deferred | spec's own deferral |
| CEO-E9 (ops) | Origin header secret is rotatable | Generated once | Runbook and `--rotate` path: write new value to Cloudflare first with both values accepted by ALB rules, then drop the old | approved | autoplan P1 |
| CEO-F1 | Factual corrections | Spec text | ALB priorities in use are 5 to 62; app already has `caBundleExtension.ts`; execution role already reads `secret:*` | approved | factual, no behaviour change |

#### 0F/0G. Selective expansion

HOLD checks: the plan touches about 30 files and adds two new runtime services' worth of infra (Service Connect namespace, alarms); the complexity is real but each piece maps to an acceptance criterion, so nothing is cut. Minimum set for the goal is Tasks 1 to 10 plus CEO-2, CEO-3 and CEO-5, without which acceptance criteria 1, 3 and 4 fail.

10x check: the 10x version is "a merge to `revola/self-host` is live in ten minutes with no laptop involved, and Kyle hears about breakage before a colleague does". CEO-E2, CEO-E4 and CEO-E7 buy most of that for small effort; full CD waits on the OIDC fix.

Delight scan (each decided in the ledger): build on merge (E7, accepted); post-deploy smoke output (E4, accepted); alarm email (E2, accepted); pending-migration guard (E3, accepted); one-line rollback already exists as `deploy.sh <previous sha>`; image size and build time printed in the CodeBuild log (folded into Task 5's verify step, no new work).

Platform potential: the `deploy/aws` scripts (render task definition, listener rules, clone-and-swap deploy, arch check) are generic enough to become the fleet's shared deploy kit, which Revola's CLAUDE.md shows is missing; not pursued here.

Deferred (no TODOS.md or beads DB in this repo; filed on approval): CEO-E5 IaC (P3), CEO-E6 staging (P2), CEO-E8 migration task (P3), fleet GitHub OIDC fix (P2, outside this repo).

<!-- autoplan-accepted:ceo -->
- CEO-PLACE Task placement and order: CEO-E1 and CEO-R1 join Task 1 (API auth and health, same TDD steps; Task 1's Files list gains `apps/api/src/auth/email-domain-allowlist.ts`, its spec, `apps/api/src/health/health.controller.ts` and its spec; commit `feat(api): self-host auth config, sign-up allowlist, readiness probe and proxy-aware rate limits`); CEO-2's code helpers, CEO-3b and CEO-S1 land as a new Task 2b "Server-side API base URL, revalidation host and dev schedules" (failing tests, run, implement, run, commit `fix(app): server-side api base url, revalidation host and dev schedule guard`) before Task 3 builds images; CEO-P1 lands in Task 4 (database package); CEO-3, CEO-OV, CEO-OA and CEO-ENV extend Task 6; CEO-4, CEO-PF, CEO-PUB, CEO-TLS and CEO-A8 extend Task 8; CEO-O1 is a Task 10 step; CEO-RL joins Task 1; CEO-E7 extends Task 5; CEO-2's infra, CEO-E2, CEO-E3, CEO-E4 and CEO-E9 extend Task 7; CEO-T1 extends Task 9; CEO-T2's Supabase plan decision moves from Task 10 Step 1 to before Task 7; CEO-5 and CEO-TLS run in Task 8 Step 4. Each extension keeps the task's failing-test, run, implement, run, commit sequence.
- CEO-2 Internal API route for server-side calls (taste under UC1 option B, required under option A): rationale independent of UC1 is that server-side calls forward users' session cookies, and routing them through NAT, the public internet and Cloudflare adds latency, NAT data charges and an edge dependency for internal traffic. Task 7 creates a Cloud Map HTTP namespace `comp.internal` and enables ECS Service Connect on the three services (api as server with discovery name `comp-api` and client alias `comp-api.comp.internal:3333`; app and portal as clients). `renderTaskDefinition` gives the api container a named port mapping (`name: 'api'`, `appProtocol: 'http'`) and the test asserts it. `comp-tasks-sg` also allows 3333 from itself. `BACKEND_API_URL=http://comp-api.comp.internal:3333` is an override for app and portal only. Helpers `apps/app/src/lib/server-api-base-url.ts` and `apps/portal/src/app/lib/server-api-base-url.ts` export `getServerApiBaseUrl()` (returns `BACKEND_API_URL`, else `NEXT_PUBLIC_API_URL`, else `http://localhost:3333`; empty string counts as unset). Every server-only API caller uses it: app (8) `lib/api-server.ts`, `lib/server-api-client.ts`, `utils/auth.ts`, `app/api/training/certificate/route.ts`, `app/api/offboarding-export/route.ts`, `people/[employeeId]/actions/download-training-certificate.ts`, `people/[employeeId]/actions/download-hipaa-certificate.ts`, `policies/[policyId]/editor/tools/policy-tools.ts`; portal (6) `app/lib/auth.ts`, `app/api/auth/get-session/route.ts`, `app/api/device-agent/proxy.ts`, `app/api/portal/complete-training/route.ts`, `documents/[formType]/page.tsx`, `documents/[formType]/submissions/page.tsx`. Browser modules (`auth-client.ts`, `api-client.ts`, `evidence-download.ts`, `hooks/use-training-completions.ts`, `auth/device-callback/page.tsx`) keep `NEXT_PUBLIC_API_URL`. Tests: vitest per helper (set, unset, empty); a guard test per app scans files outside `src/trigger` that are server-only by marker (`'use server'`, a `route.ts`, `import 'server-only'`, an import of `next/headers`, or a `page.tsx`/`layout.tsx` without `'use client'`) and fails if any reads `NEXT_PUBLIC_API_URL` directly. Verify after deploy: render one server page that fetches API data and confirm the `AWS/ECS` Service Connect `RequestCount` metric for discovery name `comp-api` increases.
- CEO-OV Per-service overrides: `PRODUCTION_OVERRIDES` becomes `overridesForService({ service })` returning only that service's non-secret values, rendered as task-definition `environment` entries (never stored in `comp/production/config`, so per-service values such as `DATABASE_POOL_MAX` can differ); `triggerOverrides({ project })` is the Trigger counterpart and holds the public URL keys from CEO-3 plus the per-run `DATABASE_POOL_MAX`; `renderTaskDefinition`'s test asserts overrides appear only under `environment` and secrets only under `secrets`; `BACKEND_API_URL` is app and portal only; `AUTH_ALLOWED_EMAIL_DOMAINS`, `AUTH_COOKIE_DOMAIN` and `AUTH_TRUSTED_ORIGINS` are api only. Test: each key's service set is exactly as listed, and `BACKEND_API_URL` never appears in `triggerEnvKeys`.
- CEO-3 Trigger env derived from code: `deploy/aws/trigger-env-keys.ts` exports `triggerEnvKeys({ project })` = the matching service's secret and override keys plus the scanned reads (every `process.env.X` read directly under `apps/<project>/src/trigger`, `apps/<project>/trigger.config.ts` and the project's Trigger extensions, minus `TRIGGER_*` names Trigger provides), minus app-only internal keys (`BACKEND_API_URL`). Non-tautological test: every scanned read must be in `SECRET_KEYS`, `triggerOverrides({ project })`, or an explicit `INTENTIONALLY_UNSET` list with a one-line reason per key (for example `RESEND_TO_TEST`); `SECRET_KEYS` gains the scanned production keys that have values today (`FIRECRAWL_API_KEY`, `NOVU_API_KEY`, `BACKGROUND_CHECK_API_KEY`, `BROWSER_AUTOMATION_*`, `RESEND_FROM_*`, `APP_AWS_*_BUCKET`, `VERCEL_*` and any other the scan finds), each decided by Kyle in Task 6 Step 4 as set or intentionally unset. `trigger-env.ts` fails, naming the key, when a key in the set has no value in `comp/production/config`. URL keys resolve to public origins because Trigger workers run outside the VPC: `BASE_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `API_BASE_URL`, `API_URL`, `NEXT_PUBLIC_API_URL` = `https://api.comp.revola.ai`; `NEXT_PUBLIC_APP_URL` = `https://app.comp.revola.ai`; `NEXT_PUBLIC_PORTAL_URL` = `https://portal.comp.revola.ai`.
- CEO-3b Revalidation host fix: the six app Trigger call sites that build the revalidation URL, the two `onboard-organization*.ts` calls that pass `${BETTER_AUTH_URL}/${orgId}` as the revalidation `path` (must be `/${orgId}`), and `apps/app/src/lib/unsubscribe.ts`'s base URL (must be `NEXT_PUBLIC_APP_URL`, since `/unsubscribe/preferences` is an app page) are fixed; the call sites that build `${NEXT_PUBLIC_BETTER_AUTH_URL}/api/revalidate/path` or `${BETTER_AUTH_URL}/api/revalidate/path` call `getRevalidateUrl()` from new `apps/app/src/trigger/lib/revalidate-url.ts`, which reads `NEXT_PUBLIC_APP_URL` and throws a named error when it is unset. Vitest: set returns `https://app.comp.revola.ai/api/revalidate/path`; unset throws; trailing slash normalized; a scan test fails if any trigger file still joins `BETTER_AUTH_URL` with `/api/revalidate`.
- CEO-S1 Dev schedules do not double-fire on the shared database: new `apps/{api,app}/src/trigger/lib/schedule-guard.ts` exports `shouldRunScheduledTask({ environmentType, env })`, true only for `PRODUCTION`; `DEVELOPMENT`, `STAGING` and `PREVIEW` return false unless `COMP_RUN_SCHEDULES_IN_DEV=true`; every `schedules.task` run function returns early (logging the skip) when it is false. Tests: the guard's truth table, and a scan test that fails when a `schedules.task` file does not call the guard. `docs/self-hosting-local.md` states that local `trigger dev` skips schedules by default.
- CEO-4 Bypass coverage: `cloudflare.test.ts` scans code (comments stripped) under `apps/{api,app}/src/trigger` for the URL argument of `fetch(...)`, `axios.<method>(...)` and an allowlist of wrapper helpers (`getApiBaseUrl`, `sendEmailViaApi`, `apiResponse` and any others the implementer finds, listed in the test); a base expression `process.env.X || '<literal>'` counts as `process.env.X`; the base must be one of `API_BASE_URL`, `API_URL`, `BASE_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `params.apiUrl` or an allowlisted helper's return; a request URL whose base the scan cannot resolve fails the test. URLs that only appear in email bodies or links are not requests and are not scanned. App-host paths must always be covered by an app-host bypass (Access protects the app under both UC1 options); API-host paths must be covered only under UC1 option A. Third-party hosts are ignored. Task 8's list gains `api.comp.revola.ai/v1/integrations/connections/*/ensure-valid-credentials` (option A).
- CEO-PUB External callers, decided explicitly: under UC1 option A these `@Public()` or third-party-called routes stay behind Access and are documented in `docs/self-hosting-aws.md` as unsupported, with the reason, unless Kyle names one in use: `/v1/billing/webhook` (no billing when self-hosted), `/v1/people/webhook` and `/v1/background-checks/*` webhooks (no background-check vendor), `/v1/security-penetration-tests/webhook` (no pentest vendor), integration-platform webhook routes, `/v1/device-agent/exchange-code` and `/v1/device-agent/updates/*` (no device agent rollout), `/v1/questionnaire/parse/upload/token`, `/mcp/download`, `/v1/trust-access/*` (no public trust portal). Under option B they are reachable through Cloudflare with their own checks, and the doc says so.
- CEO-PF Access preflights (option A only): the API Access application sets `options_preflight_bypass: true`, and `cloudflare.test.ts` asserts it.
- CEO-TLS Edge certificate for second-level hosts: Cloudflare Universal SSL does not cover `*.comp.revola.ai` (Cloudflare docs: deeper subdomains "will not serve a valid certificate"). Task 8, before the proxied CNAMEs, orders an Advanced Certificate Manager edge certificate for `*.comp.revola.ai` (Kyle confirms the about $10 per month, or reuses the zone's existing ACM subscription) and checks the zone SSL mode is Full (strict). Verify: `curl -sv https://app.comp.revola.ai` completes the handshake with a certificate whose SAN includes `*.comp.revola.ai`. Task 10's cost section includes it.
- CEO-5 Cross-host browser acceptance: Task 8 Step 4, right after the proxied CNAMEs go live, runs "fresh browser profile, sign in at `https://app.comp.revola.ai`, the dashboard loads API data without visiting `https://api.comp.revola.ai` directly", plus the same for the portal, and records the result in `docs/self-hosting-aws.md`. Cutover means announcing the hosted URL to colleagues and merging Task 10's change to `docs/self-hosting-local.md`; a CEO-5 failure blocks cutover until the Access design is fixed.
- CEO-E1 Sign-up domain allowlist: new `apps/api/src/auth/email-domain-allowlist.ts` exports `parseAllowedDomains({ env })` (reads `AUTH_ALLOWED_EMAIL_DOMAINS`, comma-separated, lowercased, `@` stripped), `isEmailAllowed({ email, allowedDomains, hasPendingInvitation })`, and `createEmailDomainAllowlistHook({ env, db })`, which returns the `databaseHooks.user.create.before` handler; `auth.server.ts` gains only the import and one `databaseHooks.user.create.before` entry calling the factory. The handler throws `APIError('FORBIDDEN')` naming the domain when the email's exact domain is not listed and no invitation exists for that email with `status = 'pending'` and `expiresAt` in the future (Prisma lookup scoped by email; jest adds expired and accepted invitations as rejected cases). Unset or empty allows everyone. Jest `email-domain-allowlist.spec.ts`: listed domain allowed; other domain rejected; `Person@Revola.AI` normalized and allowed; `x.revola.ai` rejected unless listed; invited outside email allowed; unset allows all; malformed email rejected. The api override is `AUTH_ALLOWED_EMAIL_DOMAINS=revola.ai`; the runbook's "add an auditor" is an Access policy entry plus a People invite.
- CEO-R1 Database readiness probe: new `@Public()` `GET /v1/health/ready` in the API health controller runs `SELECT 1` with a 2-second timeout and returns `200 {status:'ok'}` or `503 {status:'unavailable', reason}` with no connection details, where `reason` is the Prisma error code when present (for example `P1011`), else `ca_file_missing` for the resolver's missing-CA error, else `timeout`, else `unknown`. The Task 3 negative smoke container runs with `-e DATABASE_SSL_CA=` and `-e PRISMA_ALLOW_INSECURE_TLS=` explicitly emptied. The ALB target group keeps `/v1/health` (liveness), so a database outage does not cycle healthy tasks. The Task 3 image smoke and the CEO-E4 smoke call `/v1/health/ready`. Jest: ok, timeout, Prisma-coded and missing-CA cases map to `200`, `503 timeout`, `503 P1011` and `503 ca_file_missing`. Review Focus 4 is narrowed accordingly (baseline edit).
- CEO-P1 Database pool size: `packages/db/src/client.ts` passes `max` from `DATABASE_POOL_MAX` (integer 1 to 50, validated with zod, default unchanged when unset) to `PrismaPg`. Test: set, unset and invalid values. Per-service overrides set it (values from CEO-T2).
- CEO-T2 Connection budget: before Task 7, Kyle picks the Supabase plan (moved from Task 10 Step 1); the implementer records in `docs/self-hosting-aws.md` the session pooler's limit for that plan, each consumer's pool (`DATABASE_POOL_MAX` per ECS service, Trigger prod concurrency per project times the per-run pool, and two local stacks) and sets the overrides and the Trigger `prod` environment concurrency limit (set by Kyle in the Trigger.dev dashboard per project, recorded in the doc) so the sum stays under the limit. Verify: Supabase's connection count stays under the limit during Task 9's policy regeneration.
- CEO-OA Origin header in its own secret: `COMP_ORIGIN_AUTH` and `COMP_ORIGIN_AUTH_PREVIOUS` live in a separate secret `comp/production/origin-auth`, so `sync-secrets.ts` re-syncs of `comp/production/config` cannot remove them; `deploy.sh` and `cloudflare.ts` read it with `aws secretsmanager get-secret-value` into a variable that is never printed (`cloudflare.ts --dry-run` redacts it). Test: `sync-secrets.ts` refuses to write any `COMP_ORIGIN_AUTH*` key.
- CEO-E2 Alarms (no cluster-wide change): `ecs-up.sh` creates SNS topic `comp-alerts` with an email subscription to an address Kyle supplies and confirms, and per service three alarms on `AWS/ApplicationELB` with dimensions `LoadBalancer` and `TargetGroup`: `HealthyHostCount` (statistic `Minimum`) `< 1` for 2 of 2 one-minute periods with `treat-missing-data breaching` (silence during an outage alarms), `UnHealthyHostCount > 0` for 5 of 5 and `HTTPCode_Target_5XX_Count > 10` summed over 5 minutes, both `notBreaching`. Container Insights on `revola-cluster` is unchanged. Verify: `aws cloudwatch describe-alarms --alarm-name-prefix comp-` lists 9 alarms in `OK` once targets are healthy; `aws cloudwatch set-alarm-state` on one alarm delivers an email.
- CEO-E3 Migration guard: new `deploy/aws/migration-guard.ts` exports pure `classifyMigrations({ inTree, applied })` returning `{ pending, extra }`; the CLI lists migration directory names at `<sha>` with `git ls-tree --name-only <sha> packages/db/prisma/migrations/` (no worktree), reads applied names from `_prisma_migrations` (`finished_at` not null, `rolled_back_at` null) over the verified-TLS connection with env sourced in a subshell (never printed), exits non-zero listing `pending`, and warns on `extra` (rollback or a colleague's branch on the shared database). `deploy.sh <sha>` runs it before any `update-service`; `--skip-migration-check` prints a warning and is for outages only. The tree listing uses `git ls-tree -d --name-only <sha> packages/db/prisma/migrations/` and basenames, so `migration_lock.toml` is never counted. Tests: `classifyMigrations` cases (none, pending, extra, both) plus a listing fixture containing `migration_lock.toml`.
- CEO-E4 Post-deploy smoke: after `services-stable`, `deploy.sh` reads the origin header value (CEO-OA) and runs `curl --connect-to <host>:443:revola-production-alb-1399285125.us-east-2.elb.amazonaws.com:443` with the header against `/v1/health/ready` (api) and `/api/health` (app, portal), so SNI and certificate checks use the real host; one pass/fail line per service; failure exits non-zero and prints the rollback command with the previous tag from the old task definition. The first `deploy.sh` in Task 7 runs with `--skip-smoke` (warned; allowed only while the listener has no `*.comp.revola.ai` certificate), and Task 8 Step 4 reruns the smoke after the certificate is attached.
- CEO-E3/E4 tests: `deploy/aws/tests/deploy.test.sh` puts stub `aws`, `docker`, `bun`, `git` and `curl` on `PATH` and asserts: a pending-migration result exits non-zero before any `aws ecs update-service`; an extra-migration result warns and continues; a wrong-arch manifest aborts; a failed smoke exits non-zero and prints the rollback tag; `--skip-smoke` is refused when the stubbed listener lists the certificate; the header value never appears in stdout or stderr. Functions are called as plain statements, not inside `&&` lists (prior learning: errexit is disabled there).
- CEO-E7 Build on merge (taste, provisional until the final gate): if approved, `provision-build.sh` adds a CodeBuild webhook filter for pushes to `revola/self-host` (deploys stay manual) and Task 10 updates spec section 3.5; if rejected, neither the webhook nor the spec edit is made. Verify: a push produces a `comp-images` build whose source version equals the pushed SHA.
- CEO-E9 Origin header rotation: `buildListenerRules` takes `originHeaderValues` (one or two values) and the test asserts both appear in each host rule's header condition. Rotation, run by Kyle in one session: `ecs-up.sh --rotate-origin-header` moves the current value to `COMP_ORIGIN_AUTH_PREVIOUS`, writes a new `COMP_ORIGIN_AUTH`, and updates the rules to accept both; `bun deploy/aws/cloudflare.ts --rotate-origin-header` switches the transform rule; an edge probe through Cloudflare then must get the origin's own response, not the ALB's `403` (option B: `https://api.comp.revola.ai/v1/health`; option A: an unauthenticated request to the bypassed `https://api.comp.revola.ai/v1/email/unsubscribe` must return the API's own 4xx); only then `ecs-up.sh --retire-origin-header` drops the previous value. Documented in `docs/self-hosting-aws.md`.
- CEO-T1 Trigger release path: new `deploy/aws/trigger-deploy.sh <sha>` refuses unless the working tree is clean and `HEAD` equals `<sha>`, runs `bun install --frozen-lockfile` and builds `packages/db` at that SHA, runs `trigger-env.ts` for both projects (failing on a missing value), then `bunx trigger.dev@4.4.3 deploy --env prod` in `apps/api` and `apps/app`. `deploy.sh` ends by printing the matching `trigger-deploy.sh <sha>` command; the runbook's release and rollback both run it at the same SHA.
- CEO-O1 Deferred follow-ups filed: Task 10 adds a step that opens GitHub issues on `revola-ai/comp` (after Kyle confirms) for IaC for `deploy/aws` (P3), a staging environment with its own Supabase project (P2), migrations as an ECS task (P3), and the fleet GitHub OIDC repair (P2, cross-repo).
- CEO-F1 Factual corrections, applied in place to Tasks 1, 4, 6, 10 and Review Focus 4: Task 1's second test case is stated concretely; Task 4 lists `apps/app/caBundleExtension.ts`; Task 6 Step 4 records that `ecsTaskExecutionRole` already reads `secret:*` and that this broad scope is a known risk; Task 10 lists the spec file and updates spec section 3.3's "priorities 5 to 36" to "5 to 62"; Review Focus 4 names the readiness probe instead of health checks.
- CEO-ENV ECS env coverage: a test per ECS service scans `process.env.X` reads in `apps/<service>/src` (outside `src/trigger`) and in the workspace packages that service bundles (`packages/email`, `packages/auth`, `packages/db`), and fails unless each is in that service's secrets, `overridesForService`, or `INTENTIONALLY_UNSET` with a reason. The api overrides gain `NEXT_PUBLIC_PORTAL_URL=https://portal.comp.revola.ai` and `NEXT_PUBLIC_BETTER_AUTH_URL=https://api.comp.revola.ai`; `TRUST_APP_URL` and `MCP_RESOURCE_URL` are set or listed as intentionally unset by Kyle. Without this, `people-invite.service.ts:681` sends employees to `portal.trycomp.ai`.
- CEO-RL Proxy-aware rate limiting: the API sets Express `trust proxy` to the number of proxy hops it sits behind (ALB, plus Envoy for Service Connect callers) and a custom `ThrottlerGuard` tracker keys requests on `CF-Connecting-IP` when present, else the client entry of `X-Forwarded-For`, else `req.ip`; requests authenticated by a valid service token or `INTERNAL_API_TOKEN`, and Service Connect calls from app and portal (which forward the end user's `X-Forwarded-For`), are keyed per caller identity rather than sharing one bucket. Jest: two different `CF-Connecting-IP` values get separate buckets; a missing header falls back; a service-token caller is not limited with users. CEO-5 adds a burst check: 30 page loads in a minute from one browser produce no `429`.
- CEO-A8 Task 8 in both UC1 variants: option A (original) creates one Access application for `app.comp.revola.ai` and `portal.comp.revola.ai` plus a separate application for `api.comp.revola.ai` with `options_preflight_bypass: true` (CEO-PF), and the API-host bypass list; option B creates Access applications for `app.comp.revola.ai` and `portal.comp.revola.ai` only, and `ACCESS_BYPASS_PATHS` holds only app-host entries (`/api/revalidate/path`). `cloudflare.test.ts` takes the option as a parameter and asserts the matching configuration; in both, no bypass covers `/` or `/api/auth/*`. Under option A the cloud-security bypass narrows to the paths Trigger calls (`/v1/cloud-security/scan/*`, `/detect-services/*`, `/resolve-session/*`, `/remediation/preview`, `/remediation/execute`).
- CEO-BX Bypass verification: for each bypass path, the expected response is defined per path in the test fixture and must be served by the origin (any `4xx` whose body is the API's or app's JSON, never a Cloudflare page or the ALB's `403` body); Review Focus 3 and Task 8 Step 4 use that definition.
- CEO-UP `ecs-up.sh` re-runs: on first run it registers each task definition from `renderTaskDefinition` with the image tag passed as `--image-tag <sha>` (from Task 5's build); on a re-run it re-renders each task definition with the image currently running, registers it, and calls `update-service` with the rendered Service Connect configuration, so new secret mappings, overrides and port names reach running services; `deploy.sh` keeps cloning the running task definition for image-only releases.
- CEO-TAG Image tag length: CodeBuild, `deploy.sh`, `trigger-deploy.sh` and the runbook all use `git rev-parse --short=12`; `buildspec.yml` derives it from `CODEBUILD_RESOLVED_SOURCE_VERSION` truncated to 12 characters, and `deploy.sh` rejects a tag that is not 12 hex characters.
- CEO-CF Cloudflare token and SSL mode: the token adds SSL and Certificates edit and Zone Settings read; if the zone's SSL mode is not Full (strict), `cloudflare.ts` adds a Configuration Rule scoped to `http.host in {the three hosts}` setting SSL Full (strict), never changing the zone-wide setting.
- CEO-V1 Recovery gate before cutover: Supabase Pro (or higher) is active before Task 7, point-in-time recovery is evaluated and its decision recorded, and a restore drill restores the database and a sample of Storage objects into an isolated Supabase project, then proves one evidence file opens and one integration credential decrypts with the production `ENCRYPTION_KEY`. `docs/self-hosting-aws.md` records RPO, RTO, the drill date and steps, and how `ENCRYPTION_KEY`, `SECRET_KEY` and the Storage bucket are backed up outside Supabase. A failed drill blocks cutover.
- CEO-V2 Dedicated execution role: `ecs-up.sh` creates `comp-task-execution-role` (ECR pull for the three repos, CloudWatch Logs for `/ecs/comp-*`, `secretsmanager:GetSecretValue` on `comp/production/*` only) and `renderTaskDefinition` uses it; the test asserts the role name; the shared `ecsTaskExecutionRole` is not used by Comp. This supersedes the plan's `ecsTaskExecutionRole` constraint for Comp tasks.
- CEO-V3 Release record: `deploy.sh` and `trigger-deploy.sh` each append to `docs/releases/<YYYY-MM-DD>-<sha>.json` (committed by the operator) the image digests, registered task definition ARNs, Trigger deployment versions, Secrets Manager version IDs of `comp/production/config` and `comp/production/origin-auth`, and the latest applied migration name; rollback instructions cite the record. Test: the writer produces every field from stubbed inputs and refuses to write without digests.
- CEO-V4 Workflow acceptance: Task 10's acceptance adds employee policy acknowledgment in the portal, an auditor invited with a restricted role who can read but not change evidence, an evidence export, and offboarding: after a member is removed in People and from Access, their existing session cookie, any API key they created and their portal session all get `401`/`403` on direct API calls (tested from a non-browser client, which matters under UC1 option B).
- CEO-V5 Regions and latency: `docs/self-hosting-aws.md` records the Supabase and Upstash regions; acceptance records p95 latency of `/v1/health/ready` and one authenticated list call from the ECS task; if the database is not in `us-east-2`, the doc states the measured cost and the option to move.
- CEO-V6 Data boundary record: `docs/self-hosting-aws.md` lists each processor (Supabase, Upstash, Trigger.dev cloud, Gemini, OpenAI, Resend, Firecrawl, Browserbase, Cloudflare, AWS), the data classes it sees, and its log retention; it notes that `apps/api/src/trigger/policies/update-policy-prompts.ts:20-25` logs company context and policy content to Trigger.dev logs (scrubbing is a filed follow-up).
- CEO-V7 Migration compatibility rule: `docs/self-hosting-aws.md` states that migrations must stay compatible with the previous release (expand, release, then contract in a later release), so `deploy.sh <previous sha>` stays valid for one release; a release that breaks this is marked forward-fix-only in its release record.
- CEO-V8 Build-context drift test: a test derives the `@trycompai/*` workspace packages `apps/api` depends on (from its `package.json`, transitively) and fails if `assemble-api-context.sh`'s package list differs.
- CEO-V9 Environment-bound images: images carry `NEXT_PUBLIC_*` values for one environment; the bake file names the environment in the tag suffix only when a second environment exists, and the runbook says images are not promotable across environments.
- CEO-S2 Deploy safety additions: `deploy.sh` takes a lock (SSM parameter `comp/deploy-lock` holding owner and expiry; refuses when held and unexpired; releases on exit), and on a `services-stable` timeout prints the last 10 service events and each stopped task's `stoppedReason`; `deploy.test.sh` covers both. CEO-E2 adds a tenth alarm on the `AWS/ECS` Service Connect `HTTPCode_Target_5XX_Count` for `comp-api`.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"c49783c571423949b89b2135c97511d1fb0fa7cc6b9a051b9d245e00787c85cd","replacements":[{"oldText":"`apps/api/caBundleExtension.ts`, `apps/app/trigger.config.ts` (add `caBundleExtension`, moving it to a shared import path if the app has none)","newText":"`apps/api/caBundleExtension.ts`, `apps/app/caBundleExtension.ts` (exists; edited in place), `apps/app/trigger.config.ts` (register `caBundleExtension` if it is not already registered)"},{"oldText":" Check `ecsTaskExecutionRole`'s `SecretsManagerRead` policy resource covers `arn:aws:secretsmanager:us-east-2:455986776194:secret:comp/*`; if not, add that ARN pattern to the policy (Kyle confirms).","newText":" `ecsTaskExecutionRole`'s inline `SecretsManagerRead` policy already allows `arn:aws:secretsmanager:us-east-2:455986776194:secret:*` (verified 2026-10-05), so no IAM change is needed (known risk: every task using this role can read every secret in the account); re-check with `aws iam get-role-policy --role-name ecsTaskExecutionRole --policy-name SecretsManagerRead` before the first deploy."},{"oldText":"`buildListenerRules({ targetGroups, originHeaderValue }: { targetGroups: Record<'api' | 'app' | 'portal', string>; originHeaderValue: string }): ListenerRule[]`","newText":"`buildListenerRules({ targetGroups, originHeaderValues }: { targetGroups: Record<'api' | 'app' | 'portal', string>; originHeaderValues: readonly [string] | readonly [string, string] }): ListenerRule[]`"},{"oldText":"security group `comp-tasks-sg` in the VPC allowing 3000 and 3333 only from `sg-0eb10c6d5c5fd239b`;","newText":"security group `comp-tasks-sg` in the VPC allowing 3000 and 3333 from `sg-0eb10c6d5c5fd239b` and 3333 from itself (Service Connect);"},{"oldText":"The origin header value is generated once and stored as key `COMP_ORIGIN_AUTH` in `comp/production/config`.","newText":"The origin header value is generated once and stored as key `COMP_ORIGIN_AUTH` in its own secret `comp/production/origin-auth` (not in `comp/production/config`, so secret re-syncs cannot remove it); during a rotation the outgoing value sits in `COMP_ORIGIN_AUTH_PREVIOUS` until retired."},{"oldText":"their prod environment variables set from `comp/production/config` (same keys as the matching ECS service) by","newText":"their prod environment variables set from `comp/production/config` (the keys from `triggerEnvKeys({ project })`: the matching ECS service's keys plus every key Trigger code reads) by"},{"oldText":"expect env-name lists matching `secretsForService` for `api` and `app`.","newText":"expect env-name lists equal to `triggerEnvKeys({ project })` for `api` and `app`."},{"oldText":"how to deploy a new commit (CodeBuild build, `deploy.sh <sha>`, migrations first when the commit adds any), how to roll back (`deploy.sh <previous sha>`)","newText":"how to release a commit (CodeBuild build, migrations first when the commit adds any, `deploy.sh <sha>`, then `trigger-deploy.sh <sha>`), how to roll back (`deploy.sh <previous sha>` and `trigger-deploy.sh <previous sha>`)"},{"oldText":"  - `AUTH_COOKIE_DOMAIN` wins over a `trycomp.ai` `BASE_URL` when the BASE_URL host is inside it; with `BASE_URL='https://api.trycomp.ai'` and `AUTH_COOKIE_DOMAIN='.comp.revola.ai'` it throws `/AUTH_COOKIE_DOMAIN .* does not cover api.trycomp.ai/`.","newText":"  - `AUTH_COOKIE_DOMAIN='.trycomp.ai'` with `BASE_URL='https://api.staging.trycomp.ai'` returns `'.trycomp.ai'` (the variable wins over the built-in `staging` rule); `AUTH_COOKIE_DOMAIN='.comp.revola.ai'` with `BASE_URL='https://api.trycomp.ai'` throws `/AUTH_COOKIE_DOMAIN .* does not cover api.trycomp.ai/`."},{"oldText":"4. A task whose image lacks the CA file or whose `DATABASE_SSL_CA` is unset must fail health checks with the resolver's clear error, not connect without verification (Task 3 smoke test, Task 7 template test).","newText":"4. An API task whose image lacks the CA file or whose `DATABASE_SSL_CA` is unset must fail the readiness probe `GET /v1/health/ready` with a `503` naming the TLS error class, not connect without verification (Task 3 smoke test, `deploy.sh` smoke, Task 7 template test)."},{"oldText":"- Modify: `docs/self-hosting-local.md` (link to the hosted setup; colleagues no longer need a local stack to use Comp), `deploy/aws/README.md`","newText":"- Modify: `docs/self-hosting-local.md` (link to the hosted setup; colleagues no longer need a local stack to use Comp), `deploy/aws/README.md`, `docs/specs/2026-10-05-aws-hosting-design.md` (section 3.3 rule priorities; section 3.5 only if CEO-E7 is approved)"},{"oldText":"- [ ] **Step 1: Kyle updates** the Google OAuth client (origins `https://app.comp.revola.ai`, `https://api.comp.revola.ai`; redirect `https://api.comp.revola.ai/api/auth/callback/google`), moves Supabase to Pro and turns on Enforce SSL.","newText":"- [ ] **Step 1: Kyle updates** the Google OAuth client (origins `https://app.comp.revola.ai`, `https://api.comp.revola.ai`; redirect `https://api.comp.revola.ai/api/auth/callback/google`) and turns on Supabase Enforce SSL (the Supabase plan itself is chosen before Task 7, CEO-T2)."},{"oldText":"answers `GET /v1/health` with `200` within 60 s (proves Prisma, verified TLS and the vendored workspace packages at runtime).","newText":"answers `GET /v1/health/ready` with `200` within 60 s (its `SELECT 1` proves Prisma, verified TLS and the vendored workspace packages at runtime), and a second api container started without `DATABASE_SSL_CA` answers `/v1/health/ready` with `503` naming the TLS error class."},{"oldText":"- Consumes: ACM validation CNAME (Task 7), `COMP_ORIGIN_AUTH` (Task 7), ALB DNS name.","newText":"- Consumes: ACM validation CNAME (Task 7), `COMP_ORIGIN_AUTH` read from `comp/production/origin-auth` with `aws secretsmanager get-secret-value` and never printed (Task 7), ALB DNS name."},{"oldText":"- [ ] **Step 3: Deploy** (after Kyle confirms) `cd apps/api && bunx trigger.dev@4.4.3 deploy --env prod` and the same in `apps/app`, then run `trigger-env.ts` for both without `--dry-run`.","newText":"- [ ] **Step 3: Upload env, then deploy** (after Kyle confirms): run `trigger-env.ts` for both projects without `--dry-run`, then `cd apps/api && bunx trigger.dev@4.4.3 deploy --env prod` and the same in `apps/app` (the order `trigger-deploy.sh` uses)."},{"oldText":"`TAG=$(git rev-parse --short HEAD)`","newText":"`TAG` = the first 12 characters of `CODEBUILD_RESOLVED_SOURCE_VERSION`"},{"oldText":"3. A machine route opened by an Access Bypass must still reject a request without its token (`401`/`403`), so the bypass is never an open door (Task 8 verifies each one).","newText":"3. A machine route opened by an Access Bypass must still reject a request without its token with the origin's own `4xx` (per-path expectation in the test fixture), so the bypass is never an open door (Task 8 verifies each one)."},{"oldText":"for every bypass path, an unauthenticated request returns `401` or `403` from the API or app itself (not a Cloudflare page).","newText":"for every bypass path, an unauthenticated request returns that path's expected origin `4xx` from the API or app itself (not a Cloudflare page or the ALB's `403`)."},{"oldText":"`CLOUDFLARE_API_TOKEN` scoped to Zone DNS edit, Zone Transform Rules edit and Access edit for `revola.ai`","newText":"`CLOUDFLARE_API_TOKEN` scoped to Zone DNS edit, Zone Transform Rules edit, SSL and Certificates edit, Zone Settings read, Configuration Rules edit and Access edit for `revola.ai`"}]} -->

#### 0H. CEO plan and spec review

CEO summary: `~/.gstack/projects/trycompai-comp/ceo-plans/2026-10-05-aws-hosting.md`.
Spec review loop: 3 launches (cap), each 5/10; 70 issues found, 52 confirmed fixed by the next pass, 18 from pass 3 applied but not re-reviewed (metrics logged to `analytics/spec-review.jsonl`).
Notable catches: Service Connect traffic blocked by the plan's own security group; `RunningTaskCount` needs Container Insights (disabled on the cluster); revalidation and unsubscribe links pointing at the API host; Cloudflare Universal SSL not covering `*.comp.revola.ai`; the origin header being erased by secret re-syncs; the rate limiter keyed on the ALB's IP; invite links falling back to `portal.trycomp.ai`.
Document approval: auto-decided A (approve these versions and continue to 0I), autoplan P6.

#### 0I. Temporal interrogation

```
  HOUR 1 (foundations):   UC1 answer (which hosts Access protects) and the Supabase plan pick gate Tasks 7 and 8.
                          Cloudflare zone: does revola.ai already have Advanced Certificate Manager? Is SSL mode Full (strict)?
  HOUR 2-3 (core logic):  Task 1 (cookie domain, allowlist, readiness, rate-limit tracker) and Task 2b (server base URL,
                          revalidation, schedule guard) touch upstream files; keep each change in a new small module so
                          upstream merges stay mechanical. 17 schedules.task files need the guard.
  HOUR 4-5 (integration): Service Connect on an existing cluster with no namespace; first `ecs-up.sh` run needs the image
                          from Task 5, so CodeConnections authorization (Kyle, console) is on the critical path.
                          Trigger prod env needs Kyle's set/unset decision for every scanned key.
  HOUR 6+ (polish/tests): fresh-profile browser check (CEO-5) is the moment of truth for UC1; burst check for CEO-RL;
                          alarm test email; rotation dry run.
```

Feasibility blockers needing Kyle before build: UC1, Supabase plan, Cloudflare ACM (about $10/month), CodeConnections authorization, Trigger prod keys, the alert email address.
Effort: human team about 6 to 8 days; CC plus gstack about 4 to 6 hours of build plus Kyle's console steps.

#### Dual voices (CEO)

Claude subagent: completed (INPUT `ceo cc270c3d...` matches the voice snapshot), 12 findings (2 critical, 6 high, 4 medium).
Codex (`gpt-6-astra`): completed, strategy 4/10, 8 findings (1 critical, 7 high).

```
CEO DUAL VOICES - CONSENSUS TABLE:
  Dimension                             Claude              Codex               Consensus
  1. Premises valid?                    No (shared DB,      No (prod is a dev   CONFIRMED: premises need change
                                        self-host unargued) sandbox)
  2. Right problem to solve?            Narrower than real  Measures deploys,   CONFIRMED: reframe as system of record
                                        (system of record)  not outcomes
  3. Scope calibration correct?         No (IaC deferred,   No (no env split,   CONFIRMED: scope misses env split, recovery,
                                        patches symptoms)   no release record)  versioned config
  4. Alternatives sufficiently explored?No (hosted Comp)    No (upstream/hosted) CONFIRMED: not explored
  5. Competitive/market risks covered?  No (upstream drift) No (fork ownership, CONFIRMED: fork maintenance risk unowned
                                                            vendor data)
  6. 6-month trajectory sound?          No without fixes    No without fixes    CONFIRMED: revise before cutover
```

Single-voice findings (not confirmed, decided individually): Claude's region and latency (accepted CEO-V5), image-environment binding (CEO-V9), build-context drift (CEO-V8), CodeBuild as release runner (taste, deferred to follow-up); Codex's business-workflow acceptance (accepted CEO-V4), data boundary and AI-input logging (accepted CEO-V6, log scrubbing deferred), release record (accepted CEO-V3), rollback versus migrations (accepted CEO-V7).
Both voices, decided without a user challenge: recovery gate (CEO-V1) and dedicated execution role (CEO-V2) harden the existing direction rather than change it.

#### User Challenges (both voices agree the stated direction should change; decided at the final gate)

- **UC1 Access gate for the API host.** You said: Access on `*.comp.revola.ai`, machine paths bypassed. Both recommend option B: Access on `app` and `portal` only; the API protected by its own auth, the origin header, CEO-E1 and CEO-RL. Codex's condition: offboarding must revoke sessions and API keys at the API (CEO-V4 tests it). Why: per-hostname Access cookies break browser calls to the API, and a code-scanned bypass list couples edge config to every upstream merge. Blind spot: option B exposes the whole API surface to the internet behind Cloudflare, so an API auth bug is reachable by anyone, not just Revola staff. If wrong: under A, cutover fails CEO-5; under B, an API vulnerability is internet-facing.
- **UC2 Separate production state from development.** You said: data stays on today's shared Supabase and Upstash; local dev keeps working against the same shared state (criterion 7). Both recommend: production gets its own Supabase project (database and Storage), Upstash database, `ENCRYPTION_KEY`, `SECRET_KEY` and auth secret; development moves to a separate dev project with sanitized data; integration credentials are re-encrypted during the move; laptops stop holding production credentials. Why: every laptop can migrate, write or decrypt the evidence store, which is a change-management and least-privilege failure inside the compliance tool itself. Blind spot: the shared state may hold work colleagues expect to keep seeing locally, and a re-encryption migration is a one-way step with its own risk. If wrong: a branch migration or a compromised laptop alters or exposes production evidence during an audit period. Security risk flagged by both.
- **UC3 Fork ownership contract.** You said nothing about maintaining the fork. Both recommend: a short decision record (why self-host the fork rather than hosted Comp), a primary and backup maintainer, an upstream-merge cadence (weekly plus every upstream security commit), and upstream PRs for the generic fixes (cookie domain, readiness probe, pool size, revalidation, unsubscribe and portal URL bugs, server API base URL, proxy-aware rate limiting). Why: upstream ships security sweeps continuously and every fork-only edit becomes a merge conflict. Blind spot: upstream may not accept self-host changes quickly, and the decision record may conclude hosted Comp is better, which ends this plan. If wrong: security fixes lag on the system that holds evidence.
- **UC4 Infrastructure as code now.** You said: imperative scripts (`provision-build.sh`, `ecs-up.sh`, `cloudflare.ts`). Both recommend versioned, declarative configuration (Terraform with the AWS and Cloudflare providers) for ECR, CodeBuild, IAM, target groups, listener rules, security group, Service Connect, alarms, ACM and Cloudflare DNS, rules and Access; scripts remain only for image swaps, migrations and secret sync. Why: the plan already builds a stateless, partly idempotent IaC system (re-render logic, rotate and retire modes) with no drift detection. Blind spot: Revola has no IaC baseline, and Terraform must reference shared resources (`revola-production-alb`, `revola-cluster`) without owning them, which needs care to avoid accidental changes to other services. If wrong: drift and re-run bugs in hand-written provisioning.

#### Section 1: Architecture

Current scope: mode SELECTIVE EXPANSION (autoplan override); accepted rows CEO-2 through CEO-V9 as recorded; deferred CEO-E5 (now challenged by UC4), CEO-E6 (now challenged by UC2), CEO-E8; pending UC1 to UC4.

```
                    Cloudflare edge (ACM cert *.comp, Access app+portal [+api if UC1=A], transform adds X-Comp-Origin-Auth)
  browser ----HTTPS---->  |
                          v
            revola-production-alb :443 (shared)   rules: p1 api, p2 app, p3 portal (host+header) | p4 *.comp -> 403 | p5..62 other services
                 |                 |                   |
          comp-api-tg       comp-app-tg          comp-portal-tg          (comp-tasks-sg: 3000/3333 from ALB SG; 3333 self)
                 |                 |                   |
          [comp-api :3333] <--Service Connect-- [comp-app :3000]  [comp-portal :3000]
            |   ^  comp-api.comp.internal:3333 <--------------------------'
            |   |
            |   '---- HTTPS via Cloudflare ---- Trigger.dev cloud (prod: comp-api, comp-app projects)
            v
  Supabase Postgres (session pooler, verified TLS) + Storage (S3 API) | Upstash Redis | Gemini, OpenAI, Resend, Firecrawl, Browserbase
  NAT nat-0c959582c0eda33cd (single, shared) carries all task egress
```

Data flow, server-side API call (CEO-2): happy, app server calls `getServerApiBaseUrl()` then `http://comp-api.comp.internal:3333` with the user's cookies, API resolves the session; nil, `BACKEND_API_URL` unset falls back to `NEXT_PUBLIC_API_URL` (through Cloudflare, still works under option B, fails under A), so the guard test and the override test cover it; empty, empty string treated as unset (tested); error, Service Connect proxy down or api tasks draining returns `503` from Envoy, the page shows the app's error boundary and the ALB 5xx alarm does not see it (gap noted in Section 8).
State machine, origin header rotation (CEO-E9): `ONE_VALUE(v1) -> TWO_VALUES(v1,v2) [rules accept both] -> EDGE_SWITCHED(v2 sent) [edge probe passes] -> ONE_VALUE(v2)`; invalid transitions: switching the edge before the rules accept v2 (prevented by command order and the probe), retiring v1 before the probe passes (script refuses).
Coupling: new coupling to the shared ALB (priorities 1 to 4) and NAT; justified by reuse, but a mistake in rule 4's host pattern can shadow other services, so the listener-rules test asserts the exact host pattern.
Scaling: desired count 1 per service; 10x users hits the throttler first (fixed by CEO-RL), then the single api task's CPU; 100x needs autoscaling and a larger pooler budget (out of scope).
Single points of failure: one task per service (a deploy or crash is a short outage), the shared NAT, the Supabase pooler, Cloudflare. Accepted for an internal tool; CEO-E2 makes outages visible.
Security architecture: three entry hosts gated by origin header; API auth via `HybridAuthGuard` (session, API key, service token); Trigger calls with `x-service-token`; new endpoint `/v1/health/ready` is public and returns no details.
Production failure per integration: Supabase pooler exhaustion (CEO-T2), Cloudflare cert gap (CEO-TLS), Trigger env missing key (CEO-3), ACM validation stuck (Task 8 order), CodeConnections not authorized (Task 5 Step 2).
Rollback posture: `deploy.sh <previous sha>` plus `trigger-deploy.sh <previous sha>`, about 10 minutes, valid for one release under CEO-V7.
Elegance and platform: UC4 is the change that would make this obvious to a new engineer; the deploy kit could serve the fleet.
Decision gate: findings are covered by accepted rows; the Envoy-503 visibility gap goes to Section 8.

#### Section 2: Error & Rescue Map

```
  CODEPATH                         | WHAT CAN GO WRONG                         | CLASS
  getCookieDomain                  | no dot / does not cover host              | Error (boot)
  emailDomainAllowlist hook        | outside domain, no invite                 | APIError FORBIDDEN
  GET /v1/health/ready             | timeout / TLS / missing CA                | 503 reason code
  getServerApiBaseUrl callers      | Envoy 503, API down                       | fetch error / 5xx
  getRevalidateUrl                 | NEXT_PUBLIC_APP_URL unset                 | named Error
  schedule guard                   | env type unknown                          | returns false (skip)
  vendorWorkspaceDb                | dist missing                              | Error (deploy)
  trigger-env.ts                   | key without value                         | exit 1 naming key
  sync-secrets.ts                  | writes COMP_ORIGIN_AUTH*                  | refusal
  migration-guard                  | pending / extra / DB unreachable          | exit 1 / warn / exit 1
  deploy.sh                        | wrong arch, smoke fail, services-stable timeout | exit 1 + rollback hint
  ecs-up.sh                        | cert not ISSUED, rule priority taken      | exit 1
  cloudflare.ts                    | token scope missing, API 4xx              | exit 1 naming call
  throttler tracker                | no CF header                              | falls back

  CLASS                      | RESCUED? | ACTION                               | USER SEES
  Error (boot)               | N (by design) | task fails health, alarm fires  | old task keeps serving during deploy
  APIError FORBIDDEN         | Y        | sign-up refused with domain message  | clear refusal
  503 reason                 | Y        | smoke fails, deploy exits            | operator sees reason code
  fetch error / 5xx (server) | Y        | Next error boundary                  | error page; GAP: no alarm (Section 8)
  named Error (revalidate)   | Y        | Trigger run fails visibly            | stale page until next load
  deploy exit 1              | Y        | rollback command printed             | operator only
  services-stable timeout    | N <- GAP | deploy.sh must print events and the failing task's stopped reason | operator guesses
```
Gap resolved by auto-decision: `deploy.sh` prints the last 10 service events and each stopped task's `stoppedReason` when `services-stable` times out (added to CEO-E4's test list).

#### Section 3: Security & Threat Model

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| Direct-to-ALB request skipping Cloudflare | Med | High | Yes: header rules plus priority-4 `403` |
| Sign-up by outsiders auto-approved (`SELF_HOSTED`) | Med | High | Yes: Access plus CEO-E1 |
| Laptop compromise exposes production keys | Med | High | No: UC2 |
| Account-wide secret read via shared role | Low | High | Yes: CEO-V2 |
| Bypass path abused | Low | Med | Yes: routes keep tokens, CEO-BX verifies |
| Origin header leak | Low | High | Partly: rotation (CEO-E9); value never printed |
| Offboarded user keeps API access | Med | High | Tested: CEO-V4; enforcement depends on app auth |
| Rate limit sharing causing self-DoS | High | Med | Yes: CEO-RL |
| Sensitive context in Trigger logs | High | Med | Recorded: CEO-V6; scrub deferred |
| New dependency risk | Low | Low | None added beyond AWS SDK and Trigger SDK already present |
Audit logging: existing `AuditLogInterceptor` covers API mutations; infra changes are logged by CloudTrail; no new gap.

#### Section 4: Data flow and interaction edge cases

```
  RELEASE: sha -> CodeBuild (build) -> ECR digests -> migration-guard(sha) -> [operator: migrate deploy] -> deploy.sh (ECS x3)
           -> smoke -> trigger-deploy.sh (env upload, deploy x2) -> release record
  shadows: build fails (no tags; deploy rejects unknown tag) | guard: DB unreachable (exit 1) | pending (exit 1) | extra (warn)
           ECS partial: api new, app old (one-release compatibility via CEO-V7) | smoke fails (rollback hint)
           Trigger deploy fails after ECS succeeded (workers old, API new: same compatibility window; release record marks partial)
```
Async ordering (shared state: database schema). Invariant: no running code version expects a schema newer than the applied one. Order 1: migrate then deploy (safe). Order 2: deploy then migrate (new code on old schema, unsafe), prevented by the migration guard before `update-service`. Trigger tasks queued before a release run on the new worker after deploy; payload compatibility across one release is covered by CEO-V7. Regression proof: `deploy.test.sh` asserts the guard runs before any `update-service` call.
Interaction edges: double-running `deploy.sh` concurrently (gap; auto-decided: a lock via an SSM parameter `comp/deploy-lock` with owner and expiry, refused when held); `ecs-up.sh` re-run (CEO-UP); browser on a stale tab after deploy (Next handles chunk errors with a reload; no change).

#### Section 5: Code quality

New modules are small and single-purpose (cookie domain, allowlist, readiness, base URL, revalidate URL, schedule guard, migration guard), matching the `origin-policy.ts` pattern. `auth.server.ts` (591 lines) only gains imports and one hook entry. Duplication: `getServerApiBaseUrl` exists twice (app and portal), justified because the apps do not share a server utility package; `assemble-api-context.sh` duplicates upstream's buildspec, guarded by CEO-V8. Over-engineering risk: the two-option Task 8 (CEO-A8) disappears once UC1 is decided. No method exceeds five branches in the described designs except the throttler tracker, which stays a flat lookup chain.

#### Section 6: Test review

```
  NEW THING                      TYPE         HAPPY                     FAILURE                         EDGE
  cookie domain                  unit         .comp.revola.ai           no dot, not covering            unset, staging
  email allowlist                unit         revola.ai                 other domain                    invite pending/expired, case
  readiness probe                unit+smoke   200                       503 P1011, ca_file_missing      timeout
  rate-limit tracker             unit         CF header buckets         no header fallback              service token caller
  server base URL + guard        unit+scan    BACKEND_API_URL           unset -> public                 empty string
  revalidate/unsubscribe URL     unit+scan    app origin                unset throws                    trailing slash
  schedule guard                 unit+scan    PRODUCTION runs           DEVELOPMENT skips               opt-in flag
  vendorWorkspaceDb              unit         copies dist               missing dist                    -
  secret keys / overrides        unit         mapping                   unknown key                     per-service exclusivity
  trigger env keys               unit         superset                  unmapped read                   intentionally unset
  ECS env coverage               scan         all mapped                unmapped read                   packages
  task definition render         unit         ARM64, roles, SC port     -                               overrides vs secrets
  listener rules                 unit         p1-p4                     -                               two header values
  cloudflare config              unit         option A / B              bypass covers /                 preflight flag
  migration guard                unit+stub    none                      pending                         extra, lock file
  deploy.sh                      stub         full run                  wrong arch, smoke fail, lock    secret never printed
  images                         smoke        node 22, CA, ready 200    ready 503 without CA            -
  release record                 unit         all fields                missing digest                  -
  end to end                     manual       CEO-5, CEO-V4, CEO-V1     offboarded user 401             burst no 429
```
Friday 2am test: the fresh-profile sign-in plus offboarding revocation check. Hostile QA: direct ALB request with a guessed header, and an outside-domain sign-up through the API under option B. Chaos: stop the api task mid-request and confirm the alarm and the app's error page. Flakiness: scan tests are deterministic; the smoke depends on Supabase and is marked as an operator test, not CI.

#### Section 7: Performance

No new database queries beyond `SELECT 1`, the invitation lookup on sign-up (indexed by email, check exists in Task 1) and `_prisma_migrations` reads. Connection pools are bounded by CEO-P1 and CEO-T2. Slowest new paths: server-rendered pages now go through Envoy (sub-millisecond added), cross-region database latency if Supabase is not in `us-east-2` (CEO-V5 measures it). Trigger job sizing is unchanged from today.

#### Section 8: Observability

Logs go to `/ecs/comp-*` (30 days). Metrics and alarms per CEO-E2. Gap: errors on the Service Connect path (Envoy 5xx) are invisible to ALB alarms; auto-decided: one alarm on the `AWS/ECS` Service Connect `HTTPCode_Target_5XX_Count` for `comp-api` (added to CEO-E2, total 10 alarms). Runbook entries (in `docs/self-hosting-aws.md`): alarm fired, deploy failed, rotation, restore, add or remove a person. Debuggability three weeks later: release records plus CloudWatch logs; request IDs are not propagated across Service Connect (accepted for now).

#### Section 9: Deployment and rollout

Order: Tasks 1 to 4 (code) -> Task 5 (build) -> Task 6 (secrets) -> recovery gate CEO-V1 -> Task 7 (ECS, `--skip-smoke`) -> Task 8 (Cloudflare, smoke, CEO-5) -> Task 9 (Trigger) -> Task 10 (acceptance, cutover). Feature flags: none needed; the hosted app is new. Mixed-version window: covered by CEO-V7. Post-deploy: first 5 minutes the smoke and alarms; first hour, Trigger runs succeed in `prod`. Concurrency lock for deploys added in Section 4.

#### Section 10: Long-term trajectory

Debt: imperative provisioning (UC4), shared state (UC2), fork drift (UC3), two-option Task 8 until UC1. Reversibility 4/5: DNS and ALB rules are removable in minutes; the data migrations in UC2 would be one-way. Phase 2: build-on-merge (CEO-E7), CodeBuild release runner, staging. Retrospective: the deferred items E5 and E6 turned out load-bearing (both voices), which is why they return as UC4 and UC2.

#### Section 11: Design

SKIPPED (no UI scope).

#### NOT in scope

- Deferred (filed by CEO-O1): migrations as an ECS task (CEO-E8), Trigger log scrubbing of company context (from CEO-V6), CodeBuild as the release runner (taste), request-ID propagation across Service Connect.
- Challenged, pending the gate: IaC (UC4), production and development separation (UC2), fork ownership contract (UC3).
- Rejected: Container Insights on the shared cluster (cluster-wide change); renaming hosts to first-level subdomains (would widen the cookie domain to `.revola.ai`).

#### What already exists

See 0B; additionally the API's `HybridAuthGuard`, `ThrottlerModule`, the app's revalidate route and `AuditLogInterceptor` are reused unchanged in role.

#### Dream state delta

After this plan (with accepted rows): hosted, monitored, recoverable, released by documented scripts with records. Remaining to the 12-month ideal: separated environments (UC2), IaC (UC4), automatic build and release, an owned upstream cadence (UC3).

#### Failure Modes Registry

```
  CODEPATH              | FAILURE MODE                     | RESCUED? | TEST? | USER SEES        | LOGGED?
  browser -> api (opt A)| Access 302 on XHR                | N        | Y (CEO-5) | broken app    | CF logs   <- blocks cutover until UC1
  server -> api         | Envoy 503                        | Y        | N     | error page       | Y (SC alarm)
  sign-in cookie        | wrong domain                     | Y (boot) | Y     | none (old task)  | Y
  Trigger -> api        | missing env key                  | Y        | Y     | job fails        | Y
  Trigger -> revalidate | wrong host                       | Y        | Y     | stale page       | Y
  dev trigger           | schedule double-fire             | Y        | Y     | none             | Y
  deploy                | schema ahead of code             | Y        | Y     | none             | Y
  deploy                | concurrent runs                  | Y        | Y     | none             | Y
  edge TLS              | cert missing for *.comp          | Y        | Y     | TLS error        | Y
  recovery              | restore untested                 | Y (V1)   | Y     | data loss        | Y
  shared state          | laptop writes prod (UC2)         | N        | N     | silent change    | N  <- CRITICAL GAP until UC2
```
Critical gaps: 1 (shared production state, pending UC2).

#### Stale diagram audit

The spec's section 3 diagram omits Service Connect and the Access scope choice; Task 10 updates it alongside the priority fix.

#### CEO Completion Summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW - COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | priorities 5-62 in use; secret:* role; no   |
  |                      | Service Connect; server calls hit public URL|
  | Step 0               | 4 user challenges; 30 accepted rows         |
  | Section 1  (Arch)    | 3 issues found                              |
  | Section 2  (Errors)  | 14 error paths mapped, 2 GAPS (both closed) |
  | Section 3  (Security)| 10 threats, 4 High impact, 1 unmitigated    |
  | Section 4  (Data/UX) | 9 edge cases mapped, 1 unhandled (closed)   |
  | Section 5  (Quality) | 2 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps after amendments   |
  | Section 7  (Perf)    | 1 issue found (cross-region, measured)      |
  | Section 8  (Observ)  | 2 gaps found (1 closed, 1 accepted)         |
  | Section 9  (Deploy)  | 3 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 4           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (8 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 14 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 11 total, 1 CRITICAL GAP (UC2)              |
  | TODOS.md updates     | 5 items proposed (GitHub issues, CEO-O1)    |
  | Scope proposals      | 39 proposed, 34 accepted (EXP + SEL)        |
  | CEO plan             | written                                     |
  | Outside voice        | codex completed                             |
  | Lake Score           | N/A (no scored user questions)              |
  | Diagrams produced    | 6 (architecture, data flow, state, error,   |
  |                      | release sequence, consensus)                |
  | Stale diagrams found | 1                                           |
  | Unresolved decisions | 4 (UC1-UC4, at the final gate)              |
  +====================================================================+
```

### Design review (Phase 2)

Skipped: no UI scope detected (the only matches were "dashboard" for the Trigger.dev dashboard and "layout" for the `dist` layout). This is a skip, not a completed review.

### DX review (Phase 2.5, autoplan, 2026-10-05)

Mode: DX POLISH (autoplan override). Product type: Platform and operator tooling (`deploy/aws` kit), auto-decided (P6).

#### Developer Persona Card

```
TARGET DEVELOPER PERSONA
========================
Who:       A Revola operator: Kyle today, a second engineer later, comfortable with the AWS CLI but new to this repo's deploy kit
Context:   Releasing a merged commit, rolling back, rotating a secret, or recovering during an incident
Tolerance: About 5 minutes of hands-on attention per release; zero tolerance for ambiguous next steps during an incident
Expects:   One command per intent, a preflight that catches wrong account or missing login, clear next-command errors, and a runbook with copy-paste blocks
```
Secondary audiences: implementing agents (execute one task at a time) and colleagues (end users who sign in).

#### Developer Empathy Narrative

I merged a fix to `revola/self-host` and need it live. The plan says: start a CodeBuild build, wait, find the 12-character tag, apply migrations "first when the commit adds any" (no command is given), run `deploy.sh <sha>`, then check out that exact SHA in a clean tree and run `trigger-deploy.sh`, which fails because `deploy.sh` just wrote a release record into `docs/releases/` and dirtied my tree. If Supabase is having a bad minute, the smoke fails and tells me to roll back, and the rollback fails the same way. If my shell has another AWS profile, nothing stops `ecs-up.sh` from creating resources in the wrong account. A colleague opening the app signs in twice with Google and, if nobody invited them first, lands in an empty organization. (Predicted from the plan text and verified code paths; nothing here was run.)

#### Competitive DX Benchmark

| Tool | Start to result | Time and evidence type | DX choice | Source |
|---|---|---|---|---|
| Render or Railway | git push to live | about 2 to 5 min, reported | push-to-deploy, auto rollback on failed health | vendor docs (in-distribution knowledge) |
| Fly.io | `fly deploy` to live | about 2 to 5 min, reported | one command, health-gated rollout | vendor docs (in-distribution knowledge) |
| AWS Copilot (end of support 2026-06-12) | `copilot deploy` to live | one command, CloudFormation rollback | build, push, deploy in one step | [AWS announcement](https://aws.amazon.com/blogs/containers/announcing-the-end-of-support-for-the-aws-copilot-cli/) |
| This plan (before DX) | merged SHA to verified release | 5 to 7 operator actions, about 15 min hands-on, 30 to 45 min wall clock, estimated | operator orchestrates scripts | plan text |
| This plan (after DX) | merged SHA to verified release | one command, under 2 min hands-on, wall clock bounded by the image build, estimated | `release.sh <ref>` | accepted DX obligations |

TTHW target (auto-decided, P5): Competitive tier for hands-on time (2 to 5 minutes; one command), measured from "SHA merged" to "smoke green and release record written". Champion (push to deploy) waits on CEO-E7 plus a release runner.

#### Magical Moment

`bash deploy/aws/release.sh revola/self-host` prints a preflight table (account, region, tools, tags present), runs each stage with one status line, and ends with three green smoke lines, the app URL and the release record location. Vehicle: a wrapper over the existing scripts (lowest effort reaching the tier, P5).

#### Dual voices (DX)

Claude subagent: completed (INPUT `dx aa521e6e...` matches the voice snapshot), 2 critical, 9 high, 9 medium findings.
Codex (`gpt-6-astra`): completed, dimension scores 3/5/4/3/2, 8 high and 2 medium findings.

```
DX DUAL VOICES - CONSENSUS TABLE:
  Dimension                           Claude          Codex            Consensus
  1. Getting started < 5 min?          No (3/10)       No (3/10)        CONFIRMED gap: one release command
  2. API/CLI naming guessable?         Partly (5)      Partly (4)       CONFIRMED gap: no single entry point
  3. Error messages actionable?        Partly (6)      Partly (5)       CONFIRMED gap: next command missing
  4. Docs findable & complete?         No (4)          No (3)           CONFIRMED gap: runbook vs decisions mixed
  5. Upgrade path safe?                No (smoke trap) No (2, rollback) CONFIRMED gap: rollback and hatches
  6. Dev environment friction-free?    No (no gates)   No (no gates)    CONFIRMED gap: deploy code unchecked
```
Both voices independently found that the CEO addenda contradict the task bodies an agent would execute (Claude C1, Codex 7).
Single-voice criticals: Claude C2 (UC1 option undefined in the plan; addressed by the decisions table) and Codex's release-record dirtying the tree (verified by reading CEO-V3 against CEO-T1).

#### Developer Journey Map

```
STAGE           | DEVELOPER DOES                                | FRICTION POINTS                                 | STATUS
----------------|-----------------------------------------------|-------------------------------------------------|--------
1. Discover     | finds deploy docs                             | README says deployment "coming soon"            | fixed (DX-DOC)
2. Install      | first bring-up across 6 consoles              | no order, no prerequisites, no account guard    | fixed (DX-ORDER, DX-PRE)
3. Hello World  | first release of a merged SHA                 | 5-7 commands, tree dirtied, no migrate command  | fixed (DX-REL, DX-MIG, DX-REC)
4. Real Usage   | secret change, single-service hotfix          | no restart path, all-or-nothing deploys         | fixed (DX-RST, DX-SVC)
5. Debug        | alarm fires, deploy fails, 403s               | no troubleshooting table, no log commands       | fixed (DX-DOC)
6. Upgrade      | rollback, upstream merge                      | rollback keeps new config; tests not gated      | fixed (DX-RB, DX-GATE); UC3 pending
```

#### First-Time Developer Confusion Report

```
FIRST-TIME DEVELOPER REPORT
Persona: second Revola engineer, first release
T+0:00  Opens README: deployment "coming soon". Searches docs/, finds self-hosting-aws.md (addressed: DX-DOC link).
T+1:00  Runs aws codebuild start-build with a branch name; cannot tell which tag to deploy (addressed: release.sh resolves refs).
T+3:00  "Migrations first": no command; guesses prisma migrate deploy with local .env (addressed: DX-MIG).
T+6:00  deploy.sh fails with "unauthorized" from docker imagetools (addressed: ECR API instead of Docker).
T+9:00  trigger-deploy.sh refuses: tree dirty from the release record (addressed: DX-REC).
T+12:00 Gives up, asks Kyle (addressed by the one-command path and runbook).
```

#### Passes 1-8

Pass 1 Getting started: 3 -> 7. One command per intent (`release.sh`), preflight, bring-up order; residual: first bring-up still spans consoles and takes days by nature.
Pass 2 CLI design: 4 -> 7. One entry point with `preflight`, `status`, `release`, `rollback`, `restart`, `logs`; `--service` and `--project` selectors; 12-character tags everywhere.
Pass 3 Errors: 5 -> 8. Every script error names stage, cause, resource, next command and retry safety; examples fixed for cookie domain, wrong account, wrong arch, missing tag, pending migration, held lock.
Pass 4 Docs: 3 -> 7. Runbook (copy-paste recipes) separated from architecture and decisions; troubleshooting table; log commands; colleague guide; README link.
Pass 5 Upgrade and rollback: 2 -> 7. Rollback by previous task definition ARNs and pinned secret versions; migration checksums and failed rows; DB-outage hatch; residual: upstream cadence (UC3).
Pass 6 Dev environment: 4 -> 7. `deploy/aws` becomes a workspace with typecheck, lint and test; shell tests in the gate; `packages/db` scripts tests included; prod-DB footgun guard; CI script-name bug fixed.
Pass 7 Community: 5 -> 6. Internal tool; the colleague guide names a support contact; upstream-relations live in UC3.
Pass 8 Measurement: 2 -> 6. `release.sh` prints stage timings into the release record, giving hands-on and wall-clock TTHW per release; a second-engineer timed release is an acceptance item.

#### DX Scorecard

```
+====================================================================+
|              DX PLAN REVIEW - SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
| Getting Started      |  7/10  |  3/10  |  +4    |
| API/CLI/SDK          |  7/10  |  4/10  |  +3    |
| Error Messages       |  8/10  |  5/10  |  +3    |
| Documentation        |  7/10  |  3/10  |  +4    |
| Upgrade Path         |  7/10  |  2/10  |  +5    |
| Dev Environment      |  7/10  |  4/10  |  +3    |
| Community            |  6/10  |  5/10  |  +1    |
| DX Measurement       |  6/10  |  2/10  |  +4    |
+--------------------------------------------------------------------+
| TTHW                 | <2 min hands-on | ~15 min hands-on | down    |
| Competitive Rank     | Competitive (hands-on)                       |
| Magical Moment       | designed via release.sh summary              |
| Product Type         | Platform / operator tooling                  |
| Mode                 | POLISH                                       |
| Overall DX           |  7/10  |  4/10  |  +3    |
+====================================================================+
| Zero Friction      | covered (one command, preflight)              |
| Learn by Doing     | covered (dry-run, copy-paste recipes)         |
| Fight Uncertainty  | covered (next-command errors, status)         |
| Opinionated + Escape Hatches | covered (--skip-smoke --reason, --break-lock) |
| Code in Context    | covered (real commands in runbook)            |
| Magical Moments    | covered (release summary)                     |
+====================================================================+
```

#### DX Implementation Checklist

```
[ ] Time to hello world (merged SHA to verified release) < 5 min hands-on, one command
[ ] Installation is one command: deploy/aws/release.sh preflight passes on a fresh laptop after documented prerequisites
[ ] First run produces meaningful output: preflight table and per-stage status lines
[ ] Magical moment delivered via release.sh summary (green smokes, URL, record location)
[ ] Every error message has: problem + cause + next command + retry safety
[ ] CLI naming guessable: release.sh {preflight,status,release,rollback,restart,logs}
[ ] Every flag has a sensible default (all services, all projects, current lock TTL)
[ ] Runbook has copy-paste examples that work as written
[ ] Examples cover release, rollback, secret change, single-service hotfix, rotation, add user
[ ] Rollback restores task definitions and pinned secret versions from the release record
[ ] deploy/aws code is typechecked, linted and tested by repo gates
[ ] Works non-interactively except explicit confirmations
[ ] Release record written outside the checkout; stage timings recorded
```

#### NOT in scope (DX)

Push-to-deploy (needs CEO-E7 plus a release runner, deferred); a web status page for releases; Terraform modules (UC4 pending).

#### What already exists (DX)

`--dry-run` on mutating scripts, name-only secret output, `vendorWorkspaceDb`'s actionable error, readiness reason codes, `INTENTIONALLY_UNSET` reasons, `COMP_RUN_SCHEDULES_IN_DEV`, Revola's manual deploy procedure, upstream's Trigger workflows (to be disabled on the fork) and `deploy:trigger-prod` scripts (to call `trigger-deploy.sh`).

### DX Implementation Tasks
- [ ] **D1 (P1, human: ~4h / CC: ~15min)** - plan - Fold all accepted obligations into task bodies after the gate (DX-FOLD). Verify: no superseded text remains.
- [ ] **D2 (P1, human: ~2d / CC: ~1.5h)** - deploy - `config.ts`, preflight, `release.sh` with subcommands, migrate command, lock, partial deploys, restart, hatch (DX-PRE, DX-REL, DX-MIG, DX-SVC, DX-RST, DX-HATCH). Verify: `bash deploy/aws/tests/release.test.sh`.
- [ ] **D3 (P1, human: ~1d / CC: ~40min)** - deploy - Release records in S3, rollback by task definition ARNs and pinned secret versions (DX-REC, DX-RB). Verify: release-then-rollback test.
- [ ] **D4 (P1, human: ~2h / CC: ~10min)** - app - Liveness route for the ALB (DX-LIVE). Verify: `cd apps/app && npx vitest run src/app/api/health`.
- [ ] **D5 (P1, human: ~4h / CC: ~20min)** - trigger - Reproducible Trigger builds, CA extension fix, disable upstream workflows (DX-TRIG). Verify: fresh-worktree preparation.
- [ ] **D6 (P1, human: ~4h / CC: ~20min)** - repo - Workspace and gates for `deploy/aws`, db scripts tests, CI script name (DX-GATE). Verify: `bun run typecheck && bun run test`.
- [ ] **D7 (P2, human: ~4h / CC: ~20min)** - deploy - Safe secret sync, production DB guard (DX-SYNC, DX-GUARD). Verify: unit tests.
- [ ] **D8 (P2, human: ~1d / CC: ~30min)** - docs - Runbook, troubleshooting, colleague guide, README link, bring-up order, ALB 403 body, error texts, timing (DX-DOC, DX-COL, DX-ORDER, DX-403, DX-ERR, DX-TIME). Verify: second-engineer timed release.

<!-- autoplan-accepted:dx -->
- DX-FOLD Plan consolidation before execution: after the final gate decides UC1 to UC4 and the taste items, every accepted CEO and DX obligation is folded into its task's Files, Interfaces, steps and commit; superseded text (for example `PRODUCTION_OVERRIDES`, `ecsTaskExecutionRole` for Comp, the wildcard Access test, the 7-character tag, Review Focus 4's "TLS error class") is deleted; Task 2b becomes a numbered task; Global Constraints match. A "Decisions" table at the top lists each gate decision, its answer and the tasks it changes. Verify: a reviewer reading any single task sees no instruction that another section overrides.
- DX-PRE Shared config and preflight: `deploy/aws/config.ts` (zod-validated constants: account, region, cluster, ALB, SG, VPC, subnets, hosts, Trigger CLI version read from `apps/*/package.json`, UC1 option) and a generated `deploy/aws/config.env` for shell scripts; every script first runs a preflight that checks `aws sts get-caller-identity` returns account `455986776194` and region `us-east-2` ("wrong AWS account X, expected 455986776194; set AWS_PROFILE=..."), required tools and versions (aws v2, bun, git, curl), and for Cloudflare and Trigger steps the token or login. Test: stubbed wrong account exits non-zero before any mutating call.
- DX-REL One release entry point: `deploy/aws/release.sh` with subcommands `preflight`, `status`, `release <ref>`, `rollback [<release-id>]`, `restart [--service X]`, `logs <service>`. `release` resolves the ref to a 12-character SHA, starts or reuses the CodeBuild build and waits, verifies all three ECR tags and their `linux/arm64` manifests through `aws ecr batch-get-image` (no Docker), takes the release lock, runs the migration guard, `deploy.sh`, the smoke, and `trigger-deploy.sh` (from a temporary worktree under `.worktrees/release-<sha>` so the operator's checkout is untouched), records stage timings, and prints the summary. Errors name the stage, cause, resource, next command and whether retry is safe. Test: `release.test.sh` with stubs covers success, missing tag, failed guard, failed smoke and resume.
- DX-MIG Migration command and stronger guard: `deploy/aws/migrate.ts --sha <sha>` applies migrations from that SHA's tree (extracted with `git archive` into a temp dir outside the repo, run with the main checkout's pinned Prisma) using `DATABASE_URL` read from `comp/production/config` (never local env files, never printed); the guard also fails on `_prisma_migrations` rows that are started but unfinished and not rolled back, and on a checksum mismatch between the applied row and `sha256` of that SHA's `migration.sql`; its pending-migration message prints the exact `migrate.ts` command. Tests: wrong-target host refused, failed row, modified migration, lock file ignored.
- DX-REC Release records outside the checkout: CEO-V3 records go to an S3 bucket `comp-release-records-455986776194` (versioned, created by `ecs-up.sh`), written once after both ECS and Trigger stages finish, plus a partial record when a stage fails; `release.sh status` and `rollback` read them. This replaces CEO-V3's `docs/releases/` path.
- DX-RB Rollback restores configuration: task definitions reference secrets with pinned version IDs (`<arn>:KEY::<version-id>`); `release.sh rollback` calls `update-service` with the previous record's task definition ARNs (immutable revisions) instead of cloning and swapping, and redeploys Trigger at the previous SHA with the previous record's env snapshot; a record marked forward-fix-only (CEO-V7) makes rollback refuse with an explanation. ECR lifecycle keeps every image referenced by the last 10 records. Test: release with a config change, then rollback restores the prior task definition ARN.
- DX-RST Secret change path: `release.sh restart [--service X]` re-renders task definitions with the latest secret version IDs (CEO-UP logic), deploys them, runs the smoke, and re-uploads Trigger env with `trigger-env.ts` run standalone; runbook recipe "change a secret" is sync, then restart.
- DX-SVC Partial deploys and lock: `--service api|app|portal` (repeatable) and `--project api|app`; the release record lists what changed; one lock covers the whole `release.sh` run with a 30-minute TTL refreshed while waiting; a held lock prints owner, expiry and `release.sh --break-lock` (confirmed and logged).
- DX-HATCH Incident hatch: `--skip-smoke --reason "<text>"` is allowed at any time with a loud warning and the reason stored in the release record; `--smoke=liveness` uses `/v1/health` and `/api/health/live`. Supersedes CEO-E4's certificate-only restriction (the certificate check stays the default behaviour).
- DX-LIVE App liveness: new dependency-free `apps/app/src/app/api/health/live/route.ts` (like Task 2's portal route) is the ALB target-group health path for the app; the existing `/api/health` (`SELECT 1`) becomes the app's readiness check used by the smoke. Test mirrors Task 2's.
- DX-TRIG Reproducible Trigger builds: `trigger-deploy.sh` builds every package the Trigger extensions require (`packages/db`, `packages/email`, `packages/integration-platform`, by turbo filter) in the temporary worktree; `caBundleExtension` uses the committed Supabase CA and no longer requires the untracked `packages/db/certs/rds-global-bundle.pem`; the script prints the Trigger project ref and environment before uploading. Upstream's `.github/workflows/trigger-*-deploy-*.yml` are disabled on the fork and `deploy:trigger-prod` scripts call `trigger-deploy.sh`. Test: preparation from a fresh worktree with no `dist` and no local certificates succeeds.
- DX-SYNC Safe secret sync: each `SECRET_KEYS` entry maps to exactly one source env file; disagreement between files fails naming key and files (never values); a missing key fails with "KEY not found in <file>; add it or list it in INTENTIONALLY_UNSET"; before writing, a name-only diff (added, removed, changed by hash) prints and removal requires confirmation.
- DX-GATE Repo gates cover deploy code: `deploy/aws` becomes a workspace (`package.json` with zod and `@trigger.dev/sdk`, `tsconfig`, `typecheck`, `lint` with shellcheck, `test` running bun tests and the shell tests); `packages/db`'s test script includes `scripts`; `.github/workflows/check-types.yml` calls the existing `typecheck:ci` (today it calls a missing `type-check:ci`). Verify: `bun run typecheck` and `bun run test` from the root include `deploy/aws`.
- DX-GUARD Production database footgun: `packages/db` scripts refuse `prisma migrate dev`, `migrate reset` and `db:seed` when the `DATABASE_URL` host matches the production pooler host recorded in `deploy/aws/config.ts`, unless `COMP_I_AM_TOUCHING_PROD=1`; `docs/self-hosting-local.md` states prominently that local runs write production data until UC2 is resolved. Test: guarded and opted-in cases.
- DX-COL Colleague path: `docs/self-hosting-local.md` gains "Using hosted Comp" (URL, why two Google sign-ins, wait for the invite email and do not create an organization, portal URL, support contact); the runbook says colleagues are invited in People first, and Access entries are only for people outside `@revola.ai`; the app shows "Sign-ups are limited to revola.ai; ask an admin for an invite" when CEO-E1 rejects a sign-up.
- DX-DOC Documentation layout: `deploy/aws/README.md` is the operator runbook (prerequisites, bring-up order, release, rollback, single-service deploy, secret change, rotation, add user or auditor, break lock, logs with exact `aws logs tail` commands, troubleshooting table: ALB 403, Access CORS, lost session, readiness 503 codes, exec format error, Service Connect name, 429s, Trigger missing env); `docs/self-hosting-aws.md` holds architecture and decisions; acceptance evidence lives in its own dated file; the root README's "coming soon" deployment section links to both.
- DX-ORDER Bring-up order: the runbook opens with the phase list (decisions, tokens, Supabase gate, build, secrets, ECS without listener rules, validation and ACM, listener rules and smoke, edge, Trigger, acceptance), each with its prerequisites and outputs, and `ecs-up.sh` is resumable by phase (`--phase <name>`), exiting with the next command when it waits on ACM validation.
- DX-403 ALB 403 body: the priority-4 fixed response returns `text/plain` "comp-alb: origin header missing or invalid"; the listener-rules test asserts it and CEO-BX's fixture matches against it.
- DX-ERR Named error texts: `getCookieDomain` errors include an example and the variable's source; the wrong-arch abort prints found and expected platforms and "rebuild with release.sh"; tests assert those texts.
- DX-TIME Measurement: release records carry stage timings and hands-on prompts; acceptance includes a second engineer completing a release from the runbook, with hands-on and wall-clock time recorded.
<!-- /autoplan-accepted:dx -->

### Eng review (Phase 3, autoplan, 2026-10-05)

Scope gate: user-named target, `docs/plans/2026-10-05-aws-hosting.md` in worktree `aws-hosting-plan-030916`.
Scope Challenge: about 45 changed files and 6 new runtime pieces (three services, Service Connect namespace, release kit, alarms); complexity gate tripped; autoplan override "never reduce" keeps the original arrangement, with `release.sh` (DX-REL) already consolidating the script surface. Result: scope accepted as-is (FULL_REVIEW).
What already exists: see CEO 0B and DX "What already exists"; additionally `packages/db` `resolveSslConfig`, the app's `/api/health` (database-touching), upstream `apps/api/buildspec.yml` assembly, `HybridAuthGuard`, `ThrottlerModule`, `adminAuthRateLimiter`, `people.service` offboarding (sessions only), `acting-user.service` owner fallback.

#### Dual voices (Eng)

Claude subagent: completed (INPUT `eng c7074c24...` matches the voice snapshot), 2 critical, 7 high, 10 medium, 9 low.
Codex (`gpt-6-astra`): completed, 9 P1 and 2 P2.

```
ENG DUAL VOICES - CONSENSUS TABLE:
  Dimension                           Claude                 Codex                     Consensus
  1. Architecture sound?               No (amendments, image)  No (stale client, config)  CONFIRMED gaps
  2. Test coverage sufficient?         No (assets, real DB)    No (rotation, storage)     CONFIRMED gaps
  3. Performance risks addressed?      No (build OOM, size)    No (pools bypass cap)      CONFIRMED gaps
  4. Security threats covered?         No (cookie, header leak) No (API keys, TLS policy) CONFIRMED gaps
  5. Error paths handled?              No (reason codes)       No (TLS readiness)         CONFIRMED gaps
  6. Deployment risk manageable?       No (lock, deps)         No (config, lock)          CONFIRMED gaps
```
Both voices again single out UC2 (shared production state) as the largest risk, and both prefer UC1 option B on complexity grounds; both are recorded at the gate, not auto-applied.
Verified in code before acceptance: `apps/api/prisma/client.js` is tracked and keys TLS on `NODE_EXTRA_CA_CERTS`; `apps/{api,app,portal}/prisma/client.ts` build their own `PrismaPg` without `max`; `acting-user.service.ts:82` falls back for deactivated creators; `process-knowledge-base-document.ts` builds `S3Client` without an endpoint; `ssl-config.ts:29-35` skips hostname checks without a CA.

#### Section 1: Architecture

```
  CodeBuild (ARM, LARGE) --bake--> ECR comp-{api,app,portal}:<12-sha> (no attestations)
        |                                   |
  release.sh (lock: SSM put-parameter, owner-checked) ----------------------------------------+
        |-- preflight (account, region, tools)                                                 |
        |-- migration guard (git ls-tree + _prisma_migrations checksums) -- migrate.ts         |
        |-- render task defs from release commit (pinned secret versions, comp-task-execution-role)
        |-- ECS update api -> app -> portal --> services-stable --> smoke (/ready, /api/health)
        |-- trigger-deploy (temp worktree: build db, email, integration-platform; env upload; deploy)
        '-- S3 release record (digests, task def ARNs, trigger versions, secret versions, timings)

  Cloudflare (edge cert, Access app+portal [+api if A], header) -> ALB p1-p4 -> comp-*-tg
     app:3000 (live) --Service Connect--> api:3333 <-- portal:3000
     api --verified TLS (CA required in prod)--> Supabase pooler (pool max per process) | Storage (endpoint-aware S3) | Upstash
     Trigger prod --HTTPS--> api / app (revalidate) ; Trigger -> Supabase (vendored db + adapter deps)
```
Findings and dispositions:
[P1] (confidence 9/10) plan Tasks vs appended obligations: superseded text an executor would follow; accepted ENG-1 (fold is a hard gate with a superseded-identifier check).
[P1] (confidence 10/10) `apps/api/buildspec.yml:64` copies `prisma` including tracked `client.js` over compiled output; accepted ENG-4.
[P1] (confidence 9/10) CEO-UP/DX-REL: releases clone the running task definition, so config from the release commit never deploys; accepted ENG-6.
[P1] (confidence 10/10) `process-knowledge-base-document.ts:24`, `parse-questionnaire.ts:123`: S3 clients ignore `APP_AWS_ENDPOINT`; accepted ENG-9.
[P2] (confidence 8/10) under UC1 option A, expired api-host Access cookie breaks XHR; accepted ENG-18 as option-A requirements.
Low: ALB idle timeout 60 s and Cloudflare 100 s/100 MB limits; single task per service with in-memory throttler; deploy order api first (ENG-17).

#### Section 2: Code quality

[P1] (confidence 9/10) `getCookieDomain` validates only against `BASE_URL`; `.api.comp.revola.ai` or `.revola.ai` would pass (ENG-2).
[P2] (confidence 8/10) `cloudflare.ts` will exceed 300 lines; split by concern up front (ENG-17).
[P2] (confidence 9/10) shared adapter options duplicated across four Prisma clients; one helper in `packages/db` used by all (ENG-3) (shared-code rubric: four verified callers, same contract, reliability gain).
Dispositions: all accepted.

#### Section 3: Test review

```
CODE PATHS                                              USER FLOWS
[+] apps/api auth                                       [+] Sign-in (Access then better-auth)
  ├── getCookieDomain            [GAP->spec] app/portal    ├── [GAP] [->E2E] fresh profile, app and portal (CEO-5)
  ├── allowlist hook             [GAP->spec] invite case   └── [GAP] [->E2E] option A: expired api cookie
  ├── readiness /v1/health/ready [GAP->spec] tls_ codes  [+] Background jobs
  └── throttler tracker          [GAP->spec] forged hdrs   ├── [GAP] [->E2E] real prod DB task (ENG-5)
[+] packages/db                                            ├── [GAP] [->E2E] KB doc + questionnaire parse (ENG-9)
  ├── ssl policy (prod fail-closed) [GAP->spec]            └── [GAP] dev schedule skip (CEO-S1 scan)
  └── adapter options + pool max   [GAP->spec] 4 callers [+] Offboarding
[+] apps/app, portal                                       └── [GAP] [->E2E] session, API key, portal 401 (ENG-8)
  ├── server base URL helpers    [GAP->spec + guard]     [+] Release
  ├── revalidate/unsubscribe URL [GAP->spec + scan]        ├── [GAP] release.test.sh stages + resume
  └── /api/health/live           [GAP->spec]               ├── [GAP] config-adding release, rollback (ENG-6, DX-RB)
[+] images                                                 ├── [GAP] concurrent lock, lease loss (ENG-15)
  ├── static chunk, next/image   [GAP->smoke]              └── [GAP] token rotation overlap (ENG-7)
  ├── NEXT_PUBLIC scan + output grep [GAP->smoke]
  └── api client.js not shipped  [GAP->smoke]
[+] deploy/aws
  ├── arch check with attestations [GAP->unit]
  ├── listener rules, header alphabet, 403 body [GAP->unit]
  └── renderTaskDefinition (role, ARN suffix, env vs secrets, SC port) [GAP->unit]

COVERAGE (planned): every path above has a named test in the plan or the test-plan artifact; existing tests cover none of the new paths.
LLM/eval: no prompt or model changes; no eval suites required.
```
Test plan artifact written: `~/.gstack/projects/trycompai-comp/kylezhang-claude-aws-hosting-plan-030916-eng-review-test-plan-20261005-155455.md`.
Regression rule: the shared `packages/db` adapter change (ENG-3) puts every app's database access at risk; regression contract: existing `packages/db` tests plus one connection test per app client with CA set, CA missing in production (refuse), localhost (no TLS).

#### Section 4: Performance

[P1] (confidence 10/10) pool cap bypassed by app-local clients (ENG-3).
[P2] (confidence 8/10) CodeBuild memory and three parallel builds (ENG-13).
[P2] (confidence 7/10) API image carries dev dependencies and Next.js; slow pulls and rollbacks (ENG-4).
[P3] (confidence 6/10) readiness 2 s timeout can flake on cold cross-region TLS; ALB stays on liveness (no change).

#### Failure Modes Registry (Eng)

```
  PATH                         | FAILURE                          | TEST | HANDLING            | USER SEES
  api image                    | stale client.js shipped          | Y    | smoke fails         | none (blocked)
  app image                    | missing static, musl sharp       | Y    | smoke fails         | none (blocked)
  db TLS                       | CA missing in prod               | Y    | refuse + 503 reason | none (blocked)
  release                      | config not deployed              | Y    | render per release  | none
  rotation                     | ENCRYPTION_KEY changed           | Y    | prohibited by rule  | none
  offboarding                  | API key still valid              | Y    | revoke + reject     | none
  Trigger storage jobs         | wrong S3 endpoint                | Y    | shared client       | job error, alarm-less <- GAP until ENG-9
  shared prod DB (UC2)         | laptop writes prod               | N    | guard partial       | silent <- CRITICAL GAP pending UC2
```
Critical gaps: 1 (UC2, pending the gate).

#### Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| A API auth, health, throttle, offboarding | apps/api/src/auth, health, people | - |
| B App and portal server helpers, liveness, revalidate, schedules | apps/app, apps/portal | - |
| C db package: TLS policy, adapter options, guard | packages/db | - |
| D Images and build | deploy/aws (Docker, bake, buildspec) | A, B, C |
| E Deploy kit: config, release.sh, render, lock, records | deploy/aws (scripts) | C |
| F Cloudflare | deploy/aws/cloudflare* | E (config) |
| G Trigger: vendoring, extensions, storage client | apps/{api,app} trigger, packages/db/scripts | C |
Lanes: A, B, C in parallel (disjoint modules); then D, E, G in parallel (D and E share `deploy/aws` but different files: coordinate the workspace package.json first); F after E. Conflict flag: `packages/db` (C) is used by A, B, G, so merge C first.

#### NOT in scope (Eng)

Autoscaling and multi-task throttler storage (single task per service; documented); request-ID propagation; IaC (UC4 pending); environment split (UC2 pending); log scrubbing of Trigger prompts (filed).

#### Eng Completion Summary

- Step 0: Scope Challenge - scope accepted as-is
- Architecture Review: 5 issues found
- Code Quality Review: 3 issues found
- Test Review: diagram produced, 22 gaps identified (all now specified)
- Performance Review: 4 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 5 items (GitHub issues via CEO-O1; no TODOS.md in repo)
- Failure modes: 1 critical gap flagged (UC2)
- Unresolved decisions: 0 in this review (UC1 to UC4 and taste items sit at the autoplan gate)
- Outside voice: codex completed
- Parallelization: 7 steps, 3 parallel lanes then 3, 1 sequential
- Lake Score: N/A (no scored user questions)

### Eng Implementation Tasks
- [ ] **E1 (P1, human: ~4h / CC: ~20min)** - api - Cookie domain coverage, allowlist casing and OAuth error mapping, verified-identity throttling (ENG-2, ENG-11, ENG-16). Verify: `cd apps/api && npx jest src/auth`.
- [ ] **E2 (P1, human: ~1d / CC: ~40min)** - db - Shared adapter options, production TLS rule, reason codes, guard for all schema commands (ENG-3, ENG-10). Verify: `cd packages/db && bun test`.
- [ ] **E3 (P1, human: ~1d / CC: ~45min)** - images - Node 22 slim stages, standalone assets, schema prep, assembly without client.js, smoke additions, provenance off, CodeBuild sizing (ENG-4, ENG-12, ENG-13). Verify: `bash deploy/aws/tests/images.smoke.sh`.
- [ ] **E4 (P1, human: ~1d / CC: ~40min)** - deploy - Render-per-release, atomic lock, rotation classes, origin header hygiene, ops details (ENG-6, ENG-7, ENG-14, ENG-15, ENG-17). Verify: `bun run --filter deploy-aws test`.
- [ ] **E5 (P1, human: ~4h / CC: ~20min)** - trigger - Layer deps for vendored db, endpoint-aware storage client, prod DB task check (ENG-5, ENG-9). Verify: real prod task run.
- [ ] **E6 (P1, human: ~4h / CC: ~20min)** - api - Offboarding revokes creator keys (ENG-8, taste). Verify: jest with removed creator.
- [ ] **E7 (P1, human: ~1h / CC: ~10min)** - plan - Fold gate and superseded-identifier check (ENG-1). Verify: check passes on the folded plan.
- [ ] **E8 (P2, human: ~2h / CC: ~10min)** - edge - Option A requirements if chosen (ENG-18). Verify: CEO-5 cookie-cleared scenario.

<!-- autoplan-accepted:eng -->
- ENG-1 DX-FOLD is a hard gate: no task starts until the fold is done; a check (`deploy/aws/tests/plan-lint.test.ts` or a script in the workspace) fails if the plan still contains superseded identifiers (`PRODUCTION_OVERRIDES`, `ecsTaskExecutionRole` for Comp tasks, `docs/releases`, `--short HEAD`, Review Focus 4's "TLS error class").
- ENG-2 Cookie domain coverage: `getCookieDomain` requires `AUTH_COOKIE_DOMAIN` to cover the hosts of `BASE_URL`, `NEXT_PUBLIC_APP_URL` (or `APP_URL`) and `NEXT_PUBLIC_PORTAL_URL` (or `PORTAL_URL`) using `host === d.slice(1) || host.endsWith(d)`; throws when set while `BASE_URL` is missing or unparseable; rejects domains with fewer than three labels unless `AUTH_COOKIE_DOMAIN_ALLOW_BROAD=1`. Jest adds `.api.comp.revola.ai` (rejected: app not covered), `.revola.ai` (rejected), missing `BASE_URL` (throws).
- ENG-3 One database connection policy: `packages/db` exports `buildPgAdapterOptions({ databaseUrl, env })` used by `packages/db/src/client.ts` and `apps/{api,app,portal}/prisma/client.ts`; it applies `DATABASE_POOL_MAX` and a production TLS rule: when `NODE_ENV=production` and the host is not local, `DATABASE_SSL_CA` is required (or explicit `PRISMA_ALLOW_INSECURE_TLS=1`), otherwise it throws `ca_file_missing`. Readiness `reason` walks `err.cause` for a Node TLS `code` and returns `tls_<CODE>`, else a Prisma code, else `timeout` or `unknown`; the real Supabase error shape is captured once and used as the fixture. Supersedes CEO-P1's single-file scope and CEO-R1's `P1011` example.
- ENG-4 Image correctness: every runtime stage uses `node:22-slim`; build stages use `node:22-slim` with Bun copied from `oven/bun:1.3.4` and assert `node -v`; app and portal stages run the schema preparation `db:generate` path, set `SKIP_ENV_VALIDATION=1` for the build only, copy `.next/static` and `public/` into the standalone tree and set `HOSTNAME=0.0.0.0`; `.dockerignore` adds `**/dist`, `**/.next`, `**/.turbo`, `.git`; `assemble-api-context.sh` copies only schema assets from `apps/api/prisma` (never `client.js`), and the API runtime uses production-only dependencies; the image smoke asserts a static chunk referenced by `/` returns 200, one `/_next/image` request returns 200, the built output contains `api.comp.revola.ai` and not `localhost:3333`, every `NEXT_PUBLIC_*` read in code is a bake arg or `INTENTIONALLY_UNSET`, the API starts with only documented production config, and each image stays under a size threshold recorded in the plan.
- ENG-5 Trigger runtime dependencies: `vendorWorkspaceDb` adds `packages/db`'s `dependencies` (exact versions) to the layer and the test asserts them; before cutover one database-touching task runs in Trigger `prod`.
- ENG-6 Releases render config: `release.sh release` renders task definitions from the release commit's `renderTaskDefinition` with pinned secret versions and the image digest, registers them and records the revisions; clone-and-swap is removed. Test: a release that adds a required env var deploys it.
- ENG-7 Secret rotation semantics: secrets are classified (rotatable with overlap, rotatable by restart, never-rotate-without-procedure); the API accepts two service-token values during rotation (`SERVICE_TOKEN_*_PREVIOUS`) and the runbook retires the old after Trigger env is updated; `ENCRYPTION_KEY` rotation is refused by `sync-secrets.ts` (hash change blocked) until a versioned keyring and re-encryption procedure exist. Tests: overlap acceptance, refusal of an encryption-key change.
- ENG-8 Offboarding revokes API access (taste, provisional): removing a member revokes API keys they created; key validation rejects keys whose creator is inactive unless the key is explicitly marked organization-owned; `acting-user.service.ts`'s owner fallback applies only to legacy keys with no recorded creator. Tests: reads and mutations with a removed creator's key get 401.
- ENG-9 Endpoint-aware storage in jobs: Trigger tasks that touch application storage use one shared S3 client factory honoring `APP_AWS_ENDPOINT` and path-style access (customer-cloud scanning clients stay separate); acceptance covers knowledge-base document processing and questionnaire parsing.
- ENG-10 One production guard for all schema commands: `db:push` and the app-level Prisma scripts in `apps/{api,app,portal}/package.json` route through DX-GUARD's check.
- ENG-11 Rate limiting by verified identity: authenticated requests are throttled per session user or API key ID after authentication; unauthenticated requests use `CF-Connecting-IP` only when the request carries a valid origin header, else `req.ip`; no hop-count `trust proxy` arithmetic; `adminAuthRateLimiter` uses the same tracker; app and portal server calls forward a sanitized client IP and the portal stops forwarding arbitrary `x-*` headers. Supersedes CEO-RL's tracker details. Tests: forged headers ignored, two users through Service Connect get separate buckets, service-token caller separate.
- ENG-12 ECR and buildx: bake sets `provenance=false` and `sbom=false`; the arch check requires an arm64 entry and ignores attestation entries (fixture with attestations); the lifecycle policy protects `cache` with a higher-priority rule; record-based retention is a pruning script, not a lifecycle rule.
- ENG-13 CodeBuild sizing: `ARM_CONTAINER` with `BUILD_GENERAL1_LARGE`, `NODE_OPTIONS=--max-old-space-size` set in build stages, a build timeout, and app and portal built sequentially if parallel builds exceed memory.
- ENG-14 Origin header hygiene: `COMP_ORIGIN_AUTH` is 64 characters from `[A-Za-z0-9]` (ALB wildcard-safe, under 128); `buildListenerRules` tests the alphabet and length; the header is scrubbed from Sentry events and request logs in api, app and portal, with a test.
- ENG-15 Atomic deploy lock: acquire with `put-parameter` without overwrite; renew and release only when the stored owner matches; a process that loses the lease aborts before its next mutation; the lock covers migrations and every production-mutating subcommand. Tests: concurrent acquire, expiry takeover, stale owner abort.
- ENG-16 Allowlist edge cases: invitation lookup is case-insensitive; the OAuth-callback error path maps the allowlist rejection to the readable app message; tests for both.
- ENG-17 Operational details: `renderTaskDefinition` asserts the full secret ARN with its 6-character suffix; `comp-task-execution-role` includes `ecr:GetAuthorizationToken` on `*`; the runbook documents the ALB 60 s idle timeout, Cloudflare's 100 s origin timeout and 100 MB body cap; `release.sh` deploys api before app and portal; Task 8 Step 4 triggers a real job against a bypass path to confirm bot protection does not challenge it; `cloudflare.ts` is split into modules under 300 lines; the runbook notes that more than one task per service requires Redis-backed throttling.
- ENG-18 If UC1 option A is chosen: the Access session duration is at least the better-auth session length, the app turns an opaque redirect or CORS failure on API calls into a top-level navigation through an api-host bounce URL, and CEO-5 adds the "api-host Access cookie cleared, dashboard still loads" scenario.
- GATE-UC1 (approved by Kyle at the final gate, D2: option B): Cloudflare Access protects `app.comp.revola.ai` and `portal.comp.revola.ai` only; `api.comp.revola.ai` is proxied through Cloudflare with the origin header but no Access application, and is protected by its own auth (session, API key, service token), CEO-E1, ENG-11 and ENG-8. Superseded and removed: CEO-PF, ENG-18, the API-host parts of CEO-4 and CEO-A8, option A of CEO-PUB and CEO-E9. CEO-PUB becomes the option-B record: the runbook lists every `@Public()` route as internet-reachable with its own check, and for each feature Revola does not use it names the route and why its own guard suffices. `ACCESS_BYPASS_PATHS` holds only app-host machine paths (`/api/revalidate/path`). CEO-2 (Service Connect) stays accepted on its own merits. Acceptance CEO-5 keeps the fresh-profile check; offboarding (CEO-V4) is tested from a non-browser client against the public API host.
- GATE-UC2 (approved by Kyle at the final gate, D3: split): new Task 0 "Production state split", before Task 6 and the recovery gate. Steps: create a production Supabase project on the Pro plan in the region closest to `us-east-2` (record the choice), and a production Upstash database; generate fresh production values for `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SECRET_KEY`, `INTERNAL_API_TOKEN`, `SERVICE_TOKEN_*` and `REVALIDATION_SECRET` (third-party API keys may be shared or separate, decided per key in Task 6); apply migrations to the new database from the release SHA; copy data from the current shared project (schema-compatible dump and restore, recorded row counts per table, verified equal) and copy Storage objects bucket to bucket (object counts and checksums verified); re-encrypt integration credentials with a one-off `deploy/aws/reencrypt-credentials.ts` that decrypts with the old key and encrypts with the new one inside a transaction, has `--dry-run`, verifies every row decrypts with the new key afterwards, never prints plaintext, and is unit-tested with fixtures (round trip, wrong old key, partial failure rolls back). The existing shared project becomes the development project; laptops keep pointing at it; after Kyle confirms the production copy, development data is replaced with seed data so laptops no longer hold real evidence (destructive, Kyle confirms). Production secrets are generated or entered per key in Task 6, never copied wholesale from local env files. Superseded and removed: CEO-S1, DX-GUARD, ENG-10, the local-stack share of CEO-T2, CEO-E3's "extra migration is a colleague's branch" tolerance (extra applied migrations on production become an error), and spec acceptance criterion 7's "against the shared state" (now "local development works against the development project"). CEO-V1's restore drill runs against the new production project.
- GATE-UC3 (approved by Kyle at the final gate, D4: add contract): Task 10 adds to the spec a decision record (why self-host the fork rather than hosted Comp, with the fork-only capabilities named), a named primary maintainer (Kyle) and a backup maintainer Kyle names, an upstream-merge cadence (weekly, plus within 2 working days of any upstream security commit) with a checklist in `docs/self-hosting-aws.md` (merge, run gates, release, record), and opens upstream PRs on `trycompai/comp` (after Kyle confirms) for the generic changes: `AUTH_COOKIE_DOMAIN`, `/v1/health/ready`, shared adapter options with pool size and production TLS rule, the revalidation and unsubscribe URL fixes, the portal invite URL default, the server API base URL helper and verified-identity throttling. A GitHub issue on `revola-ai/comp` tracks each upstream PR.
- GATE-UC4 (approved by Kyle at the final gate, D5: Terraform): provisioning moves to Terraform under `deploy/aws/terraform/` with the `aws` and `cloudflare` providers (versions pinned), an S3 state backend `comp-terraform-state-455986776194` (versioned, encrypted, public access blocked, native S3 lockfile), created once by a documented bootstrap. Terraform owns: ECR repositories and lifecycle, CodeBuild project and role, `comp-task-execution-role`, log groups, `comp-tasks-sg`, target groups, listener rules 1 to 4 and the listener certificate attachment on the existing 443 listener, the ACM certificate with its Cloudflare validation record, the Cloud Map namespace, ECS services (with `ignore_changes` on `task_definition` so `release.sh` owns revisions), alarms and SNS, the release-record bucket, Secrets Manager secret containers (values set outside Terraform except the origin header, generated by `random_password` with an alphanumeric alphabet and stored in `comp/production/origin-auth`), Cloudflare DNS records, transform rule, Access applications, edge certificate and configuration rule. The shared `revola-production-alb`, its 443 listener, `revola-cluster`, VPC and subnets are referenced only as data sources. Tests: `terraform fmt -check`, `terraform validate`, `tflint`, and a bun test that parses `terraform plan -json` against a fixture and fails if any resource of type `aws_lb`, `aws_lb_listener`, `aws_ecs_cluster`, `aws_vpc` or `aws_subnet` is managed, if a listener rule priority is outside 1 to 4, or if Access covers `api.comp.revola.ai`. Origin header rotation becomes a two-value variable change followed by the edge probe. Superseded: `provision-build.sh`, `ecs-up.sh` and the provisioning parts of `cloudflare.ts` (DX-ORDER's phases become ordered `terraform apply` steps); scripts that remain: `release.sh` (with `migrate.ts`, `trigger-deploy.sh`, `trigger-env.ts`), `sync-secrets.ts`, `reencrypt-credentials.ts`. CEO-E5 moves from deferred to in scope. Every `terraform apply` runs only after Kyle reviews the plan output.
- ENG-R1 Fold is the executable gate (both re-run voices): before any implementation, the plan is rewritten as one clean document: a Decisions table (UC1 to UC4, taste items, their answers), Global Constraints matching the decisions, numbered Tasks 0 to 10 including Task 2b, with every accepted obligation folded into its task's Files, Interfaces, steps, tests and commit; superseded text and amendment prose move to a review-history appendix outside the executable plan; the spec is updated to the same design (shared-state text removed). A human reviewer (Kyle) signs off that each task reads standalone; ENG-1's identifier check is the backstop.
- ENG-R2 Encryption inventory for the key change (both): `reencrypt-credentials.ts` is driven by an explicit registry of every encrypted table, column and nested payload (integration credentials and their historical versions, OAuth application credentials, organization Secrets, legacy cloud-security settings, anything `apps/app/src/lib/encryption.ts` writes); a scan test fails when any `ENCRYPTION_KEY` consumer in `apps/` or `packages/` is not mapped to a registry entry; verification decrypts every populated row of every registered column with the new key before commit; tests cover mixed formats, wrong old key, rerun idempotence and partial failure rollback. `SECRET_KEY` consumers (for example the bearer check in `apps/app/src/app/api/user-frameworks/route.ts`) and `BETTER_AUTH_SECRET` usage are inventoried and recorded.
- ENG-R3 Credentials that must not carry over (Codex): during Task 0 all copied API keys, sessions, verification tokens and OAuth grants are revoked or excluded in production; production API keys are reissued; acceptance proves an old development API key and session get 401 against production. Copied live third-party integrations are disabled in development after the split so dev and production do not race on the same provider refresh tokens.
- ENG-R4 Cutover window for Task 0 (both): a maintenance window with an announced freeze; stop local stacks, `trigger dev` and Trigger schedules on the shared project, revoke or rotate the shared project's write credentials for laptops during the window, record the freeze time; take the final database snapshot and Storage copy after the freeze; reconcile attachment rows with copied objects (every referenced object exists with a matching checksum); scan every text column for the old project ref and Storage host (must be zero); only then enable production. The development wipe to seed data waits for CEO-V1's restore drill to pass against production plus a seven-day soak, and Kyle's confirmation.
- ENG-R5 Migration target identity (both): `migrate.ts` and the migration guard use a `DATABASE_MIGRATION_URL` (session pooler 5432 or direct, never `:6543`) from `comp/production/config`, and verify the full project identity (pooler user `postgres.<ref>` and database) against the production ref recorded in `deploy/aws/config.ts`. Tests: transaction-pooler URL refused, same host with the development ref refused.
- ENG-R6 Lock and release journal (Codex, with Claude's ordering points): the release lock moves to a Terraform-managed DynamoDB table with conditional writes (acquire if absent or expired, renew and release only when owner and generation match, a fencing generation checked before every mutation); `terraform apply` runs through a wrapper that takes the same lock. A release journal is written to S3 before the first mutation (attempt ID, previous deployment state) and checkpointed after each registered revision and deployment step; `release.sh status` and `rollback` read the journal. Tests: interleaved acquire, takeover after expiry with a stale owner resuming, kill after the ECS step and before the Trigger step. Supersedes the SSM lock in CEO-S2, DX-SVC and ENG-15.
- ENG-R7 Terraform bootstrap and ownership contract (both): fresh bring-up order is state bucket and lock table, then core resources, then image build and secret population, then `release.sh bootstrap` registers the initial task definitions, then the Terraform apply that creates ECS services from those ARNs (services ignore later `task_definition` and `desired_count` changes); `release.sh` never passes Service Connect, network or load-balancer settings; Terraform outputs consumed by `release.sh` are named in `deploy/aws/config.ts`. Origin-header values and outputs are `sensitive`; the state bucket policy limits readers to the Terraform role and Kyle. Origin header rotation keeps three separately applied phases (ALB accepts old and new; Cloudflare switches and the edge probe passes; old value retired), each a reviewed apply, with recovery from interruption documented and the ordering tested via plan fixtures. Tests cover fresh bring-up and a later change needing both Terraform and a release.
- ENG-R8 Boot versus readiness (Claude): production with no `DATABASE_SSL_CA` fails fast at boot; the negative image smoke asserts a non-zero exit with `ca_file_missing` in stderr; `/v1/health/ready` covers runtime TLS and connection failures with `tls_*`, Prisma codes or `timeout`; the ECS deployment circuit breaker with rollback is enabled; Review Focus 4 is rewritten accordingly. The app's `/api/health` readiness returns 503 with the same reason vocabulary.
- ENG-R9 Throttling mechanics (Claude): identity-based throttling runs where authentication is known (an interceptor after `HybridAuthGuard`, keeping the global IP limiter only for unauthenticated routes); app and portal Service Connect calls carry `INTERNAL_API_TOKEN` and only then is their forwarded client IP trusted; the API's secret mapping includes both origin-auth keys and a rotation restarts the API; tests run the real middleware chain; ENG-11 must land before cutover.
- ENG-R10 Self-hosted origin policy (Claude): when `SELF_HOSTED=true`, `origin-policy.ts` drops the hardcoded `*.trycomp.ai` and `*.trust.inc` acceptance and the `.trycomp.ai` cookie fallback, deriving trusted origins from `AUTH_TRUSTED_ORIGINS` and `AUTH_COOKIE_DOMAIN`; jest proves `https://x.trycomp.ai` is rejected when self-hosted. Included in the UC3 upstream PR list.
- ENG-R11 External edge probes and job alerts (Claude): an external HTTPS check through Cloudflare on `https://api.comp.revola.ai/v1/health` and on the app's Access redirect alarms to `comp-alerts`; a Trigger.dev alert channel emails prod run failures; a scheduled check compares Supabase connections with the CEO-T2 budget.
- ENG-R12 Machine routes on the app host (Claude): every app `route.ts` that authenticates by bearer or shared secret rather than session (for example `api/user-frameworks`, `api/retool`, `api/cloud-tests`, `api/revalidate/path`) is listed and each is bypassed with its own check, documented as unsupported, or removed; `/api/revalidate/path` requires a non-empty secret compared with `timingSafeEqual` and a relative path; the image smoke asserts `SKIP_ENV_VALIDATION` is absent from runtime env.
- ENG-R13 Smaller correctness items (Claude): CEO-2's guard markers include `proxy.ts` and `middleware.ts`; CodeBuild's role adds `codeconnections:GetConnectionToken` and `GetConnection`; the arch check handles both an image index and a single manifest (config blob) with fixtures; services set `healthCheckGracePeriodSeconds` for the API and a 30 s deregistration delay; preflight checks NAT routes for the subnets; rollback refuses with an explanation when a pinned secret version no longer exists; ENG-17's scale note adds a shared Next cache handler for more than one app task; ENG-5's prod task logs the `resolveSslConfig` mode to prove verified TLS before cutover; the portal Access policy covers every employee who must acknowledge policies (email-OTP policy for named externals if any; Kyle confirms the population).
<!-- /autoplan-accepted:eng -->

### Final gate, round 1 (2026-10-05)

Kyle chose "Resolve user challenges" (D1) and accepted all four: UC1 option B (D2), UC2 split production state (D3), UC3 fork-ownership contract (D4), UC4 Terraform (D5). Recorded as GATE-UC1 to GATE-UC4 in the eng accepted block; Eng re-runs against the amended plan before the gate is presented again.

### Eng review re-run after the gate (Phase 3, round 2)

Trigger: Kyle approved UC1 to UC4 at the final gate; Eng re-ran against the amended plan (GATE-UC1 to GATE-UC4 projected into the input).
Claude subagent: completed (INPUT `eng a72bba7e...` matches the re-run snapshot), 1 critical, 4 high, 9 medium, 2 low; it read code at the session checkout (upstream main) rather than the fork, so line numbers may differ, but the facts used were spot-checked in the fork.
Codex (`gpt-6-astra`): completed, 8 P1 and 1 P2, citing fork code.

```
ENG RE-RUN - CONSENSUS TABLE:
  Dimension                           Claude                     Codex                      Consensus
  1. Architecture sound?               Yes, not executable        Not executable             CONFIRMED: fold is the gate
  2. Test coverage sufficient?         No (key change, edge)      No (old keys, crash)       CONFIRMED gaps
  3. Performance risks addressed?      Mostly (throttle chain)    Not raised                 Claude-only
  4. Security threats covered?         No (origins, key inv.)     No (copied keys, inv.)     CONFIRMED gaps
  5. Error paths handled?              No (boot vs 503)           No (journal, rotation)     CONFIRMED gaps
  6. Deployment risk manageable?       No (bootstrap)             No (lock, bootstrap)       CONFIRMED gaps
```
All findings fall inside the scope Kyle approved (they make UC2 and UC4 safe) and were accepted as ENG-R1 to ENG-R13; no new user challenge arises. Critical gaps after acceptance: 0 (the shared-state gap closes with UC2; the remaining risk is execution quality, gated by ENG-R1).
Re-run completion summary: scope accepted as-is; 13 accepted obligations; test plan artifact updated with the Task 0 cutover, key revocation, encryption inventory, lock interleaving and bootstrap cases; parallelization unchanged except Task 0 runs first and blocks Tasks 6 to 9.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | autoplan override | Adds hosting to an existing product | SCOPE EXPANSION, HOLD, REDUCTION |
| 2 | CEO | Use the committed spec as design doc; skip /office-hours offer | Mechanical | P6 | Spec already has problem, constraints, approach | Running /office-hours |
| 3 | CEO | UC1 queued as User Challenge (Access on app and portal only) | User Challenge | P1 | Cloudflare per-hostname cookie breaks cross-origin API calls | Auto-changing the user's design |
| 4 | CEO | Accept CEO-2 internal API route (Service Connect) | Taste (under option B) | P1, P5 | Required under A; keeps session-bearing calls off the edge | Public URL hairpin |
| 5 | CEO | Accept CEO-3, CEO-3b, CEO-OV, CEO-ENV env correctness set | Mechanical | P1 | Verified wrong-host and missing-key bugs | Hand-kept env lists |
| 6 | CEO | Accept CEO-4, CEO-A8, CEO-BX, CEO-PF, CEO-PUB bypass set | Mechanical | P1 | Bypass list drift and option-specific config | Single hand list |
| 7 | CEO | Accept CEO-5 browser acceptance blocking cutover | Mechanical | P1 | Proves UC1 premise empirically | Assuming it works |
| 8 | CEO | Accept CEO-E1 sign-up allowlist with invite exemption | Mechanical | P2 | Defense in depth, in Task 1's module | Access-only gate |
| 9 | CEO | Accept CEO-R1 readiness probe | Mechanical | P1 | `/v1/health` never touched the database | DB-coupled liveness |
| 10 | CEO | Accept CEO-RL proxy-aware throttling | Mechanical | P1 | Verified `req.ip` keying with no trust proxy | Raising the limit |
| 11 | CEO | Accept CEO-S1 dev schedule guard | Mechanical | P1 | Shared DB double-fire | Doc-only rule |
| 12 | CEO | Accept CEO-P1, CEO-T2 connection budget | Mechanical | P1 | Unbounded pools on one pooler | Defaults |
| 13 | CEO | Accept CEO-TLS edge cert, CEO-CF scopes | Taste (cost) | P1 | Universal SSL does not cover second-level hosts | Renaming hosts to first level (cookie scope would widen to `.revola.ai`) |
| 14 | CEO | Accept CEO-E2 ALB-metric alarms | Mechanical | P1 | Alerts are launch scope; no cluster-wide change | Container Insights |
| 15 | CEO | Accept CEO-E3, CEO-E4, CEO-T1, CEO-TAG, CEO-UP release safety | Mechanical | P1 | Migrations, smoke, Trigger parity, tag stability | Runbook-only steps |
| 16 | CEO | Accept CEO-OA, CEO-E9 origin secret and rotation | Mechanical | P1 | Re-sync erased the header; no rotation path | Single shared secret |
| 17 | CEO | Accept CEO-E7 build on merge | Taste | P2 | Small, in blast radius; deploys stay manual | Manual builds only |
| 18 | CEO | Defer CEO-E5 IaC, CEO-E6 staging, CEO-E8 migration task; file as issues (CEO-O1) | Mechanical | P3 | Outside blast radius or spec non-goal | Including now |
| 19 | CEO | 0H document approval A | Mechanical | P6 | Summary and plan reconciled | Revise or pause |
| 20 | CEO | Accept CEO-V1 recovery gate | Mechanical | P1 | Both voices; spec already planned Pro | Optional backups |
| 21 | CEO | Accept CEO-V2 dedicated execution role | Mechanical | P1 | Both voices; least privilege for the evidence store | Shared `secret:*` role |
| 22 | CEO | Accept CEO-V3 release record, CEO-V7 migration compatibility | Mechanical | P1 | Codex; rollback must be reproducible | Tags only |
| 23 | CEO | Accept CEO-V4 workflow and offboarding acceptance | Mechanical | P1 | Codex; deployment health is not task success | Infra-only acceptance |
| 24 | CEO | Accept CEO-V5, V6, V8, V9 records and drift test | Mechanical | P1 | Single-voice, cheap, in blast radius | Silence |
| 25 | CEO | UC2, UC3, UC4 queued as User Challenges | User Challenge | - | Both voices change stated direction | Auto-applying |
| 26 | CEO | CodeBuild release runner | Taste | P3 | Claude only; depends on UC4 | Accepting now |
| 27 | CEO | Accept CEO-S2 deploy lock, failure diagnostics, Service Connect 5xx alarm | Mechanical | P1 | Sections 2, 4, 8 gaps | Leaving gaps |

### CEO Implementation Tasks
Synthesized from the CEO findings; each maps to an accepted row. Effort assumes CC with tests (ratios: features ~30x, tests ~50x, infra scripts ~20x).

- [ ] **T1 (P1, human: ~1d / CC: ~40min)** - api - Task 1 extensions: allowlist hook, readiness probe, proxy-aware throttler (CEO-E1, CEO-R1, CEO-RL). Verify: `cd apps/api && npx jest src/auth src/health src/throttle`.
- [ ] **T2 (P1, human: ~1d / CC: ~40min)** - app, portal - Task 2b: server API base URL helpers and guard tests, revalidation and unsubscribe URL fixes, schedule guard across 17 schedule files (CEO-2, CEO-3b, CEO-S1). Verify: `cd apps/app && npx vitest run`; `cd apps/portal && npx vitest run`.
- [ ] **T3 (P1, human: ~2h / CC: ~10min)** - db - `DATABASE_POOL_MAX` in `packages/db/src/client.ts` (CEO-P1). Verify: `cd packages/db && bun test`.
- [ ] **T4 (P1, human: ~1d / CC: ~40min)** - deploy - secrets, overrides, env coverage and Trigger env keys (CEO-OV, CEO-ENV, CEO-3, CEO-OA). Verify: `bun test deploy/aws`.
- [ ] **T5 (P1, human: ~1.5d / CC: ~1h)** - deploy - ECS: dedicated role, Service Connect, alarms, deploy lock, migration guard, smoke, release record, re-run semantics, tag length (CEO-V2, CEO-2, CEO-E2, CEO-S2, CEO-E3, CEO-E4, CEO-V3, CEO-UP, CEO-TAG). Verify: `bun test deploy/aws && bash deploy/aws/tests/deploy.test.sh`.
- [ ] **T6 (P1, human: ~1d / CC: ~40min)** - deploy - Cloudflare both UC1 variants, bypass scan, edge cert, SSL rule, rotation (CEO-A8, CEO-4, CEO-BX, CEO-PF, CEO-TLS, CEO-CF, CEO-E9). Verify: `bun test deploy/aws/cloudflare.test.ts`.
- [ ] **T7 (P1, human: ~4h / CC: ~20min)** - deploy - `trigger-deploy.sh` release path (CEO-T1). Verify: stubbed run refuses a dirty tree and wrong HEAD.
- [ ] **T8 (P1, human: ~1d / CC: ~30min plus Kyle)** - ops - recovery gate and restore drill (CEO-V1), connection budget (CEO-T2), regions and latency (CEO-V5). Verify: drill record in `docs/self-hosting-aws.md`.
- [ ] **T9 (P1, human: ~4h / CC: ~20min plus Kyle)** - acceptance - workflow, offboarding and burst checks (CEO-5, CEO-V4). Verify: acceptance record.
- [ ] **T10 (P2, human: ~2h / CC: ~10min)** - docs - data boundary, migration compatibility rule, image binding, issues filed (CEO-V6, CEO-V7, CEO-V9, CEO-O1). Verify: doc review and issue links.
- [ ] **T11 (P2, human: ~2h / CC: ~10min)** - deploy - build-context drift test (CEO-V8). Verify: `bun test deploy/aws`.
- [ ] **T12 (P2, human: ~1h / CC: ~5min)** - build - CodeBuild webhook (CEO-E7, taste). Verify: push builds the pushed SHA.
| 28 | DX | Product type Platform/operator tooling; persona Revola operator; mode DX POLISH | Mechanical | P6 | Plan's developer surface is the deploy kit | Colleague persona as primary |
| 29 | DX | TTHW target Competitive (one command, <5 min hands-on) | Mechanical | P5 | Lowest-effort vehicle reaching the tier | Champion push-to-deploy |
| 30 | DX | Accept DX-FOLD plan consolidation after the gate | Mechanical | P5 | Both voices: addenda contradict task bodies | Leaving addenda |
| 31 | DX | Accept DX-PRE, DX-REL, DX-MIG, DX-SVC, DX-RST one-command release kit | Mechanical | P5, P1 | Both voices: operator is the orchestrator | Separate scripts only |
| 32 | DX | Accept DX-REC, DX-RB rollback by records and pinned secret versions | Mechanical | P1 | Codex: rollback kept new config; record dirtied tree | Clone-and-swap rollback |
| 33 | DX | Accept DX-HATCH incident hatch (supersedes CEO-E4 restriction) | Taste | P1 | Claude: smoke blocks hotfix during DB outage | Certificate-only skip |
| 34 | DX | Accept DX-LIVE app liveness route | Mechanical | P1 | Verified app /api/health runs SELECT 1 | DB-coupled ALB check |
| 35 | DX | Accept DX-TRIG reproducible Trigger builds, disable upstream workflows | Mechanical | P1 | Verified extension and certificate prerequisites | Laptop leftovers |
| 36 | DX | Accept DX-SYNC, DX-GATE, DX-GUARD, DX-COL, DX-DOC, DX-ORDER, DX-403, DX-ERR, DX-TIME | Mechanical | P1, P5 | Evidenced gaps; includes existing CI script-name bug | Status quo |
| 37 | DX | Keep `npx jest`/`npx vitest` in task commands | Mechanical | P4 | Repo CLAUDE.md prescribes them | Rewriting to bunx |
| 38 | Eng | Scope accepted as-is (complexity gate; never reduce) | Mechanical | P2 | autoplan override | Smaller arrangement |
| 39 | Eng | Accept ENG-1 to ENG-7, ENG-9 to ENG-17 | Mechanical | P1, P5 | Verified in code; both voices | Leaving gaps |
| 40 | Eng | ENG-8 offboarding revokes creator API keys | Taste | P1 | Codex; changes upstream owner-fallback behaviour | Keep upstream fallback |
| 41 | Eng | ENG-18 option-A requirements recorded conditionally | Mechanical | P1 | Only applies if UC1=A | Ignore A's failure mode |
| 42 | Eng | Supersede CEO-RL tracker details and CEO-P1/CEO-R1 specifics with ENG-11 and ENG-3 | Mechanical | P5 | Verified code paths | Keeping weaker specs |
| 43 | Gate | UC1 option B | User Challenge (approved) | Kyle D2 | Per-hostname Access cookies | Option A |
| 44 | Gate | UC2 split production state | User Challenge (approved) | Kyle D3 | Laptops can alter evidence | Shared state |
| 45 | Gate | UC3 fork-ownership contract | User Challenge (approved) | Kyle D4 | Unowned upstream drift | No contract |
| 46 | Gate | UC4 Terraform | User Challenge (approved) | Kyle D5 | Hand-rolled IaC | Scripts |
| 47 | Eng R2 | Accept ENG-R1 to ENG-R13 | Mechanical | P1 | Both re-run voices; inside approved UC scope | Leaving gaps |
| 48 | Gate | Final approval: approve as-is (D6) | Approved by Kyle | - | UC1-UC4 decided; Eng re-run found no architecture blocker | Overrides, revise, reject |

## GSTACK REVIEW REPORT

Status: APPROVED by Kyle at the /autoplan final gate on 2026-10-05 (round 2, D6). Next step: ENG-R1 rewrites this plan into one executable document (Decisions table, Tasks 0 to 10, every accepted obligation folded in), Kyle signs off, then re-run `/plan-eng-review` on the folded plan before implementation.

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan) | Scope & strategy | 1 | CLEAR (PLAN via /autoplan) | 39 proposals, 34 accepted, 5 deferred; 4 user challenges approved |
| Outside Review | Codex `gpt-6-astra` (via /autoplan, all phases) | Independent 2nd opinion | 4 | completed | CEO 8, DX 10, Eng 11, Eng re-run 9 findings; all integrated or accepted |
| Eng Review | `/plan-eng-review` (via /autoplan) | Architecture & tests (required) | 2 | ISSUES OPEN (PLAN via /autoplan) | 39 issues mapped to accepted obligations, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | SKIPPED (no UI scope) | - |
| DX Review | `/plan-devex-review` (via /autoplan) | Developer experience gaps | 1 | ISSUES OPEN (PLAN via /autoplan) | score: 4/10 → 7/10, TTHW: ~15 min hands-on → <2 min |

- **OUTSIDE COVERAGE:** Codex completed for CEO, DX, Eng and the Eng re-run; Design skipped (no UI scope). Spec-review loop (Claude subagent) ran 3 passes at 5/10 each, all findings applied.
- **CROSS-MODEL:** Claude subagents and Codex agreed on 6/6 CEO dimensions, 6/6 DX dimensions, 6/6 Eng dimensions and 5/6 on the Eng re-run (performance raised by Claude only); model identities: Claude subagents inherited the host model, Codex `gpt-6-astra`.
- **VERDICT:** CEO CLEARED. Eng and DX issues are mapped to accepted obligations, not open questions; eng review required again on the folded plan (ENG-R1) before implementation.

NO UNRESOLVED DECISIONS
