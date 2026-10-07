# Tests of deploy/server

No suite reaches AWS, GitHub, a database or Trigger.dev, or starts a container; run each from the repository root.

```bash
bash deploy/server/tests/render-env.test.sh   # key sets, modes, refusals, no value in output
bash deploy/server/tests/render-env-refusals.test.sh   # malformed secret or env files refused by name
bash deploy/server/tests/compose.test.sh      # docker compose config validates; stack shape
bash deploy/server/tests/provision.test.sh    # declined, confirmed and second runs; exact commands
bash deploy/server/tests/provision-failures.test.sh   # refusals, partial and drifted accounts, aws errors
bash deploy/server/tests/user-data.test.sh    # size limit, checksums, version gates, updates
bash deploy/server/tests/user-data-units.test.sh   # restarter, reboot check, update window and lock
bash deploy/server/tests/release.test.sh      # pushed check, exact calls, migration gate, rollback on failure
bash deploy/server/tests/rollback.test.sh     # rollback, lock, lease, account checks, status, logs
bash deploy/server/tests/release-ops.test.sh  # migrate, trigger and prune with typed confirmations; disk
bash deploy/server/tests/interrupt.test.sh    # INT, TERM and HUP before and after the up step; unlock
(cd deploy/server && bun test)                # push-secrets: sources, refusals, diff, create or put, terminal; workspace
```

The render-env tests stub `aws` with a fake secret; the provision tests use the stateful fake `tests/fake_aws.py` and type their answers into a pseudo-terminal (`tests/tty_run.py`); the user-data tests source the script and stub `curl`, `docker` and the system tools, so nothing is installed or fetched.
The release tests run laptop and server in one sandbox: the fake `aws` runs each SSM command locally with `COMP_ROOT` pointing at a temporary `/opt/comp`, and `docker`, `git`, `curl`, `flock` and `df` are fakes, so nothing is built, fetched or started.
The interrupt tests have the fake `aws` or `curl` send INT, TERM or HUP to `release.sh`'s process group at a chosen call (`FAKE_AWS_INTERRUPT`, `FAKE_CURL_INTERRUPT`), as a Ctrl-C or a closed terminal would.
`compose.test.sh` needs Docker and Bun (it compares build arguments with `deploy/aws/public-env.ts`) and starts no container; the provision and user-data tests need `shellcheck` and `python3`.
The push-secrets tests run it as a separate process with `aws` on `PATH` being `secrets/testing/fake-aws.ts` and answers typed into a pseudo-terminal (`tests/tty_run.py`), over fixture env files in temporary checkouts, so nothing reaches AWS or a real env file.
