#!/usr/bin/env bash
#
# Is the farm actually up? Run from your laptop, after ./deploy/farm-online.sh.
#
#   ./deploy/farm-check.sh
#
# A thin wrapper: the real checks live in deploy/verify-live.sh and run ON the control plane, because
# half of what matters is only visible from there — the API on loopback, the fleet as the control
# plane sees it, and whether Caddy can actually reach the worker over the VPC.
#
# It waits for the devices rather than reporting a false negative. Two Cuttlefish instances cold boot
# after a host start; a check that answers "0 devices" thirty seconds in says the farm is broken when
# it is merely still starting.
set -uo pipefail

PROJECT="${MFARM_PROJECT:-mfarm-lab}"
ZONE="${MFARM_ZONE:-asia-south1-c}"
SSH_USER="${MFARM_SSH_USER:-rkcr070707}"
CP="${MFARM_CP:-mfarm-cp}"
WAIT="${DEVICE_WAIT_SECONDS:-600}"

gcloud compute ssh "$SSH_USER@$CP" --project "$PROJECT" --zone "$ZONE" \
  --command "cd ~/mfarm && DEVICE_WAIT_SECONDS=$WAIT bash deploy/verify-live.sh" 2>/dev/null
