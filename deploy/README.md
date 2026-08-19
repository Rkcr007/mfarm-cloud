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

### The web console

`farm-up.sh` also creates a console user — `admin@mfarm.local` by default, or `$CONSOLE_EMAIL` — and
writes a generated password to `deploy/.state/console_password` (mode 600). Open the API's own origin
in a browser to reach it:

```bash
cat deploy/.state/console_password        # the password, shown from disk rather than a log
xdg-open http://<host>:3000/              # the console is served by the API itself
```

The API port is loopback-bound, so reach it as `http://localhost:3000` through an SSH tunnel, or put
`tailscale serve` in front for real HTTPS. Both work with the default cookie settings — a browser
treats `localhost` as a secure context. If you instead re-publish the port and reach it over plain
HTTP on a tailnet or LAN address, set `SESSION_COOKIE_SECURE=0` in `deploy/.env`, or the browser will
refuse to store the cookie and signing in will appear to do nothing.

Sign in there to see the fleet, device state and capabilities, recent sessions, and the WebDriver URL
a suite should point at. It is the same API underneath: the browser holds a session cookie instead of
an API key, and every unsafe request carries a CSRF header.

Add or reset a user by hand — re-running for an existing email is the password-reset path, and it
invalidates that person's live sessions:

```bash
DATABASE_URL=postgres://... node --experimental-strip-types \
  apps/api/src/bin/create-user.ts someone@example.com '<a long password>' lab admin
```

