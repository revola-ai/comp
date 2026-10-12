# Releasing Comp to the tunnel server

How `deploy/server/release.sh` releases Comp to the server, rolls back and runs the tools; the stack and its configuration are in `README.md`, and day-to-day use is `docs/self-hosting-server-day2.md`.

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
deploy/server/release.sh unlock                            # free a lease a stopped run left (type: unlock)
```

It refuses other accounts and an `AWS_REGION` or `AWS_DEFAULT_REGION` other than `us-east-2`, and works on the one running instance named `comp-server`.
`migrate`, `trigger`, `prune` and `unlock` read their typed word from the terminal (`/dev/tty`), never from stdin, and refuse before any AWS call without one; `release` and `rollback` ask nothing (running them is the decision) but print what they will do first.
It never uses SSH: every server step is one SSM Run Command (`AWS-RunShellScript`, an explicit execution timeout, 600 seconds for delivery) that runs as root.
The command's text is `lib/server-common.sh` with `on-server/entry.sh` (or `on-server/status.sh`), so it works whatever the server's checkout holds; the work itself runs from `deploy/server/on-server/` of a checkout.
A step with a SHA (a release's steps, `migrate`, `trigger`) runs from its own worktree of that SHA, `/opt/comp/work/<sha12>`, removed when the step ends; a step without one (a rollback's steps, `prune`, `unlock`) runs from `/opt/comp/src`, the checkout of the serving release.
`/opt/comp/src` moves only when a release or rollback is recorded, so a step without a SHA always runs the scripts of the release that serves, never those of a commit that was only migrated, deployed to Trigger.dev or refused.
SSM parameters carry names, tags and SHAs only: the server reads the secret itself (`render-env.sh`) and no value appears in a command line, an SSM parameter, a log name or this script's output.

A `<sha>` is 12 or 40 hex characters and must be on the `revola/self-host` branch of the fork `revola-ai/comp`, because releases, migrations and Trigger.dev deploys come only from reviewed, merged work, and the server fetches it from there; anything else is refused before any AWS call, and its first 12 characters are the image tag.
`release.sh` decides this against the fork's URL, never a remote name (in a checkout of upstream, `origin` is `trycompai/comp`): it fetches the branches of `https://github.com/revola-ai/comp` with `--prune --no-tags` into `refs/comp-release/*`, needs a ref there to contain the SHA (so a deleted branch does not count; push with `git push revola <branch>`), then needs `refs/comp-release/revola/self-host` to contain it (`git merge-base --is-ancestor`): a SHA only on a feature branch is refused with "merge it into revola/self-host first".
The server checks `revola/self-host` again after its own fetch, so a step run some other way cannot check out another branch's commit either.

Every step that may change something, on the server:

- takes the server lock (`flock` on `/opt/comp/release.lock`, never waiting): release, rollback, migrate, trigger, prune and unlock run one at a time, a second caller fails at once, and the security updates and the reboot check wait for it (`README.md`, First boot);
- holds, for a release or rollback, a lease (`/opt/comp/release.lease`, 20 minutes) between bringing the tag up and recording it (while the laptop runs the smoke checks), so nothing starts in between; an expired lease is ignored; an up step that cannot write the lease brings the previous tag back at once, because without it the laptop could neither record nor revert the run;
- with a SHA, checks it out in its own worktree under umask 022 and makes it (not `.git`, never through a symlink) world-readable, so the images' `node` user can read what BuildKit copies; the first step of a run first fetches every branch of `https://github.com/revola-ai/comp` (by URL) into `/opt/comp/src`, checks `revola/self-host` and refuses local changes in `/opt/comp/src`;
- writes its full output to `/opt/comp/logs/<utc>-<step>-<sha12>.log` (0600 in a 0700 directory); `release.sh` prints the last 200 lines (at most 20,000 bytes, because SSM keeps 24,000 characters) and the log's path.
  When the output still arrives cut short, it says so and prints the `logs --release` command that fetches the full log in pages.
