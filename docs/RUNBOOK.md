# Runbook — start it, ship to it, stop it

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
starts itself, brings up both Cuttlefish devices, starts an Appium per device, and registers with the
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

You are waiting for `"available":2`.

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
