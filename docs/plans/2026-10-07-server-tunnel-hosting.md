# Comp AI on one server behind a Cloudflare Tunnel (plan)

> For agentic workers: use superpowers:subagent-driven-development task by task. Steps use checkbox syntax.

**Goal:** Run the Revola fork of Comp AI at `https://app.comp.revola.ai` (portal `portal.comp.revola.ai`, API `api.comp.revola.ai`) on one EC2 server reached only through a Cloudflare Tunnel, so colleagues use it in a browser and nobody runs it on a laptop.

**Replaces:** the ECS/ALB/Terraform design in `docs/plans/2026-10-05-aws-hosting.md` (parked on branch `revola/aws-infra`).
Kyle chose this simpler setup on 2026-10-07 to cut maintenance; the application-code fixes from `revola/aws-hosting` stay.

**Architecture:** one ARM64 EC2 instance (`t4g.xlarge`, 16 GB) in Revola's AWS account runs Docker Compose with four containers: `api` (NestJS, :3333), `app` and `portal` (Next.js standalone, :3000), and `cloudflared` (outbound tunnel).
The instance has no inbound security-group rules; Cloudflare routes the three hostnames through the tunnel to the containers on a private Docker network.
Cloudflare Access (Google, `@revola.ai`) protects `app` and `portal`; `api` is public through the tunnel and protected by its own auth (session, API keys, service tokens, sign-up allowlist, rate limits).
Production data stays where it is (shared Supabase Postgres and Storage, Upstash Redis; decision D7).
Background jobs run on Trigger.dev cloud `prod`.

## Decisions (Kyle, 2026-10-07)

| Decision | Answer |
|---|---|
| Host | EC2 in Revola's AWS account `455986776194`, `us-east-2`, existing VPC `vpc-06b67bec700b38a10`, private subnet with NAT `subnet-08095a4ada58a9eef` |
| Size | `t4g.xlarge` (4 vCPU, 16 GB, about $98/month on demand), 60 GB encrypted gp3 |
| Hostnames | `app.comp.revola.ai`, `api.comp.revola.ai`, `portal.comp.revola.ai`; cookie domain `.comp.revola.ai`; Cloudflare advanced certificate for `*.comp.revola.ai` (about $10/month) |
| API host | Not behind Access (Trigger.dev jobs, API keys and MCP clients must reach it) |
| Admin access | AWS Systems Manager Session Manager only; no SSH keys, no inbound ports |

## Global constraints

- Branch `revola/server-hosting` off `revola/aws-hosting`; conventional commits, lowercase subjects; never `--no-verify`, never `git stash`.
- Repo rules (`CLAUDE.md`): bun only; no `as any`/`@ts-ignore`; named parameters for 2+ arguments; files at most 300 lines; TDD (failing test, run, implement, run).
- No em dashes; long Markdown has one sentence per line.
- Never read, print or edit `.env*` files (scripts may load them in a child process and pass values on by name); never print secret values.
- Every AWS, Cloudflare, Google, Supabase or Trigger.dev change runs only after Kyle confirms the printed command.
- Production uses the existing images built from `deploy/aws/Dockerfile` (Node 22, Bun 1.3.4 from npm, Supabase CA at `/app/certs/supabase-ca.crt`, `DATABASE_SSL_CA` set); `NEXT_PUBLIC_*` values are the three https hosts above.
- Image tags are the 12-character git SHA.

## Task 1: API trusts the visitor IP only from the tunnel

**Why:** the rate limiter and better-auth limiter trust `CF-Connecting-IP` only when the request carries a valid `X-Comp-Origin-Auth` header, which the ALB design added at Cloudflare's edge.
Behind a tunnel there is no such header; every request would key on the `cloudflared` container's address, so all users would share one bucket.
The production boot check (`apps/api/src/auth/edge-secrets.ts`) also requires `COMP_ORIGIN_AUTH`.

**Files:** `apps/api/src/throttle/verified-headers.ts`, `identity-tracker.ts`, the client-IP header middleware, `apps/api/src/auth/edge-secrets.ts`, their specs; `docs/self-hosting-local.md` (one line).

- [ ] New setting `TRUSTED_EDGE_PROXY_IPS` (comma-separated IPs): `CF-Connecting-IP` is trusted when the request's socket peer address (after IPv4-mapped IPv6 normalisation) is in that list, in addition to the existing origin-header rule.
  Requests from any other peer ignore `CF-Connecting-IP`.
