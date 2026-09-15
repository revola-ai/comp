# Running Comp locally (self-hosted dev mode)

This is the Revola local setup, layered on upstream's dev workflow.
It runs every app from source with hot reload against local Postgres and MinIO.

## Prerequisites

- Docker Desktop (Postgres + MinIO run as containers)
- Node 22 LTS (`nvm use` picks it up from `.nvmrc`; Prisma refuses Node 23)
- Bun >= 1.1.36 (`npm i -g bun`)

## One-time setup

```bash
nvm use
bun install

# Postgres (upstream compose file)
bun docker:up

# MinIO (+ the four S3 buckets), Redis, and SRH (Upstash-compatible REST facade)
docker compose -f docker-compose.local.yml up -d

# .env files with generated secrets and FILL_ME placeholders
./scripts/local-env-init.sh

# Schema + reference data (frameworks, controls, policies, evidence tasks)
cd packages/db && bunx prisma migrate deploy && bun run db:seed && cd ../..
for a in app portal api; do (cd apps/$a && bun run db:generate); done
```

## Third-party keys

Search the generated `.env` files for `FILL_ME`.
The same value goes in every file that lists it.

| Key | Where to get it | Needed for |
|---|---|---|
| `TRIGGER_SECRET_KEY` | cloud.trigger.dev -> project -> API keys -> **dev** key | All background jobs (onboarding, policy generation, integrations) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | console.cloud.google.com -> APIs & Services -> Credentials -> OAuth client (Web) | Sign-in without email delivery |
| `RESEND_API_KEY` | resend.com -> API keys | Magic-link sign-in, invites, notifications |
| `OPENAI_API_KEY` | platform.openai.com (project key, Model capabilities only) | Questionnaire auto-answer, vendor research, embeddings |
| `GOOGLE_GENERATIVE_AI_API_KEY` | aistudio.google.com -> Get API key | Org onboarding (vendor/risk extraction, mitigation plans), policy tailoring, suggestion reranking. This fork calls Gemini directly instead of upstream's Vercel AI Gateway (`apps/app/src/lib/ai/google-models.ts`); model ids are overridable with `AI_MODEL_ONBOARDING`, `AI_MODEL_POLICY_UPDATE`, `AI_MODEL_RERANK`. |
| `ANTHROPIC_API_KEY` (optional) | console.anthropic.com | Policy editor chat/edit-section, cue-line refinement, file extraction, cloud remediation |

Google OAuth client settings:

- Authorized JavaScript origins: `http://localhost:3000`, `http://localhost:3333`
- Authorized redirect URI: `http://localhost:3333/api/auth/callback/google`

Trigger.dev needs **two** projects (app tasks and api tasks are separate projects upstream; the task id `update-policy` exists in both, so they cannot share one).

1. `bunx trigger.dev@4.4.3 login` once (the CLI login is separate from the secret key).
2. Create projects such as `comp-app` and `comp-api` at cloud.trigger.dev.
3. In `apps/app/.env` set `TRIGGER_PROJECT_REF` and `TRIGGER_SECRET_KEY` (dev key) from `comp-app`; in `apps/api/.env` set both from `comp-api`.

`TRIGGER_PROJECT_REF` overrides the upstream project ids in the two `trigger.config.ts` files.
`trigger dev` runs task code on your machine; the cloud only orchestrates.
Both dev scripts use `concurrently --kill-others`, so a failing `trigger dev` takes its server down and turbo then stops everything.

## Running

Use the compiled runner. Dev-mode watchers (`bun run dev`) keep Turbopack and
`tsc --watch` resident and need ~16 GB of RAM; this needs ~4 GB.

```bash
scripts/local-run.sh build    # compile api + app; rerun after pulling or editing code
scripts/local-run.sh start    # containers, api :3333, app :3000, both Trigger workers
scripts/local-run.sh status
scripts/local-run.sh logs app # or api, trigger-api, trigger-app
scripts/local-run.sh stop
```

Dashboard: http://localhost:3000. API docs: http://localhost:3333/api/docs.
Start order matters: the app checks the session against the API on every render, so the script waits for the API before starting the app.

For active development on one app, run only that app's dev script in its own terminal (`cd apps/app && bun run dev`) and keep the rest compiled.
Never run the root `bun run dev`: it launches 13 watchers including Electron and seven library rebuilders.

Portal (`cd apps/portal && bun run dev`, :3002) and framework-editor (`cd apps/framework-editor && bun run dev`, :3004) are only needed for the employee/trust portal and template editing.

MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`).
Redis is required (not optional as the upstream env example says): `/setup` sessions, safe-action wrappers, device-agent tokens and rate limits all use `@upstash/redis`, which needs the REST facade on :8079.

## Self-hosted mode

`SELF_HOSTED=true` (api) and `NEXT_PUBLIC_SELF_HOSTED=true` (app) are already set.
New organizations are auto-approved and the Stripe / booking flow is skipped.

## Frameworks

The seed ships SOC 2 (visible, 63 requirements, fully mapped to controls) and NIST CSF 2.0 (hidden, 106 subcategories, no control mappings yet).
Enabling and mapping CSF 2.0 is tracked on the `revola/self-host` branch.
