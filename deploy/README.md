# Deploying the data tier

Phase 2 of `docs/MVP_PLAN.md`. This directory is the **durable** Postgres, the one the farm actually
runs on. `apps/api/docker-compose.yml` is the test stack and is deliberately not durable — it mounts
the data directory on tmpfs to keep fsync out of the concurrency measurements, and every run starts
from nothing.

Confusing the two loses the farm's entire history on the next reboot, silently, and tells you
afterwards. They are separate files for that reason.

## What runs here

| Service | Restart | Published on |
|---|---|---|
| `postgres` | `unless-stopped` | `127.0.0.1:5432` |
| `migrate` | `no` — one-shot | — |
| `api` | `unless-stopped` | `127.0.0.1:3000` |

`api` waits for `migrate` to **exit successfully**, which waits for `postgres` to be **healthy**. So
the schema is never behind the code that assumes it, and a failed migration stops the rollout instead
of starting an API against a half-migrated database. `migrate` deliberately does not restart: the
second attempt at a half-applied migration is rarely better than the first, and a loop hides it.

Nothing is published beyond loopback. Reachability is Tailscale's job.

## Standing it up

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env                      # every password; none may be blank

# Secrets are FILES, not variables — the signing key is a multi-line PEM and compose .env cannot
# hold one. They never reach deploy/.env, `docker inspect`, or `docker compose config`.
mkdir -p deploy/secrets && chmod 700 deploy/secrets
openssl genpkey -algorithm ed25519 -out deploy/secrets/session_signing_key.pem
openssl pkey -in deploy/secrets/session_signing_key.pem -pubout \
  -out deploy/secrets/session_public_key.pem