- [ ] Production boot check: with `NODE_ENV=production` and `AUTH_COOKIE_DOMAIN` set, require either a valid `COMP_ORIGIN_AUTH` (ALB design) or a non-empty, valid `TRUSTED_EDGE_PROXY_IPS` (tunnel design); `COMP_FORWARDED_IP_TOKEN` stays required.
  Error messages name the variables, never values.
- [ ] Tests: tunnel peer with `CF-Connecting-IP` keys on the visitor; another peer with a forged `CF-Connecting-IP` keys on its own address; two visitors through the tunnel get separate buckets (throttler, failure limiter, better-auth client-IP header); boot check accepts either mode and refuses neither.
- [ ] Commit `feat(api): trust the visitor ip from a cloudflare tunnel peer`.

## Task 2: Compose stack, env files and container health

**Files:** `deploy/server/compose.yaml`, `deploy/server/env/{api,app,portal}.keys` (key names per service, no values), `deploy/server/render-env.sh`, `deploy/server/tests/*.test.sh`, `deploy/server/README.md`.

- [ ] `compose.yaml`:
  - services `api`, `app`, `portal` built from `deploy/aws/Dockerfile` targets with image `comp-<service>:<tag>` (`TAG` env), `restart: unless-stopped`, healthchecks (`/v1/health`, `/api/health/live`, `/api/health`), memory limits that fit 16 GB with headroom for builds;
  - `cloudflared` (`cloudflare/cloudflared` pinned by digest from a registry that is not rate-limited for anonymous pulls, or ECR Public if available) running `tunnel run` with `TUNNEL_TOKEN` from its env file, a static IP on the internal network;
  - one internal bridge network with a fixed subnet; no published ports;
  - `awslogs` logging driver to `/comp/<service>` in `us-east-2`.
- [ ] Env per service: keys listed in `deploy/server/env/<service>.keys`, values from Secrets Manager `comp/production/config` (JSON) plus fixed non-secret values in the same files' companion `<service>.public.env` (committed, no secrets): `NODE_ENV=production`, `SELF_HOSTED=true`, `AUTH_COOKIE_DOMAIN=.comp.revola.ai`, `AUTH_TRUSTED_ORIGINS`, `AUTH_ALLOWED_EMAIL_DOMAINS=revola.ai`, the public URLs, `BACKEND_API_URL=http://api:3333` (app, portal), `TRUSTED_EDGE_PROXY_IPS=<cloudflared static IP>` (api), `DATABASE_POOL_MAX` per the connection budget (api 4, app 2, portal 1, within Supabase's session pooler limit together with Trigger.dev and two laptop stacks; document the arithmetic).
  Use the parked branch's `deploy/aws/secret-keys.ts` and `unset-keys.ts` (read-only, `git show revola/aws-infra:<path>`) as the reference for which keys each service needs; app and portal never receive `INTERNAL_API_TOKEN`.
- [ ] `render-env.sh` (runs on the server as root): fetches the secret JSON, writes `/opt/comp/env/<service>.env` (0600, root) containing exactly the listed keys plus the public values, refuses when a listed key is missing (names only), never prints values.
- [ ] Tests (bash, stubbed `aws`): exact key sets per service, 0600 files, missing-key refusal names the key, no value in output; `docker compose config` validates.
- [ ] Commit `feat(deploy): compose stack and env rendering for the tunnel server`.

## Task 3: Provision the server

**Files:** `deploy/server/provision.sh`, `deploy/server/user-data.sh`, `deploy/server/tests/provision.test.sh`.

