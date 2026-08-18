# Deploying the data tier

Phase 2 of `docs/MVP_PLAN.md`. This directory is the **durable** Postgres, the one the farm actually
runs on. `apps/api/docker-compose.yml` is the test stack and is deliberately not durable — it mounts
the data directory on tmpfs to keep fsync out of the concurrency measurements, and every run starts
from nothing.

Confusing the two loses the farm's entire history on the next reboot, silently, and tells you
afterwards. They are separate files for that reason.

## What runs here

| Service | Restart | Published on | File |
|---|---|---|---|
| `postgres` | `unless-stopped` | `127.0.0.1:5432` | `docker-compose.prod.yml` |
| `migrate` | `no` — one-shot | — | `docker-compose.prod.yml` |
| `backup` | `unless-stopped` | — | `docker-compose.prod.yml` |
| `api` | `unless-stopped` | `127.0.0.1:3000`, `127.0.0.1:9464` | `docker-compose.prod.yml` |
| `prometheus` | `unless-stopped` | `127.0.0.1:9090` | `docker-compose.obs.yml` |
| `alertmanager` | `unless-stopped` | `127.0.0.1:9093` | `docker-compose.obs.yml` |
| `grafana` | `unless-stopped` | `127.0.0.1:3001` | `docker-compose.obs.yml` |

`api` waits for `migrate` to **exit successfully**, which waits for `postgres` to be **healthy**. So
the schema is never behind the code that assumes it, and a failed migration stops the rollout instead
of starting an API against a half-migrated database. `migrate` deliberately does not restart: the
second attempt at a half-applied migration is rarely better than the first, and a loop hides it.

Nothing is published beyond loopback. Reachability is Tailscale's job.

## Standing it up

### The short way — `deploy/farm-up.sh`

```bash
deploy/farm-up.sh                 # everything: secrets, database, API, seed, devices, worker
CF_INSTANCES=2 deploy/farm-up.sh  # …with two devices
deploy/farm-up.sh --no-worker     # control plane only
```

Idempotent — re-running is the normal way to use it. It generates any missing secret and password,
brings up the prod stack, **reconciles the `mfarm_app` password** (without which the API exits 78
with the reason buried in a compose log), seeds the region and org and mints one tenant key into
`deploy/.state/api_key`, then starts the worker in a tmux session named `mfarm-worker` — tmux
because a dropped SSH tab otherwise takes the devices with it.

It does **not** do Tailscale, TLS, or the observability stack. Those need a decision from a human
rather than a default, and they are the sections below.

