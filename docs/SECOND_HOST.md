# Adding a second device host

**A host outage is a farm outage.** ADR-0027 and migration 038 reduce what one costs; they do not
remove it. This is the page for removing it.

**Nothing in this repo needs to change to run a second host.** That was audited in
`EXECUTION_ROADMAP.md` S7.2 and re-checked when this page was written: the allocator, the queue, the
reaper, the WebDriver hub, the metrics and the console are all per-host already, and `/dp/*` on the
deployed farm relays through the API rather than naming one worker. What *did* assume a single host
was the tooling in `deploy/`, and that is fixed — see §5.

> **This costs money.** A second `n2-standard-16` is another **~₹65/hour while running** and
> **~₹1,260/month in disk even stopped**. Nothing below is reversible for free: deleting the disk is
> what stops the standing charge, and deleting the disk throws that host's devices away.

---

## 1. What you actually get

| | one host | two hosts |
|---|---|---|
| a host dies | **the farm is down** | half capacity, sessions on the survivor keep running |
| a host reboots for kernel updates | every device goes | drain one, patch it, drain the other |
| four devices busy | the fifth caller queues | the fifth caller gets a device on the other host |

What you do **not** get is redundancy for the control plane. `mfarm-cp` is still one VM and one API
process, and `STATUS.md` §4 is honest about that being unaddressed and deliberately so.

---

## 2. Before you start

You need, from the **existing** control plane:

```bash
# The registration token the new worker will present. It is the SAME token — it authenticates
# "a machine allowed to join this farm", not a particular machine.
gcloud compute ssh mfarm-cp --zone asia-south1-c \
  --command 'sudo cat ~/mfarm/deploy/secrets/worker_registration_token'
```

Copy it exactly, with no trailing newline — see §4b.

**The region matters more than it looks.** A device is allocated by region, platform, tier,
capabilities and org — never by host — so a second host **in the same region** is transparent extra
capacity, and a second host in a *new* region is a new pool that nothing will schedule onto until a
suite asks for it by name. Use the same region unless you specifically want a second pool.

---

## 3. Create the VM

```bash
gcloud compute instances create mfarm-lab-2 \
  --project mfarm-lab --zone asia-south1-c \
  --machine-type n2-standard-16 \
  --enable-nested-virtualization \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --boot-disk-size 200GB --boot-disk-type pd-balanced
```

**`--enable-nested-virtualization` is not optional and is not fixable later without recreating the
instance.** Cuttlefish needs KVM; without it `cvd start` fails in a way that reads like a Cuttlefish
problem rather than a VM one.

**No reserved address, and it needs none.** The relay (`coturn`, `turn.mfarm.dev`) stays on the
first device host: a browser watching a device on host 2 relays through host 1's coturn perfectly
well, because TURN is a relay and not a device service. That is why `farm-online.sh` checks only the
**relay host** against `MFARM_TURN_HOST` — see §5.

---

## 4. Bring it up

Everything below runs **on the new box**.

> **`farm-up.sh` IS NOT THE COMMAND HERE, and this page said it was until the scripts were read.**
> It stands up a control plane — secrets, Postgres, the API image, the seed, a console user — before
> it ever looks for `/dev/kvm`. Running it on a second device host gives you a **second control
> plane** with its own empty database beside the real one. The device host's path is the three
> scripts below, which is what `farm-up.sh`'s own comment says: *"the device host runs
> `deploy/install-worker-service.sh` instead, which needs `CONTROL_PLANE_URL`."*

### 4a. Cuttlefish itself

```bash
git clone https://github.com/Rkcr007/mfarm-cloud.git ~/mfarm && cd ~/mfarm
npm install

./spikes/bootstrap_cuttlefish.sh     # run, reboot when it says to, run again
./deploy/install-build-tools.sh      # a JDK and Android Build Tools
```

**`install-build-tools.sh` is not optional even though the farm appears to work without it.** The
first host ran real WebDriver sessions for days before anybody noticed: a session naming an
already-installed package needs neither tool, and the moment a suite ships its own APK the driver
fails with `Could not find 'aapt2'` several hops from the cause.

### 4b. The registration token

`install-worker-service.sh` reads it from a **file**, not the environment, and refuses to run
without one:

```bash
mkdir -p ~/mfarm/deploy/secrets && chmod 700 ~/mfarm/deploy/secrets
printf '%s' '<the token from §2>' > ~/mfarm/deploy/secrets/worker_registration_token
chmod 600 ~/mfarm/deploy/secrets/worker_registration_token
```

