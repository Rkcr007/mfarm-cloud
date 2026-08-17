# Deploying the data tier

Phase 2 of `docs/MVP_PLAN.md`. This directory is the **durable** Postgres, the one the farm actually
runs on. `apps/api/docker-compose.yml` is the test stack and is deliberately not durable — it mounts
the data directory on tmpfs to keep fsync out of the concurrency measurements, and every run starts
from nothing.

Confusing the two loses the farm's entire history on the next reboot, silently, and tells you
afterwards. They are separate files for that reason.

## Standing it up

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env                      # every password; none may be blank

docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env ps

set -a && . deploy/.env && set +a
npm --prefix apps/api run migrate
```

Then rotate the app role's committed password — `migrations/001_init.sql` ships a local-dev one:

```bash
docker exec -i mfarm-postgres-1 psql -U mfarm -d mfarm \
  -c "ALTER ROLE mfarm_app WITH PASSWORD '<the password in APP_DATABASE_URL>'"
```

`config.ts` exits **78** in production if it sees the dev default, so a farm that skipped this step
does not start. That is the intent.

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
- Both services cap their logs (`10m` × 5). An uncapped json-file driver filling the disk takes the
  database down with it.