The long way is worth reading once anyway, because it is what the script does:

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
printf '%s' "$(openssl rand -base64 32 | tr -d '/+=')" > deploy/secrets/metrics_token
printf '%s' "$(openssl rand -base64 24 | tr -d '/+=')" > deploy/secrets/grafana_admin_password
chmod 600 deploy/secrets/*

# Both files declare `name: mfarm`, so the second one joins the same project and network. Drop the
# obs file to run the farm without Prometheus and Grafana.
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.obs.yml \
  --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.obs.yml \
  --env-file deploy/.env ps
curl -fsS http://127.0.0.1:3000/health && echo
curl -fsS -H "Authorization: Bearer $(cat deploy/secrets/metrics_token)" \
  http://127.0.0.1:9464/metrics | head -5
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

### The image, verified 2026-08-17

`npm` does not hoist `@fastify/rate-limit` to the root `node_modules` — this lockfile places it under
`apps/api/node_modules/` — so an earlier `COPY` of the root directory alone produced an image that
built cleanly and died at startup with `ERR_MODULE_NOT_FOUND`. The fix copies the whole installed
tree, and **that rebuild has now been executed**: the image builds and exits **78** (`EX_CONFIG`)
with all three refusals listed, which is the correct answer for no keys and no database.

Re-run it after any dependency change, because this failure is invisible until startup:

```bash
docker build -f apps/api/Dockerfile -t mfarm-api:test .
docker run --rm -e NODE_ENV=production mfarm-api:test; echo "expect 78, got $?"
```

Still unverified: the image has never run **against a real database**, and no worker has ever
registered with it.

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

## Observability

`docker-compose.obs.yml` adds Prometheus, Alertmanager and Grafana. It is a separate file so the
farm can run without them, and so a Grafana upgrade cannot break the file that stands up the
database.

### Where the numbers come from

The control plane exposes `/metrics` on a **second listener**, port 9464, not the API port.

That separation is the whole design. Every gauge is fleet-wide — devices, sessions and hosts across
every org — and it is collected on the **owner** pool, because `mfarm_app` is bound by RLS and with
no `app.org_id` set every policy matches zero rows. So the exporter would report a perfectly healthy
fleet of nothing on the app pool, and it reports everyone's data on the owner pool. Putting that on
the listener which also carries the internet-facing WebDriver hub means one forgotten `PUBLIC_PATHS`
entry discloses the fleet. A separate port cannot be reached by that class of mistake.

`METRICS_HOST` defaults to `127.0.0.1`. The compose file sets `0.0.0.0` **inside the container** so
Prometheus can reach it across the compose network, and `config.ts` refuses that combination in
production unless `METRICS_TOKEN` is set. One file, `deploy/secrets/metrics_token`, is read by both
the API (to require it) and Prometheus (to present it), so the two cannot drift into a scrape that
401s forever while every dashboard reads "No data".

No worker exporter. Everything one would report about a device, the control plane already holds, and
a second source of truth is a second thing to keep honest.

### What is alerted on

`observability/alerts.yml`, 15 rules, validated with `promtool`. The ones that earn their place:

| Alert | Fires when | Why it is not obvious otherwise |
|---|---|---|
| `MfarmDeviceResetStuck` | a device is CLEANING > 5 min | **This is the reset-failure signal.** A failed restore leaves the device in CLEANING by design — a device never returns to READY unconfirmed — so nothing else will ever surface it, and the farm silently loses that device forever |
| `MfarmReaperNotRunning` | no sweep in 10 min while the API is up | the reaper has no caller; nothing retries it and nothing notices it stopping. The symptom is a crashed client's device still held, hours later |
| `MfarmHostSilent` | no heartbeat for 60s | the agent beats every 10s. Past that, the control plane's view of that host's devices is fiction |
| `MfarmQueueWaitLong` | oldest queued session > 15 min | at two devices contention is the dominant UX problem, and queueing is the designed answer — so the alert is on the wait, not on the queue existing |
| `MfarmMetricsStale` | the fleet query fails | the API keeps answering scrapes with the last good gauges rather than 500ing, because a 500 reads as "target down" and hides the counters that say why. The graphs stay plausible and stop being current |

Two shapes recur in that file and both are deliberate:

- **Zero-filled gauges.** `mfarm_devices` publishes all eight device states for every placement, with
  explicit zeros. An absent series is not a zero — `== 0` cannot fire on one — so a vanishing series
  would make "no device is allocatable" silent at exactly the moment it matters.
- **A heartbeat timestamp, not an age.** `mfarm_host_last_heartbeat_timestamp_seconds` reports 0 for
  a host that registered and never beat, and `time() - 0` is enormous, so that case alerts. An age
  gauge has to invent a number for "never", and every invented number is either a false alert or a
  silent one.

### Alertmanager sends nothing until you configure it

As shipped, the default receiver has **no integrations**. Alerts fire, group, and appear in the
Alertmanager UI, and no human is told. That is a dashboard with a louder name, not alerting.

Fill in a receiver in `observability/alertmanager.yml` — Slack, email and webhook blocks are there,
commented — and then **prove it**:

```bash
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.obs.yml \
  --env-file deploy/.env stop api          # MfarmControlPlaneDown fires after 2m
# ...wait for the notification, then:
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.obs.yml \
  --env-file deploy/.env start api
```

An alerting path that has never delivered a message is an alerting path that does not work. This is
the single most common way monitoring is "set up" and useless.

### Known gaps

Stated rather than implied, because each of these looks covered from the dashboard:

- **No backup-freshness alert.** The `backup` sidecar logs its failures and nothing scrapes it, so
  backups can stop for six weeks without a page. `restore-drill.sh` in CI proves the *path* works;
  it does not prove last night's dump exists. Until this is closed, check `deploy/backups/` by hand.
- **No host metrics.** No disk, CPU, memory or temperature for the box itself. A full disk takes the
  database down and the backups with it, and nothing here will say so first. `node-exporter` is the
  fix and it needs host mounts.
- **No worker-side metrics.** cvd instance health, adb responsiveness and Appium wedging are
  invisible except through their effect on device state — and a wedged-but-alive Appium answers
  `/status` 200 forever (known issue 2).
- Grafana's own database is a named volume that nothing backs up. Everything in it is provisioned
  from files in this repo, which is why that is acceptable — do not hand-edit dashboards in the UI
  and expect them to survive.

## Tailscale ingress only

**Nothing in this stack is published beyond loopback.** Every `ports:` entry in both compose files
begins `127.0.0.1:`. That is the invariant; the rest of this section is how to reach the farm anyway.

### The model

Tailscale is **defence in depth, not the authorization model**. A VPN authenticates the *network*;
the ADR-0004 grant authenticates the *request*. Appium stays bound to `127.0.0.1` and is reachable
only through the worker's gateway, which verifies a two-minute Ed25519 grant naming the session,
device, org, fence and host — offline, against the key it received at registration. Losing the
tailnet would not, by itself, give anyone a device.

### Standing it up

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=mfarm-farm
tailscale ip -4                                   # the address everything below uses
```

Then **verify** rather than assume. This is the check that catches a service someone added later:

```bash
sudo ss -tlnp | grep -v '127.0.0.1\|::1\|100\.' && echo "^ PUBLICLY BOUND — fix before continuing"
```

Every listener must be on loopback or on the `100.x.y.z` tailnet address. A bare `0.0.0.0` line is a
finding, not a formatting quirk.

Firewall, as a second layer, because a compose file edited in a hurry can undo the first:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw allow 41641/udp                  # direct connections; without it you fall back to a relay
sudo ufw enable
```

**Do this only once `tailscale ssh` works.** Enabling `ufw` while your only session is SSH on the
public interface locks you out of a machine that has no console.

### The worker's listeners

The agent's data plane and automation gateway bind **all interfaces by default** — right for a box
whose only NIC is the tailnet, wrong for a rented VM. Set `BIND_HOST` to the Tailscale address:

```bash
BIND_HOST=$(tailscale ip -4) DATA_PLANE_PORT=8080 AUTOMATION_GATEWAY_PORT=8090 node workers/agent/src/index.ts
```

Advertised endpoints (`AUTOMATION_ADVERTISE_BASE`, `APPIUM_ADVERTISE_HOST`) must then name the
tailnet address or MagicDNS name — an endpoint the control plane registers but cannot reach is a
device that absorbs sessions and fails them.

### TLS internally

Tailscale traffic is already WireGuard-encrypted end to end, so nothing on the tailnet is in the
clear. TLS is still worth terminating for one concrete reason: Appium clients are handed
`https://<key>:<session-id>@hub/wd/hub`, and a self-signed certificate means every teammate's suite
needs a trust-store change.

`tailscale serve` solves that with a real, publicly-trusted certificate and no open ports. Enable
MagicDNS and HTTPS certificates in the tailnet admin console first, then:

```bash
sudo tailscale serve --bg --https=443  http://127.0.0.1:3000    # control plane + WebDriver hub
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3001    # Grafana
sudo tailscale serve status
```

The farm is then `https://mfarm-farm.<tailnet>.ts.net/` from any device on the tailnet, with a
certificate every client already trusts, while `ss -tlnp` still shows nothing but loopback.

Separate ports rather than sub-paths on purpose: Grafana behind a sub-path needs
`GF_SERVER_SERVE_FROM_SUB_PATH` and a matching root URL, and getting one of the two wrong produces a
UI that half-loads. Set `GRAFANA_ROOT_URL` in `deploy/.env` to the URL above either way, or every
link Grafana generates points at `127.0.0.1` — a different machine for whoever is reading it.

**Never `tailscale funnel`.** It is one word away from `serve` and it publishes to the open
internet. An internet-facing Appium port is unauthenticated device control.

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