- adds one line per attempt to `/opt/comp/releases.log`, `<utc> <action> <sha12> <ok|failed|rolled-back>`; the current tag is the top of the serving history (see rollback).
  Every write to it is checked: a finish step that cannot record its release (a full disk, a read-only file) says so, never reports `recorded=ok`, and keeps the run's lease, so nothing else starts until the cause is fixed and `unlock` frees it; then release the tag again.

## Configuration snapshots

Each release keeps the configuration it was verified with as the snapshot of its tag, `/opt/comp/releases/<tag>/` (0700, files 0600): `sha` (the full 40-character SHA), `compose.yaml` (that commit's) and `env/<service>.env` (rendered from `comp/production/config` by that commit's `render-env.sh` and `.keys` files).
A release renders its configuration into `/opt/comp/stage/<run>/`, checks the migrations and brings the stack up with it, and only when the smoke checks pass does it become the tag's snapshot (a release of the same tag replaces the older one).
Bringing a tag back (after a failed health or smoke check, an interrupt, or `rollback`) always uses that tag's own snapshot, so a bad secret, a `.keys` change or a `compose.yaml` change of the new commit leaves with it.
`status` lists the tags that have one; `prune` removes a tag's snapshot together with its images and keeps those of the current tag and the rollback target.
A server released before snapshots existed has none: its serving tag's configuration (`/opt/comp/env` and the `compose.yaml` of `/opt/comp/src`, while that is still at the tag) becomes its snapshot at the first release or rollback after the upgrade; older tags have none, so `rollback` refuses them.

## release

1. The build step (up to 2 hours) builds `comp-api`, `comp-app`, `comp-portal` and the tools image `comp-migrate` at the tag, one at a time with `docker buildx bake -f deploy/aws/docker-bake.hcl --load <target>`, skipping images that exist.
   It changes nothing that serves, so an interrupt cancels it (the next release of the SHA skips what was built), and it takes no lease.
   Another step may run between it and the up step; that is harmless, because the up step checks everything again under the lock before any container changes: it refuses when an image of the tag is missing (removed meanwhile; release again), renders the configuration and checks the migrations itself.