`printf` rather than `echo`, because a trailing newline in that file is a token the control plane
does not recognise — and the failure is a 401 on registration, which reads like a wrong token
rather than a whitespace one.

### 4c. The worker and the boot unit

```bash
CONTROL_PLANE_URL=https://farm.mfarm.dev \
REGION=lab \
CF_INSTANCES=4 \
  ./deploy/install-worker-service.sh

sudo -v && ./deploy/install-farm-service.sh
sudo systemctl enable mfarm-farm.service
```

**`REGION` is the variable, not `MFARM_REGION`** — and it defaults to `lab`, which is the first
host's region. A device is allocated by region and never by host, so leaving the default is what
makes the new host transparent extra capacity. Set it to something else only if you want a second
pool that nothing schedules onto until a suite asks for it by name.

**`CF_PROFILES` decides which devices look like which hardware** (ADR-0016) and defaults to
`cf-3=mfarm-x1-pro,cf-4=mfarm-x1`. Leaving the default means the new host offers the same device
classes as the first, which is what you want for capacity; naming different ones gives you a host
that only serves certain classes, which is almost never what you want.

**`install-farm-service.sh` is the step people skip**, and the symptom arrives a week later: the
host reboots, the devices do not come back, and the console shows a host that beats with no devices
on it. Installing it **from the repo** rather than editing it on the box is D20: the unit existed
only on the VM and had drifted to declaring `CF_INSTANCES=2` on a host running four.

## 5. Tell your laptop there are two

The scripts take a **list**. `MFARM_LAB` still names one, so nothing you already have stops working.

```bash
export MFARM_LABS="mfarm-lab mfarm-lab-2"

./deploy/farm-online.sh     # starts the control plane and BOTH device hosts
./deploy/farm-check.sh      # devices from both appear in the fleet count
./deploy/check-deployed.sh  # reports each host's checkout separately
```

Put it in your shell profile, or in `deploy/farm.env` if every operator should get it.

**Two things the scripts now distinguish, and both matter:**

- **`MFARM_RELAY_LAB`** — which device host publishes `MFARM_TURN_HOST`. Defaults to the first name
  in `MFARM_LABS`. Only that one is compared against the turn address, because a second host has no
  reserved address; comparing its ephemeral IP would report DRIFT on every start, which is the
  always-on warning that check was rewritten to stop being.
- **A host that cannot be described** is now reported as an error rather than as "stopped".
  `check-deployed.sh` used to treat any non-`RUNNING` status as stopped, and an empty status means
  *gcloud could not read the instance* — a typo in the list, or a VM that no longer exists. On a
  two-host farm that would silently drop a host from the report while printing something reassuring.

---

## 6. Check it actually joined

```bash
./deploy/farm-check.sh     # expect the combined device count, e.g. 8 READY
```

In the console, **Health → Machines** lists each host separately with its own disk, load, memory and
cost (ADR-0035, migration 050). Two hosts means two rows and two hourly charges — the cost display
is per host and does not sum, so read both.

**The specific thing worth confirming by hand**, because it is the one that fails quietly: open a
device *on the new host* in the cockpit and check the live view arrives. That exercises the path
this page claims needs no change — `/dp/<hostId>` relayed through the API, down the tunnel the new
agent dialled out — and it is the only claim here that a device count cannot verify.

---

## 7. Taking one out again

```bash
# Drain rather than stop: quarantining the host stops it being scheduled while letting
# sessions already on it finish.
#   (console: Health -> Machines -> the host -> Quarantine)

gcloud compute instances stop mfarm-lab-2 --project mfarm-lab --zone asia-south1-c
```

A stopped host stops beating; the reaper quarantines it after 90 seconds (migration 038) and the
allocator stops choosing it. Sessions that were on it fail — which is why draining first is worth
the extra minute.

**To stop paying for it entirely**, delete the instance *and its disk*. That throws away its
devices' snapshots, so the rebuild is §3 and §4 again from scratch.

---

## 8. What is still single

Said plainly, because a page about removing a single point of failure should not leave you believing
you removed all of them:

| | |
|---|---|
| **The control plane** | one VM, one API process. Rate limiting is in-memory and `TunnelRegistry` is per process — `EXECUTION_ROADMAP.md` S7.3 has the order in which that would have to be fixed. |
| **Postgres** | one instance on `mfarm-cp`, with backups (`deploy/backup.sh`) and a restore drill. |
| **The relay** | one coturn, on the relay host. If that host goes, the live view degrades to the direct path — which works on the same network and not across NAT. |
