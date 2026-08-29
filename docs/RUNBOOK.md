# Runbook — start it, ship to it, stop it

> **Just want it running?** `docs/START_HERE.md` is the seven-step path from a closed laptop to a
> device you can tap. This file is the reference underneath it.

Two machines (ADR-0006). The **control plane** stays on; the **device host** is the expensive half
and is off unless someone is using devices.

| | machine | what it runs | cost while running | cost while stopped |
|---|---|---|---|---|
| `mfarm-cp` | e2-medium | Postgres, API, console, Caddy, backups | ~₹3/hour (~₹2,300/mo) | ~₹250/mo (disk) |
| `mfarm-lab` | n2-standard-16 | Cuttlefish, Appium, worker agent | **~₹65/hour** | ~₹1,260/mo (150 GB disk) |

Everything below assumes `gcloud` is authenticated and `--project mfarm-lab --zone asia-south1-c`,
which is why every command carries them.

## The console is already up

**https://34-100-138-213.sslip.io** — user `admin@mfarm.local`, password in
`~/mfarm/deploy/.state/console_password` on `mfarm-cp`. The address is reserved and the certificate
survives restarts, so this URL does not change.

With the device host off you get a working console with an empty fleet. That is the point of the
split: the thing you look at is not the thing that costs ₹65/hour.

## Bring the devices up (~6 minutes, one command)

```bash
gcloud compute instances start mfarm-lab --project mfarm-lab --zone asia-south1-c
```

That is genuinely all. The worker is a systemd unit (`mfarm-worker.service`, enabled), so on boot it
starts itself, brings up every Cuttlefish device, starts an Appium per device, and registers with the
control plane over its public URL.

**Budget the time.** A host boot discards the device snapshots baked into the disk (known issue 24),
so each device cold boots (~38s) and then re-snapshots (~4 GB). First fleet-ready is typically 5–8
minutes, not seconds.

Watch it arrive, either in the console's Devices tab or from a terminal:

```bash
# the fleet, as the control plane sees it
gcloud compute ssh rkcr070707@mfarm-cp --project mfarm-lab --zone asia-south1-c \
  --command 'curl -s -H "Authorization: Bearer $(cat ~/mfarm/deploy/.state/api_key)" \
              http://127.0.0.1:3000/v1/devices'

# what the worker is doing, live
gcloud compute ssh rkcr070707@mfarm-lab --project mfarm-lab --zone asia-south1-c \
  --command 'journalctl -u mfarm-worker -f'
```

You are waiting for `"available":4` — see the next section for what those four are.

## The four devices, and which two you must not touch

| | model | panel | dp width | profile |
|---|---|---|---|---|
| `cf-1`, `cf-2` | `cuttlefish` | 720×1280 @ 320 | 360dp | none |
| `cf-3` | MFARM X1 Pro | 1080×2340 @ 450 | 384dp | `mfarm-x1-pro` |
| `cf-4` | MFARM X1 | 1080×2340 @ 480 | 360dp | `mfarm-x1` |

`cf-3` and `cf-4` are configured with a panel, density, RAM and cores (ADR-0017). Everything a
profile sets is a cold-boot flag and true of the device; nothing is written into the guest. The two
differ in **density, not pixels** — 384dp against 360dp — because dp is what a layout bug is
expressed in.

`cf-1` and `cf-2` are deliberately left exactly as they were: they work, the render baseline was
measured on them, and they are the fallback if a profiled device misbehaves.

Which device gets which profile is `CF_PROFILES` in `/etc/mfarm/worker.env`, keyed by local id:

```
CF_INSTANCES=4
CF_PROFILES=cf-3=mfarm-x1-pro,cf-4=mfarm-x1
```

A local id absent from that list gets no profile, and an unprofiled device takes byte-identical cvd
arguments to the ones it took before profiles existed. An unknown profile id fails the agent at
startup rather than quietly booting a default.

### NEVER `cvd reset` to change a profile

A profile applies on **cold boot only** — `restoreSnapshot` and `restartExisting` pass no
device-configuration flags, because configuration comes back out of cvd's instance database. So
editing `profiles.ts` does nothing to a device that already exists.

The device has to be created again, and the way to do that is a **new instance group**
(`cvd create --instance_nums=<n>`), which sits alongside the running ones. `cvd reset` tears down
**every device on the host**, including `cf-1` and `cf-2`.

