# From a closed laptop to a device you can tap

Everything, in order, with what each step actually proves. Written for the person who has not
touched this in a fortnight and does not want to reconstruct it.

The farm lives on two Google Cloud VMs and is **stopped between sessions**. Nothing here needs the
repo except step 2 onwards, and nothing needs a decision except step 6.

---

## 0. What you are starting

| Machine | What it is | Cost while running |
|---|---|---|
| `mfarm-cp` | control plane: Postgres, the API, the console, Caddy (TLS) | ~₹3/hour |
| `mfarm-lab` | device host: two Cuttlefish Android 17 devices, Appium, the worker, coturn | **~₹65/hour** |

The device host is ~95% of the bill, which is why both are stopped when idle. Stopped VMs still bill
for their disks (~₹42/day); only deleting the disks stops that, and doing so throws away the farm.

---

## 1. Open the laptop

Two things must be true before anything else works. Both fail with confusing errors if skipped.

```bash
# The gcloud SSH key is passphrase-protected. Without this, every step below prompts you mid-command.
ssh-add ~/.ssh/google_compute_engine

# You should be pointed at the right project.
gcloud config get-value project        # expect: mfarm-lab
```

If `ssh-add` says the key is not found, the key is created on first `gcloud compute ssh` — run step 3
and it will make one.

---

## 2. Get the code

```bash
cd ~/Downloads/MFARM_CLOUD
git checkout main && git pull
```

You do not need the code to *run* the farm — both boxes have their own checkout — but you need it for
the two scripts in step 3.

---

## 3. Bring the farm online — one command

```bash
./deploy/farm-online.sh
```

This starts both machines and waits for SSH on each. Everything on them restarts itself: docker with
`unless-stopped` on the control plane, and systemd units for the worker, Caddy and coturn.

**It also does the one thing that is not self-healing.** The device host's public IP is *ephemeral*
and changes on every stop/start, while coturn advertises that address to browsers and the control
plane hands out `turn:<that address>` in every session's ICE block. After a restart both point at an
address that now belongs to someone else — and it fails in the worst possible way: the console works,
the device list is right, sessions start, and **video simply never arrives**, with an empty relay log
because nobody ever called it. The script detects the change and rewrites both ends.

> Reserving a static IP for the device host (~₹250/month, as the console already has) would delete
> that reconcile entirely. Worth doing if this stop/start becomes routine.

Takes about two minutes. The devices are still booting when it returns.

---

## 4. Check it is actually up — one command

```bash
./deploy/farm-check.sh
```

It waits up to ten minutes, because two Cuttlefish devices cold boot after a host start and a check
that answers "0 devices" thirty seconds in would say the farm is broken when it is merely starting.

```
Control plane
  ✓ API answering on http://127.0.0.1:3000
  ✓ running commit f57eae7
  ✓ public HTTPS reachable at https://34-100-138-213.sslip.io
  ✓ /dp reaches the device host's data plane (426 = websocket only)

Fleet
  ✓ 2 devices READY
  ✓ devices declare screen-stream (live view available)

Media relay
  ✓ coturn answering on 8.231.85.232:3478/tcp

Farm is live.
```

Every line is an answer from the running system rather than from a service manager. Two are worth
understanding, because they are the ones that catch real breakage:

- **`/dp` returning 426** is the data plane's own "websocket only" reply. It is the only proof that
  Caddy actually reaches the worker across the VPC — without it the console loads perfectly and the
  live view has no route.
- **`screen-stream` in the capability list** is the device telling the control plane it can produce
  video. If it is absent, the console will correctly offer no live view rather than a black rectangle.

---

## 5. Open the console

**https://34-100-138-213.sslip.io** — sign in with the account created by `farm-up.sh`:

```bash
# if you need to look the password up again
gcloud compute ssh rkcr070707@mfarm-cp --project mfarm-lab --zone asia-south1-c \
  --command 'cat ~/mfarm/deploy/.state/console_password'
```

The header shows the running commit. That is not decoration: it is how you tell whether the fix you
just deployed is the code answering you, without reading a log on the box.

---

## 6. Use a device

**Launch** (`G L`) → pick a build and a device profile → **Start**.

The bring-up screen is a checklist derived entirely from real state — a session row, an app-action
row, and the data-plane socket. Nothing on it is on a timer, which is why a step can sit spinning on
a cold device and why that is the truth rather than a stall.

Then the cockpit: the device fills the panel, the toolbar on the left is power / volume / rotate /
back / home / overview / screenshot / reconnect / zoom, and you can click and type straight onto the
screen. Logcat is below it; screenshots collect in the right-hand panel.

**The one decision.** `CF_RESET_MODE` on the device host chooses how devices are recycled between
sessions, and the two options are genuinely exclusive:

| Mode | Recycle between sessions | Live view |
|---|---|---|
| `snapshot` | ~10s | **none** — a restored Cuttlefish publishes no display |
| `powerwash` | ~40–80s | works, ~50 fps |

It is set to `powerwash` (`~/mfarm/deploy/.state/worker.env` on `mfarm-lab`). Change it there and
`sudo systemctl restart mfarm-worker` if you ever want the fast recycle instead.

---

## 7. Put it away

```bash
gcloud compute instances stop mfarm-lab mfarm-cp --project mfarm-lab --zone asia-south1-c
```

Release any held session in the console first, so no device is left mid-reset. Nothing else is
needed: the disks, the snapshots and the console's reserved IP all survive.

---

## When something is wrong

| Symptom | Look here first |
|---|---|
| Console loads, **no video**, everything else fine | `CF_RESET_MODE` on the device host. A snapshot-restored device has no display. This is the single most likely cause. |
| Video worked yesterday, not today | The device host's IP moved. Re-run `./deploy/farm-online.sh`, which reconciles it. |
| `0 devices READY` after ten minutes | `journalctl -u mfarm-worker -f` on `mfarm-lab`. A device that cannot reset is deliberately not schedulable. |
| Login does nothing | The session cookie needs a secure context. Over the public HTTPS name it is fine; over a plain-HTTP address the browser silently refuses it. |
| A deploy "worked" but the console is unchanged | `docker compose up -d api` reverts to the `:latest` image. Only `deploy/mfarm-deploy.sh <sha>` deploys a commit, and it verifies the running sha afterwards. |

## Shipping a change while the farm is up

```bash
git push origin main                      # CI + Release build ghcr.io/rkcr007/mfarm-api:<sha>
gcloud compute ssh rkcr070707@mfarm-cp --project mfarm-lab --zone asia-south1-c \
  --command 'cd ~/mfarm && git pull && bash deploy/mfarm-deploy.sh HEAD'
```

`mfarm-deploy.sh` pulls the image CI built, runs migrations, restarts only the API, and then **asks
the running process which commit it is** — every deployment mechanism that has bitten this project
bit it by succeeding quietly while changing nothing. The console header shows the same sha, so
"is my fix live?" is a browser refresh.

Worker changes need `sudo systemctl restart mfarm-worker` on `mfarm-lab` instead; the agent is not
containerised.

Deeper detail lives in `HANDOFF.md` (state of play and every known issue), `docs/adrs/` (why things
are the way they are), and `deploy/README.md` (what the scripts do the long way).
