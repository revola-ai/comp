# Comp on the tunnel server: day 2

Running Comp once it is live (`docs/self-hosting-server.md` takes it there).
Every command runs on a laptop with the prerequisites of that runbook (AWS CLI on account `455986776194`, bash 4, Bun, a terminal); `deploy/server/README.md` describes what each one does in detail.
Every step that changes AWS, Cloudflare or Trigger.dev is marked **Kyle runs**; status and logs only read.

## Release

**Kyle runs**:

```bash
deploy/server/release.sh release <sha>
```

The SHA must be pushed to a branch of revola-ai/comp (`git push revola <branch>`); `release.sh` checks the fork's URL itself, so a SHA only on upstream (`origin`) is refused.
The release builds the images on the server, checks the migrations, brings the new tag up and smoke-checks it from the laptop; a failure brings the previous tag back and says which one serves.
A release refused at the migration gate prints the `release.sh migrate <sha12>` command to run first.
A release of a commit older than a migration already applied is refused when Prisma reports the database's migrations as "not found locally": release a commit that includes them.
When `/` is more than 70% used after a release, the server removes old images by the rules of Prune below and prints what it removed.
When a release changes Trigger.dev task code, deploy it too (Trigger.dev below).

Releasing the SHA that already serves again is how a changed secret reaches the containers: `render-env.sh` re-reads `comp/production/config` and compose recreates the containers whose env changed.
If that release fails its checks, it says so: only the env files changed, so the secret is the likely cause; fix it and release again.

### Interrupted releases