### A profile writes nothing into the guest

Everything a profile does is a **cold-boot flag** — panel, density, RAM, cores. There is no
per-device setup step and no property to apply, so a device that boots is already correct and a
snapshot taken at any point stays correct.

This is deliberate (ADR-0017). Until 2026-08-29 profiled devices also wrote Samsung build properties
into the guest, and those lived in an `adb remount` overlay that `CF_RESET_MODE=powerwash` wipes —
so they had to be rewritten after **every reset**, at the cost of two extra reboots. Reset went from
~40s to ~100s on those devices. Both the properties and the cost are gone.

**The rule, if you are ever tempted to add guest state to a profile:** it must be a boot flag. A
guest edit does not survive a powerwash, and this farm resets by powerwash.

### Never stop the worker to get at `cvd`

`systemctl stop mfarm-worker` **takes every Cuttlefish instance down with it** — the worker owns the
device lifecycle, and the instances do not outlive it. So the sequence "stop the worker, run a `cvd`
command by hand, start it again" does not work: by the time the worker is stopped there is nothing
to run the command against, and `cvd powerwash` fails with

```
Failed to connect to instance monitor socket (/tmp/cf_avd_1001/cvd-3/launcher_monitor.sock)
```

Everything comes back on `systemctl start` (~30s per device, sequentially), so this costs time rather
than data — but there is no reason to pay it. **Reset a device through the product**: allocate a
session and use *Release & reset*, which is the same powerwash the worker would run, with the
control plane kept in step.

Two more things that only bite from a shell:

- `cvd` must run **as the user that owns the host config** (`sudo -u <owner> -H bash -lc 'cvd …'`).
  As anyone else it fails with `Run 'cvd setup' to configure the host`.
- `cvd fleet` on 1.55.1 frequently dies with `Failed to parse XML memory` from its own gflags
  parser. It is not a sign the fleet is unhealthy — `adb devices` and the worker's log are the
  reliable readouts.

### Stale guest properties clear on the first reset, not on restart

If a farm ran the pre-ADR-0017 build, its profiled devices still have Samsung build properties in the
guest overlay. **A restart does not clear them; only a powerwash does.** So immediately after
upgrading, the console correctly says *MFARM X1 Pro* while the guest still answers
`ro.product.model = SM-S938B` — and an app under test still branches on it.

It is self-healing: the first *Release & reset* on each profiled device wipes the overlay and the
device reverts to the image's own `Cuttlefish x86_64 phone 64-bit only`. To do it deliberately,
allocate a session on each profiled device and release it with reset. Devices cannot be pinned by the
allocator, so the practical move is to allocate every device at once and then release them all.

### `CF_PROFILES` after the rename

The profile ids are `mfarm-x1-pro` and `mfarm-x1`:

```
CF_PROFILES=cf-3=mfarm-x1-pro,cf-4=mfarm-x1
```

A unit file still naming `galaxy-s25-ultra` **fails the agent at startup**, by design — the
alternative is a device booting unprofiled at 720×1280 while the console shows it as an X1 Pro.
Fix `deploy/.state/worker.env` and restart the service.

## Put it away (cost, not a teardown)

```bash
# the expensive half. Do this whenever you stop using devices.
gcloud compute instances stop mfarm-lab --project mfarm-lab --zone asia-south1-c
```

Nothing is lost: the image, the Android system image, Appium and the agent all live on the disk.
Only the ~₹65/hour stops.

**The console stays up.** If you want it down too — saving roughly ₹2,000/month and giving up the
always-on URL — stop the control plane as well:

```bash
gcloud compute instances stop mfarm-cp --project mfarm-lab --zone asia-south1-c   # optional
gcloud compute instances start mfarm-cp --project mfarm-lab --zone asia-south1-c  # ~60s to return
```

The control plane comes back on its own: containers carry `restart: unless-stopped`, the reserved
address and certificate survive, and the reaper's boot-time quarantine now clears itself on the
worker's first heartbeat (migration 016).

**Do not** delete the device host's disk to save the ₹1,260/month. It carries the Cuttlefish build,
the Android image and hours of setup; rebuilding is most of a day. The two GCP snapshots
(`mfarm-cf-ready`, `mfarm-farm-ready`) exist for a catastrophe, not for routine thrift.

