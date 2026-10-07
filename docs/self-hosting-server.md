# Comp on the tunnel server

The stack, its configuration and `deploy/server/release.sh` are described in `deploy/server/README.md`.

## Trigger.dev prod env vars

`deploy/server/release.sh trigger` deploys the task code only; each project's env vars are set in the Trigger.dev dashboard (the project, Environment Variables, Production).
The lists come from the static import closure of each project's task directories (the parked `revola/aws-infra` design, `deploy/aws/trigger-env-keys.ts`, run against this tree).
A "secret" value is the key of the same name in `comp/production/config`; `DATABASE_SSL_CA` and `NODE_EXTRA_CA_CERTS` are set by the CA build extension at deploy.

| Variable | comp-api | comp-app |
|---|---|---|
| `DATABASE_URL`, `APP_AWS_ACCESS_KEY_ID`, `APP_AWS_SECRET_ACCESS_KEY`, `APP_AWS_ENDPOINT`, `APP_AWS_REGION`, `APP_AWS_BUCKET_NAME`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_DEFAULT`, `RESEND_FROM_SYSTEM`, `SERVICE_TOKEN_TRIGGER`, `UNSUBSCRIBE_SECRET` | secret | secret |
| `ANTHROPIC_API_KEY`, `APP_AWS_KNOWLEDGE_BASE_BUCKET`, `APP_AWS_ORG_ASSETS_BUCKET`, `APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET` | secret | not set |
| `AUTH_SECRET` (from `SECRET_KEY`), `ENCRYPTION_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `REVALIDATION_SECRET` | not set | secret |
| `API_BASE_URL`, `API_URL`, `BASE_URL`, `NEXT_PUBLIC_API_URL` | `https://api.comp.revola.ai` | `https://api.comp.revola.ai` |
| `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL` | `https://api.comp.revola.ai` | not set |
| `NEXT_PUBLIC_APP_URL` | `https://app.comp.revola.ai` | `https://app.comp.revola.ai` |
| `NEXT_PUBLIC_PORTAL_URL` | `https://portal.comp.revola.ai` | `https://portal.comp.revola.ai` |
| `DATABASE_POOL_MAX` | `2` | `2` |
| `NODE_ENV` | `production` | `production` |
