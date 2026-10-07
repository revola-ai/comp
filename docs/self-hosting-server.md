# Comp on the tunnel server: runbook

This is the order in which Comp goes live on the tunnel server, from an empty account to the acceptance checks.
The stack, its configuration and the scripts are described in `deploy/server/README.md`; running it day to day is in `docs/self-hosting-server-day2.md`.

Every step that changes AWS, Cloudflare, Google, Supabase or Trigger.dev is marked **Kyle runs**.
The scripts print each command before it runs and read the typed confirmation from the terminal (`/dev/tty`), never from stdin, so an agent or a pipe cannot confirm on Kyle's behalf.
No script or step prints a secret value; values go into env files with an editor, never through a chat or a command line.

The hosts are `https://app.comp.revola.ai`, `https://portal.comp.revola.ai` and `https://api.comp.revola.ai`.

## 1. Prerequisites

On the laptop that runs the scripts:

- AWS CLI v2 with the default profile on account `455986776194`: `aws sts get-caller-identity --query Account --output text` prints `455986776194`.
- No `AWS_REGION` or `AWS_DEFAULT_REGION` naming a region other than `us-east-2` (every script refuses one).
- bash 4 or newer (macOS ships 3.2: `brew install bash`, then `bash --version`).
- Bun 1.3.4 (the repository's `packageManager`), `git`, `python3` and `curl`.
- A terminal: every script that writes refuses to run without one.
- The main checkout of the repository (not a worktree), whose env files hold the shared values of team mode (`docs/self-hosting-local.md`, Shared state).

## 2. Supabase

**Kyle runs**, in the Supabase dashboard of the production project:

1. Organization, Billing: the plan is Pro.
2. Project Settings, Database, SSL Configuration: "Enforce SSL on incoming connections" is on.
3. Project Settings, Database, Connection pooling: note the pool size of the session pooler.
   The budget in `deploy/server/README.md` (Connection budget) assumes 40: the server holds 4 (api) + 2 (app) + 1 (portal) pool connections plus 2 readiness probes, Trigger.dev prod runs 2 per run at the configured concurrency, and each laptop stack about 8.
   On this branch a laptop process that does not set `DATABASE_POOL_MAX=1` (anything not started by `scripts/local-run.sh` or the apps' `dev` scripts) opens up to 10 connections; count those too.
   If the pool size is smaller than the sum plus 3 of headroom, raise it (or the compute size) before the first release.
4. `packages/db/.env` of the main checkout holds `DATABASE_MIGRATION_URL` on the session pooler (`aws-0-us-east-2.pooler.supabase.com:5432`, user `postgres.<ref>`).
   The direct host `db.<ref>.supabase.co` also works only with the IPv4 add-on, because it is IPv6-only otherwise and the server reaches the internet over IPv4.
   Never port 6543 (the transaction pooler): `push-secrets` refuses it.
5. Project Settings, Database, SSL Configuration, "Download certificate", then compare it with the CA the images trust:
   `shasum -a 256 ~/Downloads/prod-ca-2021.crt deploy/aws/certs/supabase-ca.crt` prints the same hash twice.

## 3. Cloudflare

**Kyle runs**, in the Cloudflare dashboard (menu names drift; the step names what to look for):

1. Zone `revola.ai`, SSL/TLS, Edge Certificates, "Order an advanced certificate" for `*.comp.revola.ai` and `comp.revola.ai` (Universal SSL covers only one level, `*.revola.ai`).
   Success: the certificate shows Active.
2. Zero Trust, Networks, Tunnels, "Create a tunnel", type Cloudflared, name `comp`, environment Docker.
   The page shows a `docker run ... --token <token>` command: do not run it, copy only the token (step 6 below).
   Add three public hostnames (also called published application routes), each with type HTTP:

   | Hostname | Service |
   |---|---|
   | `app.comp.revola.ai` | `http://app:3000` |
   | `portal.comp.revola.ai` | `http://portal:3000` |
   | `api.comp.revola.ai` | `http://api:3333` |

   Cloudflare creates the three proxied DNS records itself.
   Success: the tunnel is listed (Inactive until the first release starts `cloudflared`).
3. Zero Trust, Settings, Authentication, Login methods: add Google.
   It needs a Google OAuth client with the authorized JavaScript origin `https://<team>.cloudflareaccess.com` and the redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` (`<team>` is the Zero Trust team name); "Test" on the login method succeeds.
4. Zero Trust, Access, Applications, "Add an application", Self-hosted, twice: one for `app.comp.revola.ai` and one for `portal.comp.revola.ai`.
   Login method Google only; one policy, action Allow, include "Emails ending in" `@revola.ai`.
5. Two more self-hosted applications, each with one policy of action Bypass that includes Everyone:
   `app.comp.revola.ai` with path `api/health/live`, and `portal.comp.revola.ai` with path `api/health`.
   They let the Route 53 health checks and the release smoke checks see the origin; both routes are liveness probes that return no data.
   The API host gets no Access application at all: Trigger.dev jobs, API keys and MCP clients must reach it.
6. Put the token into the production-only env file of the main checkout, `deploy/server/.env.production.local` (gitignored by `.env*.local`), with an editor: a line `TUNNEL_TOKEN=<token>`.
   Create the file first with `(umask 077 && touch deploy/server/.env.production.local)` so only you can read it.

## 4. Trigger.dev

**Kyle runs**, at cloud.trigger.dev, for the two Revola projects (`comp-api` for `apps/api`, `comp-app` for `apps/app`):

1. Each project's ref (`proj_...`, in the project settings) must equal `TRIGGER_PROJECT_REF` in `apps/api/.env` and `apps/app/.env` of the main checkout; `push-secrets` copies them from there and refuses the upstream Comp AI refs.
2. Each project's Production secret key (API keys page, `tr_prod_...`) goes into `deploy/server/.env.production.local` as `TRIGGER_SECRET_KEY_API` and `TRIGGER_SECRET_KEY_APP`.
3. A personal access token (Account, Personal Access Tokens, `tr_pat_...`) goes into the same file as `TRIGGER_ACCESS_TOKEN`; `release.sh trigger` deploys with it.
4. Each project's Production environment variables, from the table below.
5. The Production concurrency limit: 1 for `comp-api` and 2 for `comp-app` (the connection budget counts on it).

The production-only file then holds exactly `TUNNEL_TOKEN`, `TRIGGER_ACCESS_TOKEN`, `TRIGGER_SECRET_KEY_API` and `TRIGGER_SECRET_KEY_APP`; `push-secrets` refuses any other name in it.

### Trigger.dev prod env vars

`deploy/server/release.sh trigger` deploys the task code only; each project's env vars are set in the Trigger.dev dashboard (the project, Environment Variables, Production).
The lists come from the static import closure of each project's task directories (the parked `revola/aws-infra` design, `deploy/aws/trigger-env-keys.ts`, run against this tree).
A "secret" value is the key of the same name in `comp/production/config`; copy it from the env file `push-secrets` reads it from (`deploy/server/secrets/keys.ts` names the file).
`DATABASE_SSL_CA` and `NODE_EXTRA_CA_CERTS` are set by the CA build extension at deploy.

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

The URLs agree with `deploy/server/env/*.public.env` and `deploy/aws/public-env.ts`.
`BETTER_AUTH_URL` means the API host in this fork (the API's own code never uses it for app links), so `comp-api` gets the API host; the app image's `NEXT_PUBLIC_BETTER_AUTH_URL` is the app host, and `comp-app` tasks do not read it.
Tasks reach the API through its public host, which has no Access application.

## 5. Production secret

**Kyle runs**, from any checkout of this branch, pointing `--source` at the main checkout:

```bash
bun deploy/server/push-secrets.ts --source <main checkout> --dry-run
bun deploy/server/push-secrets.ts --source <main checkout>
```

It builds `comp/production/config` (Secrets Manager, `us-east-2`) for exactly the keys in `deploy/server/env/*.keys`, each copied from one file (`deploy/server/secrets/keys.ts`): the env files of `apps/api`, `apps/app`, `apps/portal` and `packages/db`, plus `deploy/server/.env.production.local`.
The env files are parsed in memory; the output names keys and files, never values.
It refuses, by key name: a database URL that is not the production database (`packages/db/production-target.json`), that does not parse or read back as written (percent-encode `/`, `?`, `#` and `@` in the password), or that uses port 6543; a service or forwarded-IP token under 32 characters; a value naming `localhost`, `127.0.0.1` or `host.docker.internal`; an empty value or one with a line break or NUL; a `tr_dev_` key; a value that disagrees with its copy in another env file; a linked worktree as `--source`; a changed `ENCRYPTION_KEY` or `SECRET_KEY` (they encrypt stored credentials and sign sessions, so they never change once set).

Success, dry run: `comp/production/config does not exist yet; the push creates it`, `added (35): ...`, `dry run: nothing written`.
Success, real run: it prints the `aws secretsmanager create-secret` command (default `aws/secretsmanager` key, tag `Project=comp`, the value from a 0600 temporary file), asks `Type push to write comp/production/config`, and after `push` prints `created comp/production/config version <id>`.
Later runs print the added, changed and removed key names and use `put-secret-value`.

## 6. Provisioning

**Kyle runs**:

```bash
deploy/server/provision.sh --alert-email <address>
```

Type `yes` for each create it prints (the resources are listed in `deploy/server/README.md`, Provisioning).
Then confirm the subscription in the email SNS sends; until then the alarms reach nobody.
Watch the first boot through Session Manager (the script prints the instance id):

```bash
aws ssm start-session --target <instance-id> --region us-east-2
sudo cloud-init status --long          # status: done
cat /opt/comp/provisioned              # the Docker and Compose versions
```

`status: error` means `user-data.sh` stopped; `/var/log/cloud-init-output.log` says where.
The health alarms fire until the first release brings the tunnel up; that is expected.

## 7. First migrate and release

Pick a SHA that is pushed to a branch of `origin`, then **Kyle runs**:

```bash
deploy/server/release.sh migrate <sha>
```

This is the first run of two untested paths, so watch for them:

- **The tools image builds for the first time.** The server builds `comp-migrate:<sha12>` from the `migrate` target of `deploy/aws/Dockerfile` (`db:getschema`, the app's `prisma generate`).
  A build failure changes nothing; `release.sh` prints the log path, and `deploy/server/release.sh logs --release <log>` shows the failing step.
  `deploy/server/release.sh status` shows the disk use of `/` (60 GB in all); a full disk shows up as a build failure too.
- **Prisma verifies the Supabase CA against the pooler.** The migrate container adds `sslmode=require`, `sslcert=/app/certs/supabase-ca.crt` and `sslaccept=strict` to `DATABASE_MIGRATION_URL`.
  Success is a readable status ("Database schema is up to date", or a list of pending migrations and the question).
  A certificate or host-name error (for example `self signed certificate in certificate chain`, or P1011) means the CA or the host is wrong: recheck step 2.4 and 2.5 and run `push-secrets` again.
  Do not remove the verification to get past it; until the status reads, every release is refused at the migration gate.

Only pending migrations lead to the question; type `migrate` to apply them.
Then **Kyle runs**:

```bash
deploy/server/release.sh release <sha>
```

The first release builds `comp-api`, `comp-app` and `comp-portal` one at a time (the slowest step; the Next.js builds use most of the 16 GB), renders the env files, checks the migrations, starts the stack and runs the smoke checks from the laptop.
Success: `Released <sha12>: it serves and passes the smoke checks`, and the tunnel shows Healthy in Cloudflare.
`render-env.sh failed` means a key is missing from the secret: rerun `push-secrets` (step 5).
A failed first release stops the stack and says the site is down; fix the cause and release again.

## 8. Google sign-in

**Kyle runs**, in the Google Cloud console, APIs & Services, Credentials, the OAuth client whose id is `AUTH_GOOGLE_ID`:

- Authorized JavaScript origins: `https://app.comp.revola.ai`, `https://portal.comp.revola.ai`, `https://api.comp.revola.ai`.
- Authorized redirect URIs: `https://api.comp.revola.ai/api/auth/callback/google`.

The API is the better-auth server (`apps/api/src/auth/auth.server.ts`, `baseURL` = `BASE_URL` = the API host, default base path `/api/auth`), so the callback goes to the API whichever app started the sign-in.
Success: step 10's sign-in completes; a `redirect_uri_mismatch` page from Google means the URI above is missing or mistyped.

## 9. Trigger.dev deploy

**Kyle runs**:

```bash
deploy/server/release.sh trigger <sha>
```

Type `trigger`; it deploys `apps/api`, then `apps/app`, to their prod environments with `npx trigger.dev@4.4.3 deploy --env prod`, in a one-off container of the tools image that runs as the `node` user.
This is the first run of that path, so watch for:

- A permission error (`EACCES`, `EPERM`, a failed `chown`), most likely from the Prisma extension running `prisma generate` into the root-owned `node_modules/.prisma`.
  Nothing is deployed for that project; the fix belongs in the image (generate that client at build time, or give that one directory to `node`), followed by a release and this step again.
- A network or build error from `npx` or Trigger.dev's remote build, shown in the log `release.sh` prints.

Success: the CLI reports a deployed version for each project, and the Trigger.dev dashboard lists it under Deployments, Production.
Once both are deployed, the laptop that ran the schedules with `COMP_RUN_SCHEDULES_IN_DEV=true` removes that variable (`docs/self-hosting-local.md`, Local runs write production data).

## 10. Acceptance checks

**Kyle runs** each check; all must pass.

1. Sign-in: open `https://app.comp.revola.ai`, pass Access with a `@revola.ai` Google account, then sign in to Comp with Google.
2. One session everywhere: in the same browser `https://api.comp.revola.ai/api/auth/get-session` returns your user as JSON, and `https://portal.comp.revola.ai` opens signed in (after its own Access login).
   The cookie domain is `.comp.revola.ai` (`AUTH_COOKIE_DOMAIN`).
3. Evidence upload: open a task, upload a file as evidence, reload the page and download it again.
4. A policy regeneration on Trigger.dev prod: first make sure no laptop runs `trigger dev` for `comp-api`.
   Open a policy, regenerate it, and watch the `update-policy` run in the Trigger.dev dashboard (`comp-api`, Production, Runs) complete; the policy content changes.
5. The rate-limit bucket comes only from the tunnel.
   Public routes are limited per visitor IP and answer with `x-ratelimit-remaining`; a forged `CF-Connecting-IP` that chose the bucket would show a fresh bucket (`99`) for each new value.
   From the laptop (Cloudflare replaces a client's `CF-Connecting-IP` with the real address at the edge):

   ```bash
   for ip in 203.0.113.7 198.51.100.9; do
     curl -s -o /dev/null -D - -H "CF-Connecting-IP: $ip" https://api.comp.revola.ai/v1/health | grep -i x-ratelimit-remaining
   done
   ```

   From inside the server, past the tunnel (the API trusts `CF-Connecting-IP` only from `cloudflared` at `172.30.0.10`), in a Session Manager shell:

   ```bash
   sudo docker exec comp-app-1 node --input-type=module -e "for (const ip of ['203.0.113.7','198.51.100.9']) { const r = await fetch('http://api:3333/v1/health', { headers: { 'CF-Connecting-IP': ip } }); console.log(ip, r.headers.get('x-ratelimit-remaining')); }"
   ```

   Pass: in each run the second number is lower than the first (one bucket, your address or the app container's), never `99` twice.
6. Alarms: the Route 53 health checks (console, Route 53, Health checks) turn healthy, and the alarm emails stop with an OK message for each of `comp-api-health`, `comp-app-health` and `comp-portal-health`.
