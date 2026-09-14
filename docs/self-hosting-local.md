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

# MinIO + the four S3 buckets the apps expect
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
| `AI_GATEWAY_API_KEY` | vercel.com -> AI Gateway -> API Keys (add your Google AI Studio key under BYOK) | Org onboarding: vendor/risk extraction and policy tailoring via Gemini |
| `ANTHROPIC_API_KEY` (optional) | console.anthropic.com | Policy editor chat/edit-section, cue-line refinement, file extraction, cloud remediation |

Google OAuth client settings:

- Authorized JavaScript origins: `http://localhost:3000`, `http://localhost:3333`
- Authorized redirect URI: `http://localhost:3333/api/auth/callback/google`

Trigger.dev: create one project and use its **dev** secret key in both `apps/app/.env` and `apps/api/.env`.
`trigger dev` runs task code on your machine; the cloud only orchestrates.

## Running

```bash
bun run dev            # everything via turbo (app :3000, portal :3002, api :3333, framework-editor :3004)
```

Or per app, without Trigger.dev while keys are missing:

```bash
(cd apps/api && bun run dev:no-trigger)
(cd apps/app && bun run dev:no-trigger)
```

MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`).

## Self-hosted mode

`SELF_HOSTED=true` (api) and `NEXT_PUBLIC_SELF_HOSTED=true` (app) are already set.
New organizations are auto-approved and the Stripe / booking flow is skipped.

## Frameworks

The seed ships SOC 2 (visible, 63 requirements, fully mapped to controls) and NIST CSF 2.0 (hidden, 106 subcategories, no control mappings yet).
Enabling and mapping CSF 2.0 is tracked on the `revola/self-host` branch.