Two things the console deliberately does not do yet: **there is no interactive device view**, because
media needs the TURN relay chosen in ADR-0005 and that is not deployed; and **a session cannot be
pinned to a specific device**, because the allocator picks one. Both are stated in the UI rather than
hidden behind a disabled button.

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
# NOT 600, and not owned by you. Compose bind-mounts file secrets with the HOST file's ownership
# and mode, and silently ignores the uid/gid/mode fields (they are swarm-only — verified ignored on
# compose 2.40.3). The API runs as `node` inside the image, so the files must be readable by that
# uid or the container restart-loops on
#   cat: can't open '/run/secrets/session_signing_key': Permission denied
# with a perfectly healthy database beside it. deploy/farm-up.sh does this for you.
sudo chown "$(docker run --rm --entrypoint id mfarm-api:latest -u)":"$(id -g)" deploy/secrets/*
sudo chmod 640 deploy/secrets/*

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

## Shipping a change

One command, and it names a commit:

```bash
deploy/mfarm-deploy.sh 91c171d              # the API, onto that commit
deploy/mfarm-deploy.sh 91c171d --worker     # ...and the worker agent too
deploy/mfarm-deploy.sh 3a41105              # rollback is the same command, older sha
```

**The commit is the unit of deployment, not the branch and not "the stack".** Push to `main`, CI
runs, and on green `.github/workflows/release.yml` builds one image tagged with that exact commit
and pushes it to `ghcr.io/rkcr007/mfarm-api`. The box pulls that image — it never builds its own any
more, because an image built on the box answers to nothing: two builds of "the same" source can
differ, and neither can be pointed at afterwards.

`mfarm-deploy.sh` then does four things, in an order chosen by how they fail:

1. **Resolves the image.** Pull from the registry; if the box has no registry credential yet, build
   locally from that pinned commit and *say so* — a local build is not the artifact CI tested.
2. **Migrates.** A separate one-shot with `restart: "no"`, so a half-applied migration stays failed
   and visible. If this step fails the API is never restarted, and the old code keeps serving the
   old schema — which is the correct outcome.
3. **Restarts only `api`.** `--no-deps`, so Postgres keeps its connections and the backup sidecar
   keeps its schedule. The worker is not in this compose file at all, so its devices stay booted.
4. **Asks the running API what it is.** `GET /v1/version` must report the commit that was requested,
   or the script fails loudly. Every deployment mechanism that has bitten this project bit it by
   succeeding quietly while changing nothing.

### Knowing what is deployed, without asking anyone

`/v1/version` returns the commit baked into the image at build time, when it was built, when the
process started, and the last migration the database applied. The console shows the short sha in its
header, with the rest on hover. **That badge is the point of the whole pipeline**: "is my fix live?"
is a browser refresh rather than an ssh session, and a redeploy that lands the same sha is still
visible because the process start time moves.

The sha is baked in at build time rather than read from a checkout at runtime, deliberately. A
process that reports the git state of the directory it happens to be running in reports the
deployer's intent; a process that carries the sha it was built from cannot misreport its own
contents.

### Registry credentials

The image is private, like the repository. Until the box has a credential, `mfarm-deploy.sh` falls
back to building locally — correct, but not the artifact CI tested. To close that gap, create a
GitHub token with `read:packages` and, once per box:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u rkcr007 --password-stdin
```

### The worker is a service, not a terminal

`deploy/install-worker-service.sh` installs `mfarm-worker.service` and stops the tmux session it
replaces. After that the agent survives reboots and closed ssh sessions, and its log is
`journalctl -u mfarm-worker -f`. `farm-up.sh` defers to the unit when it is installed rather than
starting a second agent onto the same devices.

Restarting the worker is cheaper than it looks: `bringUp()` adopts already-running cvd groups in
about 0.1s, so shipping a worker fix does not reboot a device.

### What this does not do

Auto-deploy on green. It was considered and declined: the value of a manual step is that somebody
decides *when* the farm changes underneath a running session. Rollback needs no plan because images
are immutable and tagged by commit — but **migrations do not roll back**, so moving code back past a
migration it depends on is a decision, not a command.

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

### Reaper knobs worth knowing

| variable | default | what it decides |
|---|---|---|
| `REAPER_INTERVAL_MS` | 30000 | how often sessions expire, queued sessions promote, and keys are purged |
| `HOST_SILENCE_TIMEOUT_MS` | 90000 | how long a host may go silent before its devices are QUARANTINED out of the pool |
| `HOST_SWEEP_MIN_INTERVAL_MS` | 15000 | floor on how often that host sweep runs, regardless of the reaper's tick |
| `APP_STORE_DIR` | *(required in production)* | where uploaded APKs live |
| `APP_MAX_UPLOAD_BYTES` | 536870912 | largest APK accepted, enforced on the stream |

A quarantined host recovers by **re-registering** — the worker coming back is the fleet's only
evidence that its devices are healthy again. Nothing else clears it, so a host stuck QUARANTINED
with a live worker means the worker is not managing to register, and that is the thing to look at.

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
- **The app library's blobs are not backed up.** `mfarm_appstore` holds every uploaded APK and the
  6-hourly sidecar dumps Postgres only. That is deliberate — hundreds of megabytes of build
  artifacts would trade a small, fast, verifiable backup for a large slow one — but it means losing
  that volume loses every upload, and the `app_builds` rows survive pointing at bytes that are gone.
  The first symptom is `install failed: Blob … is missing from the app store`. Uploads are
  reproducible from CI, which is why this is a gap and not a defect; re-upload rather than hunt.
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

**Unless you have deliberately published the console** — see [Publishing it on the
internet](#publishing-it-on-the-internet) below, in which case exactly two lines are expected and
everything else still is not:

```bash
sudo ss -tlnp | grep -vE '127\.0\.0\.1|::1|100\.|:(80|443) .*caddy' \
  && echo "^ PUBLICLY BOUND — fix before continuing"
```

The reason to keep a check rather than drop one that now "fails": the finding this catches is a
service someone adds later, and a check that is expected to print something is a check nobody reads.
Two known lines, named, and anything else is still a finding.

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

## Publishing it on the internet

Everything above assumes the tailnet. That rules out everyone outside it — including a teammate on a
phone hotspot, which is the case this section exists for. Skip it entirely if `tailscale serve` is
enough; it is the cheaper and stricter answer.

Run `deploy/setup-ingress.sh` on the box. It installs Caddy, writes a Caddyfile with one upstream,
and gets a real Let's Encrypt certificate.

```bash
HOSTNAME_PUBLIC=farm.example.com ./deploy/setup-ingress.sh
```

Without a domain it defaults to an `sslip.io` name — `34-100-159-34.sslip.io` resolves to
`34.100.159.34` by construction, so the HTTP-01 challenge succeeds with no DNS to configure. When a
real domain arrives it is one A record and one line in the Caddyfile; the certificate story does not
change.

### Two settings that are not optional here

The API keeps its loopback bind and Caddy is the only public listener, which means the API now sees
every request arriving from the proxy over plain HTTP. Two things follow, and **both must be set in
`deploy/.env` before publishing**:

```bash
SESSION_COOKIE_SECURE=1     # the browser is on TLS even though this process is not
TRUST_PROXY=1               # take the client address from X-Forwarded-For
```

`TRUST_PROXY` is the one that is easy to skip, because nothing breaks visibly without it. The rate
limiter keys anonymous traffic on `req.ip`, and behind a proxy that is the proxy for everyone —
on this deployment, the docker bridge gateway. Every stranger on the internet then shares one bucket,
and one of them exhausting it locks every real user out of `/v1/auth/login`. Sign-in has a second,
much tighter per-address budget of its own (`routes/auth.ts`), which is likewise one global budget
until this flag is on.

Set it **only** when a proxy you control is genuinely the only way in. Turned on with the API
directly reachable, any caller can put whatever it likes in `X-Forwarded-For` and choose its own
limiter key, which is worse than having no limiter — it looks like one.

### What stays private, and why

Caddy proxies exactly one upstream. The console, the tenant API and the WebDriver hub are all served
by the API process, so one `reverse_proxy` covers the product; anything not on that process is not
published by adding it.

- **The metrics listener on `:9464` is deliberately not proxied.** Its gauges are fleet-wide and
  collected on the owner pool, so RLS does not hide them — publishing it would leak across tenants.
- **The worker's data plane and automation gateway stay on the docker bridge.** Unreachable from
  outside, which is also why there is still no live video (ADR-0005).
- **The WebDriver hub is now internet-facing.** It is built for that — Basic auth carries an API key
  and every proxied hop needs a signed grant — but it is worth knowing that it changed audience.

### Cuttlefish binds all interfaces, and only the firewall is stopping it

Worth knowing before publishing anything on this box. A running Cuttlefish instance leaves several
listeners on `0.0.0.0`, none of which are ours to move:

| Port | Process | What it is |
|------|---------|------------|
| 6520, 6521 | `socket_vsock_proxy` | **adb**, one per device — unauthenticated device control |
| 1080, 1443 | `operator` | the Cuttlefish web UI |
| 7200, 7201 | `gnss_grpc_proxy` | GNSS |
| 7500, 7501 | `netsimd` | radio simulation |

None of these are reachable from the internet on the lab box — verified below, not assumed — and the
only reason is the cloud firewall allowing exactly 22, 80 and 443. Nothing about the bind addresses
is protecting them. So: adding a permissive firewall rule, or moving this to a host without an
equivalent one, publishes adb to the internet. That is the same failure `tailscale funnel` is warned
about above, arrived at by a different route.

### Verify

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<your-host>/health     # 200
sudo ss -tlnp | grep -E ':(80|443) '                                     # caddy, and only caddy
sudo ss -tlnp | grep -E ':(9464|3000) '                                  # both still 127.0.0.1
```

Then from a machine that is **not** the box, because binding and reachability are different
questions and the table above is exactly why:

```bash
for p in 22 80 443 1080 1443 3000 5432 6520 6521 9464; do
  nc -z -G 4 -w 4 <your-host> $p 2>/dev/null && echo "OPEN $p" || echo "closed $p"
done
```

Only 22, 80 and 443 may come back OPEN. A `6520` in that list is unauthenticated adb on the public
internet; treat it as an incident, not a to-do.

Then check the API agrees about who is calling. Sign in from off the box and look at the log line:
`remoteAddress` should be your real address, not `172.18.0.1`. If it is the bridge address,
`TRUST_PROXY` did not take, and the limiter is a single shared bucket.

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