2. The up step (up to 30 minutes) renders the run's configuration (`render-env.sh` into `/opt/comp/stage/<run>/`) and runs `prisma migrate status` in the tools image against `DATABASE_MIGRATION_URL`.
   Pending or failed migrations, or a status it cannot read, stop the release before any container changes; it prints the list and the `release.sh migrate <sha12>` command.
   Migrations in the database that the commit lacks ("not found locally" in Prisma's output) stop it too: release a commit that includes them.
   Prisma 7.6 reports a database that is only ahead, with nothing of the commit missing there, as up to date, so that release goes ahead like a rollback.
3. `docker compose up -d --no-build --wait --wait-timeout 600` with the new tag and the run's configuration.
4. From the laptop, in this order: `https://api.comp.revola.ai/v1/health/ready`, `https://app.comp.revola.ai/api/health/live` and `https://portal.comp.revola.ai/api/health` must answer 200, and `https://app.comp.revola.ai/` and `https://portal.comp.revola.ai/` a 302 to `<team>.cloudflareaccess.com` (Access is on for both hosts); then the run's configuration becomes the tag's snapshot, the release is recorded `ok`, and `/opt/comp/src` moves to its SHA.
   Each check is tried up to 24 times, 5 seconds apart, each try for at most 10 seconds, and all of them share a 600-second deadline (half the 1,200-second lease): five checks could otherwise take about 1,775 seconds, past the lease, and the finish or revert step would then be refused while a failing tag kept serving.
   No try starts after the deadline and each is cut to the time left, so the other half of the lease is left for sending finish or revert; a check stopped by the deadline says so.
   When `/` is then more than 70% used, the server removes old images by the rules of `prune` (below), without asking, and prints what it removed.

A failure after the containers changed (health or smoke) brings the previous `ok` tag back up with its own snapshot, smoke-checks it, and says which tag serves; the attempt is recorded `rolled-back`.
When the release was of the tag that already serves, only the env files changed (re-rendered from the secret), so it says a change in `comp/production/config` is the likely cause; the tag serves again with the env files of its snapshot.
After a first release there is nothing to go back to: the failed stack is stopped, the attempt recorded `failed`, and `release.sh` says the site is down.
A refused release (a build failure, a render failure, the migration gate) changes nothing live: it drops its staged configuration, so the snapshots, the configuration the containers run with and `/opt/comp/src` stay as they were.
When bringing the previous tag back fails too (its images or snapshot are gone, or its `up` fails), `release.sh` says so and that the site may be down.
When the finish step's output arrives cut short, whether the release was recorded is unknown: `release.sh` says so, exits 1 and points at `status`, never at a rerun.
When SSM reports the up step timed out, cancelled, undeliverable or terminated, or its output lacks the end marker, `release.sh` says the serving state is unknown and prints `deploy/server/release.sh status`; for the build step it says the earlier release still serves (a build changes no container).
Interrupted (Ctrl-C, `SIGTERM`, a closed terminal), `release.sh` cleans up before it exits.
It cancels (`aws ssm cancel-command`) only a step that changes nothing: one that only reads (`status`, `logs`, the migration status, the prune plan) and a release's build step; every other step (`migrate`, `trigger`, prune's removal, the up step) is never cut short, so a migration cannot stay half applied: it waits for the step to end and reports it, saying nothing changed only when the server confirms it.
A build cut short leaves the images it finished; the bake it ran does not hold the server lock, so the next step is not blocked by it.
Once a release or rollback sent its up step, it then runs the revert step, which brings the previous tag back (or stops the stack after a first release), and reports what serves; a release already recorded stays released.
A second interrupt leaves at once and says what keeps running (with the `logs --release` command of a step).
Leaving while the up step runs lets the server finish it: the new tag may then serve unverified under the 20-minute lease, so run `status`, then `unlock`, then release (or roll back to) the SHA that should serve.
A laptop that stops without a signal (sleep, a dropped network) leaves the lease for up to 20 minutes, and the tag it brought up serving unrecorded: free the lease with `unlock`, then release the SHA that should serve.

## rollback

`releases.log`'s ok lines form a serving history, a stack: `release X` pushes X, `rollback X` pops back to X; the current tag is the top.
`rollback` brings back the entry below the top (so rolling back twice walks further back, never forward), or the given SHA's tag, with the same `up --wait`, smoke checks and recovery.
It refuses, before anything changes, a tag whose three images are gone (pruned), a tag without a snapshot (released before snapshots were kept, or pruned) and the tag that already serves.
It does not build, migrate or check out a new commit: it brings the tag back with its images as built and its snapshot, the env files and `compose.yaml` it was released and verified with; once recorded, `/opt/comp/src` moves to its SHA.
The database keeps any newer migrations.
A secret rotated since that release is not in its snapshot: the snapshot is the tag's known-good configuration, so a rollback brings back the values the tag was verified with.
A rotated secret reaches a tag only through a new release: after rolling back past a rotation (and always when the old value was revoked), release the rolled-back SHA again, which renders the current secret into a new snapshot behind the same migration gate and smoke checks.

## migrate

