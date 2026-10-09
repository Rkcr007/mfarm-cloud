# ADR-0049 — SSH reaches the farm through IAP, and the device host holds no project credential

**Status:** Accepted · 2026-10-09 · amends ADR-0006 (what each machine may reach) · the tooling half
shipped with this ADR; the cloud half is four commands in `docs/RUNBOOK.md` that an operator runs

## Context

An audit of the live project on 2026-10-09 read the code, the GCP project and the production
database. Four things were true of the cloud that no screen in the product shows:

1. **The device host could read every database backup.** `mfarm-lab` ran as the Compute Engine
   default service account. That account holds `roles/editor` on the project and
   `roles/storage.objectViewer` on `mfarm-backups-…`, and the instance's scopes included
   `devstorage.read_only`. So any process on the device host could ask the metadata server for a
   token and download the dumps. The device host is the one machine that runs tenants' apps.
   Whether an app inside a Cuttlefish guest can reach `169.254.169.254` was **not tested** — the
   host was stopped — and nothing in this repository blocks it.
2. **Ports 22 and 3389 were open to the internet.** `default-allow-ssh` and `default-allow-rdp` are
   the default network's rules and had never been reviewed. Both machines run Ubuntu; nothing
   listens on 3389. Only `check-deployed.sh` used the IAP tunnel. `farm-online.sh`, `farm-check.sh`,
   `verify-failure.mjs` and every command in the docs dialled the public address.
3. **The control plane's disk had no snapshot.** The database is dumped every six hours and copied
   off the box, and that covers the database only. `deploy/.env`, `deploy/secrets`, Caddy's
   certificates and the app store volume exist on that one disk.
4. **`mfarm-cp` had no deletion protection.**

## Decision

1. **SSH reaches both machines through IAP, and only through IAP.** Every `gcloud compute ssh` in
   `deploy/` passes `--tunnel-through-iap`, and so does every command in the docs.
   `default-allow-ssh` admits Google's IAP range (`35.235.240.0/20`) and nothing else.
   `default-allow-rdp` is removed.
2. **The device host runs as its own service account.** `mfarm-lab@…` holds
   `roles/logging.logWriter` and `roles/monitoring.metricWriter`, with the scopes `logging-write`
   and `monitoring-write`. It has no storage scope and no binding on the backup bucket. A new
   device host is created with the same account (`docs/SECOND_HOST.md`).
3. **The control plane's disk has a snapshot.** It is taken by hand. Whether to schedule it is not
   decided here.
4. **`mfarm-cp` carries deletion protection.**

**This ADR does not claim the cloud half has been applied.** The four commands are in
`docs/RUNBOOK.md` under "Close what the cloud leaves open", each followed by the command that shows
whether it has been done. Ask the project, not this file.

## Consequences

- **A command that forgets the flag hangs.** gcloud tunnels on its own only for an instance with no
  external address, and both machines have one. Once the rule is narrowed, a bare
  `gcloud compute ssh` waits for SSH to time out and `farm-online.sh` would report a healthy host as
  one that "never answered SSH". `deploy/farm-online.test.mjs` asserts the flag on every call the
  script makes.
- **SSH depends on IAP.** A second operator needs `roles/iap.tunnelResourceAccessor`; the project
  owner has it already. If IAP is unavailable, widen `default-allow-ssh` from the cloud console and
  narrow it again afterwards.
- **The device host cannot read Cloud Storage.** Nothing on it does: `backup-offsite.sh` and
  `restore-drill.sh` run on the control plane, and the Cuttlefish fetch uses the public Android
  build API. A feature that later needs a bucket from the device host gets a binding on that one
  bucket.
- **Verified when this was written:** the tunnel works for `rkcr070707@mfarm-cp`, and
  `deploy/farm-check.sh` ran through it end to end. `mfarm-lab` was stopped, so the tunnel to it and
  its first boot under the new account are **unverified until its next start**.

**Not done here, on purpose:**

- The default service account still holds `roles/editor` and its binding on the backup bucket. Once
  the device host is moved, nothing runs as it. Removing both is a separate step.
- `mfarm-lab` still carries the `mfarm-turn` tag. ADR-0047 left that open and this does not close it.
- `default-allow-internal` still lets any machine in the project reach any other (ADR-0006).
- No snapshot schedule, and no refresh of the device host's snapshots, which date from August.

## Alternatives

- **Leave 22 open and rely on key-only authentication.** It holds until a key leaks or `sshd` has a
  bug. Closing the port costs one flag per command.
- **OS Login with two-factor.** More to set up and to explain to a second operator. IAP removes the
  open port, which is most of the benefit.
- **No service account on the device host at all.** Stricter by one step. It would also stop guest
  logs reaching Cloud Logging, and it would make the device host the odd one out next to
  `mfarm-cp`, which already runs as its own narrow account.
- **A snapshot schedule now.** It is a standing cost and a retention decision, and neither was
  asked for.