openssl rand -base64 32 | tr -d '/+=' > deploy/secrets/worker_registration_token
chmod 600 deploy/secrets/*

docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
curl -fsS http://127.0.0.1:3000/health && echo
```

Then make the database agree with `APP_DB_PASSWORD` — `migrations/001_init.sql` ships a committed
local-dev password for `mfarm_app`:

```bash
docker exec -i mfarm-postgres-1 psql -U mfarm -d mfarm \
  -c "ALTER ROLE mfarm_app WITH PASSWORD '<APP_DB_PASSWORD from deploy/.env>'"
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env restart api
```

`config.ts` exits **78** in production if it sees the committed default, so a farm that skipped this
step does not start. That is the intent.

### Two probes, and they are not interchangeable

The container healthcheck hits `/health` — **liveness**, no I/O, never fails while the process is
alive. It is deliberately not `/ready`, which touches both pools: a database-touching liveness check
turns a brief blip into a restart loop that outlasts the blip. Use `/ready` from your own monitoring,
where a 503 means "do not send traffic" rather than "kill this container".

### Unverified

The image built and ran in development, and then a `COPY` fix was made — `npm` does not hoist
`@fastify/rate-limit` to the root `node_modules`, so copying only that directory produced an image
that built cleanly and died at startup with `ERR_MODULE_NOT_FOUND`. The fix copies the whole
installed tree. **That rebuild has not been executed**, because registry access was unavailable at
the time. Run it once before trusting the stack:

```bash
docker build -f apps/api/Dockerfile -t mfarm-api:test .
docker run --rm -e NODE_ENV=production mfarm-api:test; echo "expect 78, got $?"
```

Exit **78** is the correct answer there: `EX_CONFIG`, refusing to start with no keys and no database.

## What you get, and what you do not

| | |
|---|---|
| Survives reboot, `compose down`, container replacement | yes — named volume `mfarm_pgdata` |
| Silent corruption detected | yes — `--data-checksums`, set at initdb and **not addable later** |
| Backups | every `BACKUP_INTERVAL_SECONDS`, verified after writing |
| **RPO** | **one backup interval** (6h default). No WAL archiving. |
| Point-in-time recovery | **no.** Add WAL-G or pgBackRest if hourly loss stops being acceptable |
| Off-box copies | **no.** See below — this is the gap most likely to bite |

A backup sitting on the same disk as its database protects you from a bad migration, a bad `DELETE`
and a dropped table. It does not protect you from the disk, the machine, or the provider. Ship them
somewhere else — `rclone sync`, `restic`, an S3 bucket, another box on the tailnet — and do it before
you need it rather than after.

## Backups

Written by the `backup` sidecar, which runs the same image as the server so `pg_dump` always matches
the server version. Each run produces two files:

- `mfarm-<stamp>.dump` — the database, custom format, compressed
- `mfarm-<stamp>.globals.sql` — **cluster roles**

The second one is the reason most restores fail. `pg_dump` captures a database and nothing else;
roles are cluster-wide. MFARM's isolation rests on `mfarm_app` existing as a separate non-superuser
role, so restoring into a fresh cluster without roles dies on the first `GRANT` — and the tempting
fix, restoring everything as the owner, gives you request handling that bypasses row-level security.

Role **passwords** are deliberately excluded (`--no-role-passwords`), so a stolen backup is not a
stolen credential. Set them again with `ALTER ROLE` after restoring into a new cluster.

Each archive is verified with `pg_restore --list` immediately after writing, and written to
`.partial` and renamed only on success — an interrupted dump can otherwise leave a truncated file
with a plausible name that retention keeps and somebody eventually tries to restore.

## Restoring

Never into the live database on the first attempt.

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env run --rm \
  -e TARGET_DB=mfarm_restore_check \
  backup /usr/local/bin/restore.sh /backups/mfarm-<stamp>.dump

docker exec -it mfarm-postgres-1 psql -U mfarm -d mfarm_restore_check \
  -c 'SELECT count(*) FROM sessions'
```

`restore.sh` refuses a database that already has tables unless `RESTORE_FORCE=1`, and runs
`pg_restore --exit-on-error` — whose absence is the default and produces a database that is *mostly*
there with an exit code of 0, which is the worst possible outcome.

It deliberately does **not** pass `--no-owner --no-privileges`. Those are the usual reflex for making
a restore "just work" and here they would dismantle the isolation model: ownership decides whether
RLS applies at all, and the privileges are what give `mfarm_app` its narrow access.

## The drill

```bash
npm --prefix apps/api run db:up      # or point PG_CONTAINER at the production one
./deploy/restore-drill.sh
```

Seeds a scratch database with known rows, an RLS policy and a granted role; backs it up with the real
`backup.sh`; **drops the database and the role**; restores with the real `restore.sh`; then checks
row count, a content checksum, that RLS and `FORCE` survived, that the policy survived, and that the
role's grants survived.

Nothing is stubbed. A change that breaks recovery breaks this.

Run it on a schedule, not once — the failure this catches is the one where backups have been quietly
producing unusable archives for six weeks. It never touches the farm's own database; everything
happens in a scratch database dropped on exit, including on failure.

## Operational notes

- `docker compose ... down` is safe: the named volume survives. **`down -v` destroys it.** That flag
  belongs to the test stack and nowhere near this file.
- Postgres is bound to `127.0.0.1` only. Reachability is Tailscale's job. Publishing 5432 turns a
  future relaxed firewall rule into an exposed database.
- `stop_grace_period: 60s` lets Postgres finish a checkpoint. Shortening it means recovery on every
  restart.
- All services cap their logs (`10m` × 5). An uncapped json-file driver filling the disk takes the
  database down with it.
- The `api` container runs as an unprivileged user and writes nothing to disk — the control plane
  holds no state that is not in Postgres.
- `tini` is PID 1 so `docker stop` reaches Node as SIGTERM and `main.ts` runs its drain: stop
  accepting connections, finish in-flight requests, clear the reaper, then close the pools, in that
  order. The `command` uses `exec` for the same reason — without it the shell stays PID 1 of the
  process group and Node never sees the signal.

## Role hardening

Migration 012 gave the eight `SECURITY DEFINER` functions an owner that is not the superuser.

A definer function executes with the privileges of its **owner**, and all eight were owned by the
cluster superuser simply because that is who ran the migration creating them — so any future bug in
one of them would have been superuser execution rather than a bounded allocator bug. They are now
owned by `mfarm_definer`: `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, with privileges on
exactly the five tables the bodies touch.

It does hold `BYPASSRLS`, deliberately: the tenant tables are `FORCE ROW LEVEL SECURITY`, under which
even the table owner obeys policies, and these functions exist to do the fleet-wide work policies
forbid. The trade is explicit — the role can read and write those five tables regardless of org,
which is what the functions already did, and it can do nothing else. It cannot log in.

The same migration revoked `PUBLIC` EXECUTE from `allocate_device`, `release_device` and
`session_activate`. Migration 008 revoked the fleet-wide five and stopped, so those three kept the
grant Postgres hands out by default — making their explicit `GRANT ... TO mfarm_app` decorative. Not
an escalation while only two roles existed; it would have become one silently the first time anyone
added a third, including `mfarm_definer` itself.

`ci.yml` now asserts both properties on every build: no definer function owned by a superuser, none
EXECUTE-able by PUBLIC. Both regress by omission, so neither is left to review.
