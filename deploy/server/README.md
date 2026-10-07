# Comp on the tunnel server

One ARM64 EC2 instance runs Comp with Docker Compose, reached only through a Cloudflare Tunnel (plan: `docs/plans/2026-10-07-server-tunnel-hosting.md`).
This file describes the stack and its configuration; the operator runbook is added by the release and secrets tasks.

## Files

| Path | What it is |
|---|---|
| `compose.yaml` | The stack: `api`, `app`, `portal` and `cloudflared` on one private network |
| `env/<service>.keys` | Names of the secret keys each container gets from `comp/production/config` (never values) |
| `env/<service>.public.env` | Committed non-secret values each container gets (URLs, pool sizes, cookie domain) |
| `render-env.sh` | Writes `/opt/comp/env/<service>.env` from the secret and the public files |
| `tests/*.test.sh` | Bash tests with a stubbed `aws`; run each with `bash deploy/server/tests/<name>.test.sh` |

## The stack

| Service | Image | Listens | Healthcheck | Memory limit | Logs |
|---|---|---|---|---|---|
| `api` | `comp-api:<TAG>` (target `api` of `deploy/aws/Dockerfile`) | 3333 | `GET /v1/health` | 2 GiB | `/comp/api` |
| `app` | `comp-app:<TAG>` (target `app`) | 3000 | `GET /api/health/live` | 2 GiB | `/comp/app` |
| `portal` | `comp-portal:<TAG>` (target `portal`) | 3000 | `GET /api/health` | 1 GiB | `/comp/portal` |
| `cloudflared` | `cloudflare/cloudflared`, pinned by digest | none | none (distroless image) | 256 MiB | `/comp/cloudflared` |

`TAG` is the 12-character git SHA of the release; compose refuses to run without it.
Every compose command runs as root, because the compose CLI reads the env files itself and they are 0600 root in a 0700 directory.
`sudo` drops `TAG` from the environment, so the form is always:

```bash
sudo env TAG=<sha> docker compose -f deploy/server/compose.yaml build api
sudo env TAG=<sha> docker compose -f deploy/server/compose.yaml up -d --no-build
```

The three Comp images are built on the server from the repository root (`docker compose build <service>`, one at a time) and never pulled (`pull_policy: never`), so `docker compose up -d --no-build` with a tag that was never built fails instead of building whatever is checked out.
The `NEXT_PUBLIC_*` build arguments of `app` and `portal` equal `deploy/aws/public-env.ts` (`tests/compose.test.sh` checks).

Healthchecks are liveness probes that never touch the database, so a database outage does not mark a container unhealthy.
Docker restarts a container that exits (`restart: unless-stopped`), not one that turns unhealthy; health is what the release script waits for.

The four containers together are limited to 5.25 GiB (swap included), which leaves about 10 GiB of the 16 GiB host for an image build (the Next.js builds use a 6 GiB heap) and the system.
Every container drops all capabilities and runs with `no-new-privileges`.

### Network