- [ ] `provision.sh` (idempotent, AWS CLI, prints the plan and asks for typed confirmation before each create): IAM role and instance profile `comp-server` (`AmazonSSMManagedInstanceCore`, `secretsmanager:GetSecretValue` on `comp/production/*`, `logs:CreateLogStream`/`PutLogEvents` on `/comp/*`); security group `comp-server` with no inbound rules; CloudWatch log groups `/comp/api`, `/comp/app`, `/comp/portal` (30-day retention); the instance (`t4g.xlarge`, latest Amazon Linux 2023 ARM64 AMI via SSM parameter, IMDSv2 required, 60 GB encrypted gp3, termination protection, tag `Name=comp-server`); Route 53 health checks on `https://api.comp.revola.ai/v1/health` and `https://app.comp.revola.ai/` (expects the Access redirect) with alarms in `us-east-1` to an SNS topic `comp-alerts` subscribed to an address Kyle supplies at run time (never committed).
- [ ] `user-data.sh`: installs Docker, the compose plugin, git and `dnf-automatic` security updates; swap file 8 GB; clones `https://github.com/revola-ai/comp` into `/opt/comp/src`.
- [ ] Tests with stubbed `aws`: refuses the wrong account; creates nothing without confirmation; second run is a no-op; no inbound rule ever requested.
- [ ] Commit `feat(deploy): provision the comp tunnel server`.

## Task 4: Release, rollback, migrate, Trigger.dev deploy

**Files:** `deploy/server/release.sh` and helpers, `deploy/server/tests/release.test.sh`.

- [ ] Runs from Kyle's laptop; drives the server through `aws ssm send-command` (waits, prints the command output, fails on non-zero).
- [ ] `release <sha>`: refuses an unpushed SHA; on the server: `git fetch` and check out the SHA, `render-env.sh`, build the three images tagged with the SHA (one at a time), refuse if `prisma migrate status` against production reports pending or failed migrations (prints the `migrate` command), `docker compose up -d` with the new tag, wait for all healthchecks, smoke `https://api.comp.revola.ai/v1/health/ready` and the app's Access redirect, append the release to `/opt/comp/releases.log`; on failure, bring the previous tag back up and say so.
- [ ] `rollback [<sha>]`: bring a previously released tag back up (default: the one before the current), with the same health and smoke checks.
- [ ] `migrate <sha>`: shows the pending migrations, asks for typed confirmation, runs `prisma migrate deploy` in a one-off container with `COMP_I_AM_TOUCHING_PROD=1` and CA-verified TLS.
- [ ] `trigger <sha> [--project api|app]`: deploys Trigger.dev `prod` from the server's checkout with `TRIGGER_PROJECT_REF` and an access token from the secret; env vars for Trigger prod are set in the Trigger dashboard (documented list).
- [ ] `status`, `logs <service>`: current tag, container health, last releases, `aws logs tail` command.
- [ ] `prune`: keeps the current and the last 3 released image tags, removes older images and build cache, with confirmation.
- [ ] Tests with stubbed `aws`/`git`: unpushed SHA refused; pending migration refuses before any container change; failed health brings the previous tag back; rollback picks the previous release; no secret in output.
- [ ] Commit `feat(deploy): release, rollback and migrate for the tunnel server`.

## Task 5: Secrets, Cloudflare and runbook

**Files:** `deploy/server/push-secrets.ts` and test, `deploy/server/README.md`, `docs/self-hosting-local.md` ("Using hosted Comp").

- [ ] `push-secrets.ts`: builds the `comp/production/config` JSON from the operator's env files (read in memory) for exactly the keys in `deploy/server/env/*.keys` plus `TUNNEL_TOKEN` and the Trigger keys; refuses a non-production `DATABASE_URL` (use `productionVerdict` from `packages/db/src/production-target.ts`), refuses service tokens shorter than 32 characters; prints a names-only diff; writes via a 0600 temp file; typed confirmation.
- [ ] README runbook, in order: Cloudflare (advanced certificate for `*.comp.revola.ai`; Zero Trust tunnel `comp` with public hostnames `app.comp.revola.ai -> http://app:3000`, `portal.comp.revola.ai -> http://portal:3000`, `api.comp.revola.ai -> http://api:3333`; Access applications for app and portal with Google and the `@revola.ai` rule; copy the tunnel token); `push-secrets`; `provision.sh`; first `release`; Google OAuth origins and redirect for the new hosts; Supabase Pro and "Enforce SSL"; Trigger.dev prod keys, env vars and concurrency; first `trigger` deploy; acceptance checks (sign-in, session across app/API/portal, an evidence upload, a policy regeneration on Trigger prod with no laptop running `trigger dev`, `curl` to the API with a forged `CF-Connecting-IP` from outside the tunnel cannot pick a rate-limit bucket); day-2 (release, rollback, migrate, adding a user, logs, patching).
- [ ] Commit `docs(deploy): tunnel server runbook`.