## Ship a change

```bash
git push origin main            # CI runs; on green, Release publishes ghcr.io/rkcr007/mfarm-api:<sha>
gh run list --limit 3           # watch it
```

Then, on the control plane:

```bash
gcloud compute ssh rkcr070707@mfarm-cp --project mfarm-lab --zone asia-south1-c \
  --command 'cd ~/mfarm && git pull -q && ./deploy/mfarm-deploy.sh <sha>'
```

Short shas, branch names and `HEAD` all work — the script resolves them through git before it asks
the registry. It migrates, restarts **only** the API, and then asks the running process what commit
it is; a deploy that cannot confirm its own sha fails rather than reporting success.

**Confirm it landed without asking anyone**: reload the console. The header shows the running commit,
and hovering gives the full sha, CI's build time, process start and schema version.

Worker-side changes are their own step, and cheap — the agent adopts running cvd groups in ~0.1s, so
this does not reboot a device:

```bash
gcloud compute ssh rkcr070707@mfarm-lab --project mfarm-lab --zone asia-south1-c \
  --command 'cd ~/mfarm && git pull -q && sudo systemctl restart mfarm-worker'
```

Rollback is the same deploy command with an older sha, because images are immutable and tagged by
commit. **Migrations do not roll back** — moving code back past one it depends on is a decision, not
a command.

## When something looks wrong

```bash
# is the API serving, and what is it?
curl -s https://34-100-138-213.sslip.io/health

# the control plane's logs
gcloud compute ssh rkcr070707@mfarm-cp --project mfarm-lab --zone asia-south1-c \
  --command 'docker logs --tail 50 mfarm-api-1'

# the worker's logs (device host must be running)
gcloud compute ssh rkcr070707@mfarm-lab --project mfarm-lab --zone asia-south1-c \
  --command 'journalctl -u mfarm-worker -n 100 --no-pager'

# a full WebDriver session against a real device, end to end
gcloud compute ssh rkcr070707@mfarm-cp --project mfarm-lab --zone asia-south1-c \
  --command 'cd ~/mfarm && MFARM_API_KEY=$(cat deploy/.state/api_key) REGION=lab \
             node deploy/verify-webdriver.mjs'
```

**The console is unreachable but the box is up** — check the `mfarm-web` firewall tag is on
`mfarm-cp`. It follows the tag, not the address, so moving the IP without moving the tag produces a
console that answers on loopback and times out from the internet.

**The fleet says `available: 0` with devices clearly running** — read known issues 25 and 27. Since
migration 016 this self-heals on the next heartbeat; if it does not, the host is quarantined by an
operator rather than by the reaper, and only a human lifts that.

**A deploy fell back to building locally** — the box lost its registry credential. On that host:
`docker login ghcr.io -u rkcr007` with a `read:packages` token.

## Bringing the farm back after a stop — two commands

Both VMs are stopped between sessions; the device host is ~95% of the cost. Everything on them
restarts itself (docker `unless-stopped`, systemd for the worker, Caddy and coturn), so this is
genuinely two commands:

```bash
./deploy/farm-online.sh     # start both machines, and re-point the media relay
./deploy/farm-check.sh      # wait for the devices, then report what is actually live
```

**Why the first one is a script rather than `gcloud compute instances start`.** The device host's
public IP is EPHEMERAL and changes on every stop/start, while coturn advertises it to browsers and
the control plane hands out `turn:<that address>` in every session's ICE block. After a restart both
point at an address that now belongs to somebody else, and the failure is silent in the worst way:
the console works, the device list is right, sessions start, and video never arrives — with an empty
relay log, because nobody ever called it. `farm-online.sh` detects the change and rewrites both ends.

The console's own address is reserved (`mfarm-lab-ip`, 34.100.138.213), so its URL and its Let's
Encrypt certificate survive a stop. Reserving one for the device host too (~₹250/month) would make
that reconcile unnecessary, and is worth it if this becomes routine.

`farm-check.sh` waits up to ten minutes, because two Cuttlefish devices cold boot after a host start.
It reports the running commit, the fleet as the CONTROL PLANE sees it, whether `/dp` reaches the
worker (a 426 is the proof), and whether the relay answers.