`migrate <sha>` checks the SHA out in its own worktree, builds `comp-migrate:<sha12>` if needed, renders that commit's configuration into `/opt/comp/stage/<run>/` (removed when the step ends) and shows the migration status; only pending migrations lead to the question, and only the typed word `migrate` applies them.
Nothing live changes: no snapshot, no container of the stack, and `/opt/comp/src` stays at the serving release.
A database ahead of the commit, a failed migration or an unreadable status is refused with the release gate's message, never applied.
It then runs `prisma migrate deploy` in a one-off container (`docker compose --profile tools run --rm migrate`, which the unhealthy-container timer leaves alone) with `COMP_I_AM_TOUCHING_PROD=1`, and shows the status again; the guard in `packages/db/prisma.config.ts` still checks the target.
Prisma gets `DATABASE_URL` from `migrate.env` (the secret's `DATABASE_MIGRATION_URL`, the session pooler or the direct host, never port 6543), and the container adds `sslmode=require`, `sslcert=/app/certs/supabase-ca.crt` and `sslaccept=strict` to it, so the schema engine verifies the chain and the host against the Supabase CA (it accepts any certificate otherwise).
The tools containers run as `node` with `HOME` on a tmpfs at `/tmp`, and can use up to 4 GiB each while they run, beside the stack's 5.25 GiB; the lock keeps them from overlapping an image build.

## trigger

`trigger <sha>` deploys the Trigger.dev tasks of `apps/api`, then `apps/app` (or only `--project api|app`) to their prod environments, after the typed word `trigger`.
It runs `npx --yes trigger.dev@4.4.3 deploy --env prod` from `/repo/apps/<project>` in a one-off container of `comp-migrate:<sha12>`; the CLI bundles there and builds the deploy image remotely on Trigger.dev.
Like `migrate`, it runs from its own worktree with that commit's configuration staged for the step only, so `/opt/comp/src` and the snapshots stay as they were.
Before deploying anything it checks the migrations as the release gate does: unless the database has exactly the commit's migrations (pending, failed, ahead of the commit, or unreadable), it refuses with the release gate's message, because the tasks would run against another schema; apply them first with `migrate`.
`trigger.env` holds `TRIGGER_ACCESS_TOKEN` (a personal access token) and both project refs, which must be in `comp/production/config` before the first `release` (render-env refuses missing keys); the container sets `TRIGGER_PROJECT_REF` from `TRIGGER_PROJECT_REF_API` or `TRIGGER_PROJECT_REF_APP`, which overrides the upstream ref in `trigger.config.ts`; it refuses, before deploying anything, a ref that is still an upstream Comp AI project (`proj_zhioyrusqertqgafqgpj`, `proj_lhxjliiqgcdyqbgtucda`).

The tasks' own env vars are set in the Trigger.dev dashboard (each project, Environment Variables, Production), not by `release.sh`; the list per project is in `docs/self-hosting-server.md`.

## status, logs

`status` prints the current and previous tags, the tags with a snapshot, a lease if one is held, every container of the `comp` project with its image and health, the last 10 lines of `releases.log` and the disk use of `/`, with a `WARNING` line when it is above 70%; it takes no lock and changes nothing.
`logs <service>` prints `aws logs tail /comp/<service> --follow --region us-east-2` (it does not run it; the tools containers log to `/comp/api`), and `logs --release <log>` fetches the last 500 lines of a step's log, by name or as `/opt/comp/logs/<name>`, in pages of 15,000 bytes.

## prune

`prune` lists what it keeps and what it would remove, then asks for the typed word `prune`; it keeps the images of the current tag, the 3 most recent other `ok` tags and the default rollback target (`rollback` needs them), the image of every container of the `comp` project, running or stopped, and the pinned `cloudflared` image, which is never a candidate (only `comp-api`, `comp-app`, `comp-portal` and `comp-migrate` images are removed), so it stays even when its container is gone.
It removes the snapshot of every tag it no longer keeps, with its images, so the current tag's and the rollback target's always stay.
It then trims the build cache to 20 GB (`docker builder prune --keep-storage 20GB -f`) and never runs `docker image prune`, which can delete the digest-pinned `cloudflared` image (Docker lists it untagged).
A release does the same by itself, without asking, when `/` is more than 70% used after it is recorded (`prune.sh auto`, bounded by `timeout 600`); the server reports `recorded=ok` first, so a failed or timed-out prune leaves the release standing and the laptop says "released, but the post-release prune failed" (or timed out), never a recording failure.

## unlock

`unlock` shows the lease a release or rollback holds between its steps (its run, what it is, how long ago it was taken and how long it has left) and, after the typed word `unlock`, removes it.
The unlock step runs under that run's id, so the server removes exactly the lease shown, and it holds the server lock, so it is refused while any step (of that run or another) still runs; it records `<action> <sha12> unlocked` and changes no container.
Use it only when that run's `release.sh` has stopped: a run still in its smoke checks could no longer record or revert its release.