All four containers share one bridge network, `comp_comp`, with the fixed subnet `172.30.0.0/24` (clear of the VPC `vpc-06b67bec700b38a10`, `10.0.0.0/16`, and of Docker's default `172.17.0.0/16`).
No port is published, and the instance's security group has no inbound rule: the only way in is the tunnel.
The network is not `internal: true`, because the containers need outbound access (Supabase, Upstash, Resend, model providers, Cloudflare's edge).

`cloudflared` has the static address `172.30.0.10`, and the API trusts `CF-Connecting-IP` only from that peer (`TRUSTED_EDGE_PROXY_IPS` in `env/api.public.env`).
Docker hands out dynamic addresses only from `172.30.0.128/25`, so no other container can take `172.30.0.10`.
Change the address in `compose.yaml` and `env/api.public.env` together; `tests/compose.test.sh` fails when they differ.

### Logs

Each container logs to the CloudWatch group `/comp/<service>` in `us-east-2` through the `awslogs` driver, with the instance profile's credentials.
The driver never creates groups, so the four groups must exist before the first `up`.
It runs in `non-blocking` mode with a 4 MB buffer: a CloudWatch outage drops log lines instead of stalling requests.

### The cloudflared image

Cloudflare publishes `cloudflared` only on Docker Hub (not on ECR Public or GHCR, checked 2026-10-07), so the image comes from `docker.io`, pinned by the digest of its multi-architecture index (`2026.10.0`).
The server pulls it only on first provision or a digest bump and keeps it cached (pruning never removes it), which stays far inside Docker Hub's anonymous pull limit even though the NAT gateway's address is shared.
If a pull is ever rate-limited, wait and rerun.
To update it, read the new index digest without pulling (`docker buildx imagetools inspect docker.io/cloudflare/cloudflared:<version>`) and change the tag and digest in `compose.yaml` together.
The image's entrypoint is `cloudflared --no-autoupdate`; the stack runs `tunnel run`, which reads `TUNNEL_TOKEN` from `cloudflared.env`.

## Env files

`render-env.sh` runs on the server as root before every `docker compose up`:

```bash
sudo deploy/server/render-env.sh            # writes /opt/comp/env/<service>.env
```

It reads the Secrets Manager secret `comp/production/config` (one JSON object) in `us-east-2` with the instance profile and, for each `env/<service>.keys`, writes `/opt/comp/env/<service>.env` (mode 0600 in a 0700 directory) with exactly the listed keys followed by the lines of `env/<service>.public.env`.
It checks every service before writing any file, and refuses by name a listed key that is missing from the secret, empty, not a string or containing a line break; on a refusal the previous files stay as they were.
It never prints a value, never passes one as a command-line argument and writes each file through a temporary file in the same directory.
Writes are atomic per file, not per run: an IO failure partway through can leave some files from the new secret and some from the old, so rerun `render-env.sh` until it succeeds before any `up`.
Env files of a service removed from `env/` are not deleted; remove them by hand.
`--out-dir DIR` writes elsewhere (the tests use it); compose reads `COMP_ENV_DIR` (default `/opt/comp/env`).

A `.keys` line is a key name, or `NAME from KEY` when the container variable differs from the key in the secret (the app's `AUTH_SECRET from SECRET_KEY`, and each project's `TRIGGER_SECRET_KEY`).
Lines starting with `#` are comments.
The files are written verbatim, one `NAME=VALUE` per line, and compose reads them with `format: raw`, so a value may contain `$`, quotes, `#` or spaces.

The rendered files hold secrets.
To inspect the resolved stack, use `docker compose config --no-env-resolution`; plain `docker compose config` prints every value.

### Which container gets what

The lists follow the parked AWS design (`deploy/aws/secret-keys.ts` and `unset-keys.ts` on `revola/aws-infra`), translated to this server: the API's overrides are `env/api.public.env`, the app and portal reach the API at `http://api:3333`, and `COMP_ORIGIN_AUTH*` are not used (the API trusts the tunnel peer instead).

- Shared by api, app and portal: `DATABASE_URL`, the `APP_AWS_*` storage keys for the main and org-assets buckets, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY`, `COMP_FORWARDED_IP_TOKEN`.
- api and app: the questionnaire and knowledge-base buckets, `SECRET_KEY`, `ENCRYPTION_KEY`, the Google sign-in pair, `RESEND_FROM_SYSTEM`, `RESEND_FROM_DEFAULT`, `UNSUBSCRIBE_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
- api only: `INTERNAL_API_TOKEN`, `SERVICE_TOKEN_TRIGGER`, `SERVICE_TOKEN_PORTAL`, `MACED_API_KEY`, `TRIGGER_SECRET_KEY` (from `TRIGGER_SECRET_KEY_API`).
- app only: `AUTH_SECRET` (from `SECRET_KEY`), `GOOGLE_GENERATIVE_AI_API_KEY`, `REVALIDATION_SECRET`, `TRIGGER_SECRET_KEY` (from `TRIGGER_SECRET_KEY_APP`).
- portal only: `SERVICE_TOKEN_PORTAL`.
- cloudflared: `TUNNEL_TOKEN`.

The app and portal never receive `INTERNAL_API_TOKEN`.
`DATABASE_MIGRATION_URL` and the `TRIGGER_PROJECT_REF_*` keys stay in the secret for migrations and Trigger.dev deploys; no container reads them.

## Connection budget

Production, Trigger.dev prod runs and the laptops share one Supabase session pooler.
In session mode every client connection holds one pooler slot, so the sum of every pool's maximum must stay under the pooler's pool size, less headroom.

| Input | Value | Source |
|---|---|---|
| Session pool size | 40 (assumed; confirm in Supabase, Database settings, Connection pooling) | Kyle |
| Headroom (migrations, SQL editor, Supabase's own clients) | 3 | proposed |
| `DATABASE_POOL_MAX` api / app / portal on the server | 4 / 2 / 1 | `env/*.public.env` |
| Readiness probe connections api / app / portal | 1 / 1 / 0 | `packages/db/src/readiness-probe.ts` |
| `DATABASE_POOL_MAX` per Trigger.dev prod run | 2 | Trigger.dev prod env vars |
| Trigger.dev prod concurrency `comp-api` / `comp-app` | 1 / 2 | Trigger.dev dashboard |
| Local stacks at once | 2 | plan |
| Connections per local stack | 8 | see below |

```
server  = (4 + 2 + 1) pools + (1 + 1) probes          =  9
trigger = 2 per run x (1 + 2) concurrent runs          =  6
local   = 2 stacks x 8                                 = 16
total   = 9 + 6 + 16                                   = 31  <=  40 - 3 = 37
```

The server counts once: `docker compose up -d` stops a container before starting its replacement, so old and new pools never overlap (ECS needed twice the pool for rolling deploys).
The readiness probes (`/v1/health/ready` on the api, `/api/health` on the app) each open one connection outside the pool while the release smoke checks run; the container healthchecks use the liveness routes and open none.
A local stack is the api, app, portal and framework-editor at one connection each, one `trigger dev` run per project holding its app's pool (1 + 1), and the two probes: 1 + 1 + 1 + 1 + (1 + 1) + (1 + 1) = 8.
The one-off migration container of a release runs from the headroom.
Change a pool size here and in `env/*.public.env` together (`tests/render-env.test.sh` pins 4 / 2 / 1).

Two inputs are assumptions until confirmed: the pool size of 40 (the real value depends on the Supabase compute size) and the laptop limits, which hold only where `scripts/local-run.sh` and the apps' `dev` scripts set `DATABASE_POOL_MAX=1` and `--max-concurrent-runs 1`; without them a laptop process uses the driver's default pool of 10.

## Tests

```bash
bash deploy/server/tests/render-env.test.sh   # key sets, modes, refusals, no value in output
bash deploy/server/tests/render-env-refusals.test.sh   # malformed secret or env files refused by name
bash deploy/server/tests/compose.test.sh      # docker compose config validates; stack shape
```

All stub `aws` with a fake secret; `compose.test.sh` needs Docker and Bun (it compares build arguments with `deploy/aws/public-env.ts`) and starts no container.
