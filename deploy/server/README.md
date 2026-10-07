# Comp on the tunnel server

One ARM64 EC2 instance runs Comp with Docker Compose, reached only through a Cloudflare Tunnel (plan: `docs/plans/2026-10-07-server-tunnel-hosting.md`).
This file describes the stack, its configuration and how to release it (Releasing).
The runbook, from an empty account to the acceptance checks, is `docs/self-hosting-server.md`; running it day to day is `docs/self-hosting-server-day2.md`.

## Files

| Path | What it is |
|---|---|
| `compose.yaml` | The stack: `api`, `app`, `portal` and `cloudflared` on one private network, plus the one-off tools `migrate` and `trigger` (profile `tools`) |
| `env/<service>.keys` | Names of the secret keys each container gets from `comp/production/config` (never values) |
| `env/<service>.public.env` | Committed non-secret values each container gets (URLs, pool sizes, cookie domain) |
| `render-env.sh` | Writes `/opt/comp/env/<service>.env` from the secret and the public files |
| `push-secrets.ts`, `secrets/*.ts` | Runs on a laptop: builds `comp/production/config` from the operator's env files (runbook step 5); `bun test` in `deploy/server` runs its tests |
| `provision.sh`, `lib/provision-*.sh` | Creates the AWS resources of the server, one confirmed command at a time (see Provisioning) |
| `release.sh`, `lib/release-*.sh` | Runs on a laptop: release, rollback, migrate, Trigger.dev deploy, status, logs and prune, through SSM Run Command (see Releasing) |
| `on-server/*.sh`, `lib/server-*.sh` | The server side of `release.sh`, run as root by SSM |
| `user-data.sh` | First-boot setup of the instance: Docker, the compose and buildx plugins, updates, swap, the unhealthy-container timer, the checkout |
| `tests/*.test.sh` | Bash tests with a stubbed `aws`; run each with `bash deploy/server/tests/<name>.test.sh` |
| `tests/fake_*.py`, `tests/fake_git.sh` | Stateful fakes of `aws` (it runs SSM commands locally), `docker`, `git`, `curl` and `flock` |
| `tests/tty_run.py` | Runs a script with a pseudo-terminal to type answers into, or with no terminal at all |

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
sudo env TAG=<sha> docker compose -f deploy/server/compose.yaml up -d --no-build
```

The three Comp images are built on the server from the repository root, one at a time, and never pulled (`pull_policy: never`), so `docker compose up -d --no-build` with a tag that was never built fails instead of building whatever is checked out.
`release.sh` builds them with `deploy/aws/docker-bake.hcl` (`REGISTRY` empty, so they are tagged `comp-<name>:<TAG>`); the `build` sections of `compose.yaml` build the same images by hand (`docker compose build <service>`).
The `NEXT_PUBLIC_*` build arguments of `app` and `portal` equal `deploy/aws/public-env.ts` (`tests/compose.test.sh` checks).

Healthchecks are liveness probes that never touch the database, so a database outage does not mark a container unhealthy.
Docker restarts a container that exits (`restart: unless-stopped`), not one that turns unhealthy; health is what the release script waits for.
For that gap the server runs `comp-restart-unhealthy.timer` (installed by `user-data.sh`): every minute it restarts each `comp` container whose healthcheck reports `unhealthy`, and logs each restart to journald (`journalctl -u comp-restart-unhealthy`).
It leaves alone one-off `compose run` containers (the tools) and any container started less than 5 minutes ago (still in its start period, or one a release is waiting on), so it never fights the `up --wait` of a release, which gives up after 10 minutes.

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
The driver never creates groups, so the four groups must exist before the first `up`; `provision.sh` creates them with 30-day retention.
It runs in `non-blocking` mode with a 4 MB buffer: a CloudWatch outage drops log lines instead of stalling requests.

### The cloudflared image

Cloudflare publishes `cloudflared` only on Docker Hub (not on ECR Public or GHCR, checked 2026-10-07), so the image comes from `docker.io`, pinned by the digest of its multi-architecture index (`2026.10.0`).
The server pulls it only on first provision or a digest bump and keeps it cached, which stays far inside Docker Hub's anonymous pull limit even though the NAT gateway's address is shared.
Docker lists an image pulled by digest without a tag, so a plain `docker image prune` can delete it once its container is gone; `release.sh prune` removes only `comp-*` images and never runs `docker image prune`, so the pinned image stays even then (see Releasing).
If a pull is ever rate-limited, wait and rerun.
To update it, read the new index digest without pulling (`docker buildx imagetools inspect docker.io/cloudflare/cloudflared:<version>`) and change the tag and digest in `compose.yaml` together.
The image's entrypoint is `cloudflared --no-autoupdate`; the stack runs `tunnel run`, which reads `TUNNEL_TOKEN` from `cloudflared.env`.

## Env files

`render-env.sh` runs on the server as root before every `docker compose up`:

```bash
sudo deploy/server/render-env.sh            # writes /opt/comp/env/<service>.env
```

It reads the Secrets Manager secret `comp/production/config` (one JSON object) in `us-east-2` with the instance profile and, for each `env/<service>.keys`, writes `/opt/comp/env/<service>.env` (mode 0600 in a 0700 directory) with exactly the listed keys followed by the lines of `env/<service>.public.env`.
It checks every service before writing any file, and refuses by name a listed key that is missing from the secret, empty, not a string or containing a line break or a NUL character; on a refusal the previous files stay as they were.
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
- migrate (one-off, profile `tools`): `DATABASE_URL` (from `DATABASE_MIGRATION_URL`).
- trigger (one-off, profile `tools`): `TRIGGER_ACCESS_TOKEN`, `TRIGGER_PROJECT_REF_API`, `TRIGGER_PROJECT_REF_APP`.

No container of the stack reads `DATABASE_MIGRATION_URL`, `TRIGGER_ACCESS_TOKEN` or the `TRIGGER_PROJECT_REF_*` keys; only the one-off tools containers do.

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

## Provisioning

`provision.sh` runs once from a laptop with AWS credentials for account `455986776194` and creates everything the server needs in AWS:

```bash
deploy/server/provision.sh --alert-email <address>   # asks for the address when it is not given
```

| Resource | Details |
|---|---|
| IAM role and instance profile `comp-server` | `AmazonSSMManagedInstanceCore` (Session Manager); `secretsmanager:GetSecretValue` on `comp/production/*`; `logs:CreateLogStream` and `logs:PutLogEvents` on the four `/comp/*` groups only |
| Security group `comp-server` | In `vpc-06b67bec700b38a10`, with no inbound rule (the default outbound rule stays) |
| Log groups `/comp/api`, `/comp/app`, `/comp/portal`, `/comp/cloudflared` | 30-day retention |
| Instance `comp-server` | `t4g.xlarge`, the latest Amazon Linux 2023 arm64 AMI (SSM parameter), private subnet `subnet-08095a4ada58a9eef`, no public IP, no key pair, IMDSv2 required with hop limit 1, 60 GB encrypted gp3, termination protection, `user-data.sh` |
| Route 53 health checks | The liveness routes `https://api.comp.revola.ai/v1/health`, `https://app.comp.revola.ai/api/health/live` and `https://portal.comp.revola.ai/api/health`, every 30 seconds |
| SNS topic `comp-alerts` and alarms `comp-api-health`, `comp-app-health`, `comp-portal-health` | In `us-east-1`, where Route 53 publishes health-check metrics; an alarm fires after two failing minutes and mails again on recovery |

Everything is tagged `Name` and `Project=comp`.
The script refuses other accounts, and refuses to run when `AWS_REGION` or `AWS_DEFAULT_REGION` names a region other than `us-east-2`; every call passes its region explicitly.
It looks each resource up first and leaves an existing one alone, so a second run changes nothing (an inline role policy that differs from the expected one is offered as an update).
Each create prints the exact command and runs only when you type `yes` at the terminal; anything else skips it and whatever depends on it, and the run ends non-zero with the list of what was not done.
Answers (and the alert address, when prompted) are read from the terminal (`/dev/tty`), never from stdin, so `yes | provision.sh` confirms nothing; without a terminal the script refuses before any AWS call.
It needs bash 4 or newer (macOS ships 3.2; `brew install bash`).
It also stops on an existing `comp-server` security group with an inbound rule, more than one instance named `comp-server`, or an instance profile holding another role; it never adds or removes a rule.

The alert address is used in the AWS calls only and never written to a file.
SNS sends it a confirmation email, and the alarms reach nobody until the link in it is clicked; the script says so until it is.
Until the first release brings the tunnel up, the health checks fail and the alarms fire, which is expected.
Route 53 counts any 2xx or 3xx answer as healthy, and Cloudflare Access answers its login redirect at the edge even when the tunnel or the app is down.
The app and portal checks are therefore only meaningful once `/api/health/live` on the app host and `/api/health` on the portal host have Cloudflare Access Bypass applications; until then those two checks report healthy whatever the server does.
The runbook (`docs/self-hosting-server.md`, step 3) adds those two and a third for `/api/revalidate/path` on the app host, which `comp-app` Trigger.dev tasks call with `REVALIDATION_SECRET`; every other path of the two hosts stays behind Access.
The api host is not behind Access, so its check works from the start.

The instance hop limit of 1 keeps containers on the bridge network away from the instance credentials; the Docker daemon (the `awslogs` driver) and `render-env.sh` run on the host and keep them.
There is no SSH: open a shell with `aws ssm start-session --target <instance-id> --region us-east-2` (the script prints the command).

### First boot

cloud-init runs `user-data.sh` once, as root (`sudo cloud-init status --long` reports the result, `/var/log/cloud-init-output.log` has the output):

- Docker, git, python3, dnf-automatic and dnf-utils from the Amazon Linux repository.
- The compose plugin (`v5.5.1`) and buildx (`v0.37.2`) from their GitHub releases into `/usr/local/lib/docker/cli-plugins`, each checked against a pinned sha256; a mismatch stops the run.
  To bump one, change its version and checksum together, taking the checksum from the release's `checksums.txt`.
- dnf-automatic applies security updates every day at 09:00 UTC and only then (a drop-in replaces the packaged schedule and removes its random delay and its catch-up run at boot, so after downtime the next 09:00 run catches up); `/etc/dnf/vars/releasever` is `latest`, because Amazon Linux 2023 otherwise stays on the AMI's release and finds no updates.
  Docker and containerd are patched too: an update restarts the Docker daemon, which briefly stops the containers, and they come back by themselves (`restart: unless-stopped`).
- `comp-reboot-if-needed.timer` runs every Sunday at 09:30 UTC, ordered after any running update: it reboots only when `needs-restarting -r` reports that installed updates (a kernel, glibc, systemd) need it, and logs either way (`journalctl -u comp-reboot-if-needed`).
  Docker is enabled at boot and every container is `restart: unless-stopped`, so the stack comes back after the reboot without a release.
  A missed window (the server was off) is not caught up at boot.
- An 8 GiB swap file, `/swapfile`, for image builds (the containers themselves never swap).
- `comp-restart-unhealthy.timer` (see The stack).
- A clone of `https://github.com/revola-ai/comp` in `/opt/comp/src`.
- Last, a check for Docker Engine 25 or newer (healthcheck `start_interval`) and Compose 2.30 or newer (`format: raw`); on success it writes the versions to `/opt/comp/provisioned`.

## Releasing

`release.sh` runs on a laptop with AWS credentials for account `455986776194`, bash 4 or newer, `aws`, `git`, `python3` and `curl`:

```bash
deploy/server/release.sh release <sha>                     # build, check migrations, up, smoke checks
deploy/server/release.sh rollback [<sha>]                  # back one step in the serving history (or to <sha>)
deploy/server/release.sh migrate <sha>                     # apply the commit's migrations (type: migrate)
deploy/server/release.sh trigger <sha> [--project api|app] # deploy Trigger.dev prod (type: trigger)
deploy/server/release.sh status                            # tags, containers, last releases, disk
deploy/server/release.sh logs <service>                    # prints the aws logs tail command
deploy/server/release.sh logs --release <log>              # the last 500 lines of a step's log
deploy/server/release.sh prune                             # remove old images (type: prune)
```

It refuses other accounts and an `AWS_REGION` or `AWS_DEFAULT_REGION` other than `us-east-2`, and works on the one running instance named `comp-server`.
`migrate`, `trigger` and `prune` read their typed word from the terminal (`/dev/tty`), never from stdin, and refuse before any AWS call without one; `release` and `rollback` ask nothing (running them is the decision) but print what they will do first.
It never uses SSH: every server step is one SSM Run Command (`AWS-RunShellScript`, an explicit execution timeout, 600 seconds for delivery) that runs as root.
The command's text is `lib/server-common.sh` with `on-server/entry.sh` (or `on-server/status.sh`), so it works whatever the server's checkout holds; the work itself runs from `deploy/server/on-server/` of the checkout in `/opt/comp/src`.
SSM parameters carry names, tags and SHAs only: the server reads the secret itself (`render-env.sh`) and no value appears in a command line, an SSM parameter, a log name or this script's output.

A `<sha>` is 12 or 40 hex characters and must be on a branch of `origin` (`release.sh` runs `git fetch --prune origin`, then `git branch -r --contains`, so a deleted branch does not count), because the server fetches it from GitHub; anything else is refused before any AWS call; its first 12 characters are the image tag.

Every step that may change something, on the server:

- takes the server lock (`flock` on `/opt/comp/release.lock`, never waiting): release, rollback, migrate, trigger and prune run one at a time, and a second caller fails at once;
- holds, for a release or rollback, a lease (`/opt/comp/release.lease`, 20 minutes) between bringing the tag up and recording it (while the laptop runs the smoke checks), so nothing starts in between; an expired lease is ignored;
- with a SHA, fetches every branch of `origin` into `/opt/comp/src`, refuses local changes there and checks the SHA out detached under umask 022, then makes the checkout (not `.git`, never through a symlink) world-readable so the images' `node` user can read what BuildKit copies;
- writes its full output to `/opt/comp/logs/<utc>-<step>-<sha12>.log` (0600 in a 0700 directory); `release.sh` prints the last 200 lines (at most 20,000 bytes, because SSM keeps 24,000 characters) and the log's path.
  When the output still arrives cut short, it says so and prints the `logs --release` command that fetches the full log in pages.
- adds one line per attempt to `/opt/comp/releases.log`, `<utc> <action> <sha12> <ok|failed|rolled-back>`; the current tag is the top of the serving history (see rollback).

### release

1. Builds `comp-api`, `comp-app`, `comp-portal` and the tools image `comp-migrate` at the tag, one at a time with `docker buildx bake -f deploy/aws/docker-bake.hcl --load <target>`, skipping images that exist, then renders the env files (`render-env.sh`).
2. Runs `prisma migrate status` in the tools image against `DATABASE_MIGRATION_URL`.
   Pending or failed migrations, or a status it cannot read, stop the release before any container changes; it prints the list and the `release.sh migrate <sha12>` command.
3. `docker compose up -d --no-build --wait --wait-timeout 600` with the new tag (the release's checkout of `compose.yaml`).
4. From the laptop: `https://api.comp.revola.ai/v1/health/ready`, `https://app.comp.revola.ai/api/health/live` and `https://portal.comp.revola.ai/api/health` must answer 200, and `https://app.comp.revola.ai/` a 302 to `<team>.cloudflareaccess.com` (Access is on); each is retried every 5 seconds, 24 times (about 2 minutes); then it is recorded `ok`.

A failure after the containers changed (health or smoke) brings the previous `ok` tag back up the same way, smoke-checks it, and says which tag serves; the attempt is recorded `rolled-back`.
After a first release there is nothing to go back to: the failed stack is stopped, the attempt recorded `failed`, and `release.sh` says the site is down.
A refused release changes no container but leaves `/opt/comp/src` at the new SHA: after a build failure the env files are still those of the previous render, after a migration-gate refusal they are re-rendered from the new SHA.
When SSM reports the up step timed out, cancelled, undeliverable or terminated, or its output lacks the end marker, `release.sh` says the serving state is unknown and prints `deploy/server/release.sh status`.
If the laptop is interrupted after the new tag came up, it keeps serving unrecorded; `status` shows the running images next to the recorded tag, and rerunning `release <sha>` (nothing to build) records it.

### rollback

`releases.log`'s ok lines form a serving history, a stack: `release X` pushes X, `rollback X` pops back to X; the current tag is the top.
`rollback` brings back the entry below the top (so rolling back twice walks further back, never forward), or the given SHA's tag, with the same `up --wait`, smoke checks and recovery.
It refuses a tag whose three images are gone (pruned) or that already serves.
It does not build, migrate or check out: it uses the images as they were built and the server's current checkout of `compose.yaml` and env files, so compose changes since that release are not rolled back, and the database keeps any newer migrations.

### migrate

`migrate <sha>` checks the SHA out, builds `comp-migrate:<sha12>` if needed, and shows the migration status; only pending migrations lead to the question, and only the typed word `migrate` applies them.
It then runs `prisma migrate deploy` in a one-off container (`docker compose --profile tools run --rm migrate`, which the unhealthy-container timer leaves alone) with `COMP_I_AM_TOUCHING_PROD=1`, and shows the status again; the guard in `packages/db/prisma.config.ts` still checks the target.
Prisma gets `DATABASE_URL` from `migrate.env` (the secret's `DATABASE_MIGRATION_URL`, the session pooler or the direct host, never port 6543), and the container adds `sslmode=require`, `sslcert=/app/certs/supabase-ca.crt` and `sslaccept=strict` to it, so the schema engine verifies the chain and the host against the Supabase CA (it accepts any certificate otherwise).
The tools containers run as `node` with `HOME` on a tmpfs at `/tmp`, and can use up to 4 GiB each while they run, beside the stack's 5.25 GiB; the lock keeps them from overlapping an image build.

### trigger

`trigger <sha>` deploys the Trigger.dev tasks of `apps/api`, then `apps/app` (or only `--project api|app`) to their prod environments, after the typed word `trigger`.
It runs `npx --yes trigger.dev@4.4.3 deploy --env prod` from `/repo/apps/<project>` in a one-off container of `comp-migrate:<sha12>`; the CLI bundles there and builds the deploy image remotely on Trigger.dev.
`trigger.env` holds `TRIGGER_ACCESS_TOKEN` (a personal access token) and both project refs, which must be in `comp/production/config` before the first `release` (render-env refuses missing keys); the container sets `TRIGGER_PROJECT_REF` from `TRIGGER_PROJECT_REF_API` or `TRIGGER_PROJECT_REF_APP`, which overrides the upstream ref in `trigger.config.ts`; it refuses, before deploying anything, a ref that is still an upstream Comp AI project (`proj_zhioyrusqertqgafqgpj`, `proj_lhxjliiqgcdyqbgtucda`).

The tasks' own env vars are set in the Trigger.dev dashboard (each project, Environment Variables, Production), not by `release.sh`; the list per project is in `docs/self-hosting-server.md`.

### status, logs

`status` prints the current and previous tags, a lease if one is held, every container of the `comp` project with its image and health, the last 10 lines of `releases.log` and the disk use of `/`; it takes no lock and changes nothing.
`logs <service>` prints `aws logs tail /comp/<service> --follow --region us-east-2` (it does not run it; the tools containers log to `/comp/api`), and `logs --release <log>` fetches the last 500 lines of a step's log, by name or as `/opt/comp/logs/<name>`, in pages of 15,000 bytes.

### prune

`prune` lists what it keeps and what it would remove, then asks for the typed word `prune`; it keeps the images of the current tag, the 3 most recent other `ok` tags and the default rollback target (`rollback` needs them), the image of every container of the `comp` project, running or stopped, and the pinned `cloudflared` image, which is never a candidate (only `comp-api`, `comp-app`, `comp-portal` and `comp-migrate` images are removed), so it stays even when its container is gone.
It then trims the build cache to 20 GB (`docker builder prune --keep-storage 20GB -f`) and never runs `docker image prune`, which can delete the digest-pinned `cloudflared` image (Docker lists it untagged).

## Tests

```bash
bash deploy/server/tests/render-env.test.sh   # key sets, modes, refusals, no value in output
bash deploy/server/tests/render-env-refusals.test.sh   # malformed secret or env files refused by name
bash deploy/server/tests/compose.test.sh      # docker compose config validates; stack shape
bash deploy/server/tests/provision.test.sh    # declined, confirmed and second runs; exact commands
bash deploy/server/tests/provision-failures.test.sh   # refusals, partial and drifted accounts, aws errors
bash deploy/server/tests/user-data.test.sh    # size limit, checksums, version gates, updates
bash deploy/server/tests/user-data-units.test.sh   # restarter, reboot check, update window
bash deploy/server/tests/release.test.sh      # pushed check, exact calls, migration gate, rollback on failure
bash deploy/server/tests/rollback.test.sh     # rollback, lock, lease, account checks, status, logs
bash deploy/server/tests/release-ops.test.sh  # migrate, trigger and prune with typed confirmations
(cd deploy/server && bun test)                # push-secrets: sources, refusals, diff, create or put, terminal
```

The render-env tests stub `aws` with a fake secret; the provision tests use the stateful fake `tests/fake_aws.py` and type their answers into a pseudo-terminal (`tests/tty_run.py`); the user-data tests source the script and stub `curl`, `docker` and the system tools, so nothing is installed or fetched.
The release tests run laptop and server in one sandbox: the fake `aws` runs each SSM command locally with `COMP_ROOT` pointing at a temporary `/opt/comp`, and `docker`, `git`, `curl` and `flock` are fakes, so nothing is built, fetched or started.
`compose.test.sh` needs Docker and Bun (it compares build arguments with `deploy/aws/public-env.ts`) and starts no container; the provision and user-data tests need `shellcheck` and `python3`.
The push-secrets tests run it as a separate process with `aws` on `PATH` being `secrets/testing/fake-aws.ts` and answers typed into a pseudo-terminal (`tests/tty_run.py`), over fixture env files in temporary checkouts, so nothing reaches AWS or a real env file.