Ctrl-C (or a closed terminal) during any `release.sh` command is safe.
It cancels only a step that only reads (status, logs, the migration status, the prune plan); a migration, a Trigger.dev deploy, prune's removal and a release's up step are never cut short: it waits for the step to end and reports it.
After a release's or rollback's up step was sent, it then brings the previous release back (after a first release, it stops the stack) and says what serves.
A second Ctrl-C leaves at once and says what still runs on the server (`status`, and the step's `logs --release <log>` command).
Leaving while the up step runs lets the server finish it, and the new tag may then serve unverified under a 20-minute lease: run `status`, then `unlock`, then release (or roll back to) the SHA that should serve.

A laptop that went to sleep or lost the network sends no signal: its lease holds the server for up to 20 minutes, and every other command is refused meanwhile.
**Kyle runs**, once that laptop's `release.sh` has stopped:

```bash
deploy/server/release.sh unlock     # shows the lease (run, age, time left); type: unlock
deploy/server/release.sh status     # what serves now
```

`unlock` is refused while a step still runs on the server and changes no container, so the tag that run brought up keeps serving unrecorded: release it again to verify and record it, or release the SHA that should serve.

## Rollback

**Kyle runs**:

```bash
deploy/server/release.sh rollback            # one step back in the serving history
deploy/server/release.sh rollback <sha>      # a specific earlier release whose images still exist
```

A rollback uses the images as they were built and does not undo migrations, so a release whose migration is not backward compatible cannot be rolled back past it.

## Migrate

**Kyle runs**:

```bash
deploy/server/release.sh migrate <sha>
```

It shows the migration status of the commit's schema and asks for the typed word `migrate` only when migrations are pending.
Migrations are authored on a laptop against the local `comp_dev` database (`bun run db:migrate:create` in `packages/db`), reviewed, merged, and reach production only through this command.

## Trigger.dev

**Kyle runs**:

```bash
deploy/server/release.sh trigger <sha>                  # both projects
deploy/server/release.sh trigger <sha> --project api    # or app
```

After the typed word `trigger` it deploys the task code to the prod environments.
Env vars of the tasks live in the Trigger.dev dashboard (**Kyle runs** any change there) (`docs/self-hosting-server.md`, Trigger.dev prod env vars); a change there applies to new runs without a deploy.

## Status and logs

```bash
deploy/server/release.sh status                   # tags, containers and health, last releases, disk
deploy/server/release.sh logs api                 # prints the aws logs tail command for /comp/api
deploy/server/release.sh logs --release <log>     # the last 500 lines of a release step's log
```

The containers log to CloudWatch (`/comp/api`, `/comp/app`, `/comp/portal`, `/comp/cloudflared`, 30 days); the one-off migrate and trigger containers log to `/comp/api`.
A shell on the server is `aws ssm start-session --target <instance-id> --region us-east-2`; there is no SSH.

## Adding a user

**Kyle runs** the Cloudflare and Comp changes below.

- Someone with a `@revola.ai` address: nothing to change in Cloudflare (the Access policy allows the domain) or in the API (`AUTH_ALLOWED_EMAIL_DOMAINS=revola.ai` in `deploy/server/env/api.public.env`).
  Invite them from the organization in Comp; they sign in with Google.
- Anyone else (an auditor, for example): invite them from the organization in Comp first, because the API refuses a sign-up from another domain unless the address holds a pending, unexpired invitation.
  Then add their address to the Allow policy of the app's Access application (Include, Emails), and of the portal's if they need it.
  Access offers only Google, so they need a Google account for that address, or add the One-time PIN login method to the Access application.
- Removing someone: remove them from the organization in Comp and from any Access policy that names them.

## Patching and reboots

The server patches itself: dnf-automatic applies security updates every day at 09:00 UTC (Docker included; an update restarts the daemon and the containers come back by themselves).
`comp-reboot-if-needed.timer` reboots on Sundays at 09:30 UTC only when an installed update needs it; the stack starts again at boot without a release.
Both wait up to an hour for the release lock, so neither restarts Docker under a release step, and a release step tried meanwhile is refused (try again later); the reboot is skipped, until the next Sunday, while a release holds its lease.
To see what happened, in a Session Manager shell: `journalctl -u dnf-automatic` and `journalctl -u comp-reboot-if-needed`.
Comp itself is patched by releasing a newer commit; the `cloudflared` image by bumping its digest in `deploy/server/compose.yaml` (README, The cloudflared image) and releasing.

## Prune

**Kyle runs**:

```bash
deploy/server/release.sh prune
```

A release prunes by itself, for at most 10 minutes, when `/` ends above 70% used; if that fails or times out, the release still stands and `release.sh` says so.
`status` prints a `WARNING` line above 70%; run `prune` when it does.
It lists what it keeps (the serving tag, the 3 most recent other ok tags, the default rollback target, every image a container uses, the pinned `cloudflared` image) and what it would remove, then asks for the typed word `prune`.

## Changing a secret

**Kyle runs** each step.

1. Change the value in the one env file `push-secrets` reads it from (`deploy/server/secrets/keys.ts` names it), in the main checkout, and in every other env file that holds a copy (`push-secrets` refuses copies that disagree).
2. `bun deploy/server/push-secrets.ts --source <main checkout> --dry-run`, then without `--dry-run`; the diff names the changed keys.
3. Release the serving SHA again (Release above), so the containers get the new value.
4. If Trigger.dev tasks use the key (the table in `docs/self-hosting-server.md`), change it in both projects' Production env vars too.

### Rotating a service token

`INTERNAL_API_TOKEN`, `COMP_FORWARDED_IP_TOKEN`, `SERVICE_TOKEN_TRIGGER` and `SERVICE_TOKEN_PORTAL` live only in `deploy/server/.env.production.local`; the laptops have their own values, so a rotation touches no laptop.
**Kyle runs**, in the main checkout, with `name` set to the token to rotate (it rewrites the file without that line, adds the new one, prints nothing and leaves the file 0600):

```bash
(umask 077 && name=SERVICE_TOKEN_PORTAL && f=deploy/server/.env.production.local &&
  { grep -v "^$name=" "$f"; printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"; } >"$f.new" && mv -f "$f.new" "$f" && chmod 600 "$f")
```

Then push it (steps 2 and 3 above) and, for `SERVICE_TOKEN_TRIGGER`, copy the new value with an editor into both Trigger.dev projects' Production env vars.
Between the release and the Trigger.dev change, tasks calling the API with the old token are refused; do it in a quiet moment.

`ENCRYPTION_KEY` and `SECRET_KEY` never rotate this way: the first encrypts stored integration credentials and the second signs every session, and `push-secrets` refuses a change to either.

## If the server is lost

Nothing on the server needs a backup: the database, files and Redis are hosted (Supabase, Upstash), the secret is in Secrets Manager, the logs are in CloudWatch, and the images are rebuilt from git.

**Kyle runs** each step.

1. If the instance still exists but is broken, terminate it (turn off its termination protection first).
2. `deploy/server/provision.sh --alert-email <address>` again: it leaves the existing role, security group, log groups, health checks and alarms alone and creates a new instance.
3. If any env value changed since the last push, run `push-secrets` first: it is the source of truth for `comp/production/config`.
4. `deploy/server/release.sh release <sha>` with the last good SHA (the release history lived on the old server, so the new one starts with no rollback target).
5. Run the acceptance checks in `docs/self-hosting-server.md`.
