-- Phase 1 control plane — core schema.
--
-- Two rules this schema exists to enforce structurally, because both are ruinous to retrofit:
--   1. every tenant-owned row carries org_id from row zero (v2 decision 1)
--   2. device allocation is atomic with session creation, and carries a fencing token (decisions 3, 5)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The application connects as this role for all tenant-facing work. It is deliberately NOT the table
-- owner and NOT a superuser, because:
--   - table owners bypass RLS unless FORCE is set (we set FORCE, but do not rely on it alone)
--   - SUPERUSERS BYPASS RLS UNCONDITIONALLY, FORCE or not, and no policy can stop them
-- Connecting as the migration/superuser role would therefore disable every policy in 002 silently.
-- Migrations run as the owner; request handling runs as mfarm_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfarm_app') THEN
    -- Local-dev password. Production must ALTER ROLE mfarm_app PASSWORD <secret from env/IAM>;
    -- it is here so `docker compose up && npm run migrate` is a single working step.
    CREATE ROLE mfarm_app LOGIN PASSWORD 'mfarm_app';
  END IF;
END $$;

-- ---------------------------------------------------------------- enums

CREATE TYPE device_state AS ENUM (
  'OFFLINE',        -- host has not reported it
  'BOOTING',        -- coming up from snapshot or cold
  'READY',          -- allocatable
  'RESERVED',       -- allocated, session not yet live
  'SESSION_ACTIVE', -- in use
  'CLEANING',       -- snapshot restore in progress (v2 decision 5: restore, not a cleanup script)
  'QUARANTINED',    -- failed health checks; drained, never scheduled (v2 decision 8)
  'EVICTED'         -- removed from the fleet
);

CREATE TYPE session_state AS ENUM (
  'QUEUED',      -- waiting for capacity; the state v1 skipped by assuming one session per device
  'ALLOCATING',
  'ACTIVE',
  'ENDING',
  'ENDED',
  'FAILED'
);

CREATE TYPE host_state AS ENUM ('UP', 'DRAINING', 'QUARANTINED', 'DOWN');

-- ---------------------------------------------------------------- tenancy

CREATE TABLE orgs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  -- per-org concurrency cap, enforced inside the allocator transaction
  max_concurrent     integer NOT NULL DEFAULT 4 CHECK (max_concurrent > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- lowercased by the application; a functional unique index keeps it case-insensitive without
  -- pulling in the citext extension
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE memberships (
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  prefix     text NOT NULL UNIQUE,     -- shown in UI, safe to log
  key_hash   text NOT NULL,            -- sha256 of the secret; never store the secret
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys(org_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- fleet

-- Region is a first-class scheduling dimension from day one (v2 lever L4). Latency is a placement
-- problem; retrofitting a region key into a live allocator is miserable.
CREATE TABLE regions (
  code text PRIMARY KEY,
  name text NOT NULL
);

-- The HOST is the unit of scheduling, not the device.
CREATE TABLE hosts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region            text NOT NULL REFERENCES regions(code),
  hostname          text NOT NULL UNIQUE,
  state             host_state NOT NULL DEFAULT 'DOWN',
  protocol_version  integer NOT NULL DEFAULT 0,
  capabilities      jsonb NOT NULL DEFAULT '[]'::jsonb,
  cores             integer,
  memory_mb         integer,
  last_heartbeat_at timestamptz,
  quarantined_at    timestamptz,
  quarantine_reason text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hosts_region_state_idx ON hosts(region, state);

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  -- NULL = shared fleet, visible to every org. Non-NULL = dedicated to one org.
  org_id        uuid REFERENCES orgs(id) ON DELETE SET NULL,
  region        text NOT NULL REFERENCES regions(code),
  platform      text NOT NULL CHECK (platform IN ('android','ios')),
  tier          text NOT NULL CHECK (tier IN ('cuttlefish','avd','container','simulator','physical')),
  model         text NOT NULL,
  os_version    text NOT NULL,
  state         device_state NOT NULL DEFAULT 'OFFLINE',
  -- Devices DECLARE what they support; the platform degrades gracefully (v2 decision 4).
  -- No uniform fat interface everyone has to fake.
  capabilities  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Monotonic fencing token. Incremented on every allocation. The worker rejects any command
  -- carrying a token older than the last one it saw, which is what makes a stale client
  -- reconnecting after a partition harmless.
  fence         bigint NOT NULL DEFAULT 0,
  last_reset_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The allocator's hot path. Partial index: only READY rows are ever candidates.
CREATE INDEX devices_allocatable_idx
  ON devices (region, platform, tier, org_id)
  WHERE state = 'READY';
CREATE INDEX devices_host_idx ON devices(host_id);

-- ---------------------------------------------------------------- sessions

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  state       session_state NOT NULL DEFAULT 'QUEUED',
  -- copy of devices.fence at allocation time; travels with every command to the worker
  fence       bigint,
  region      text NOT NULL REFERENCES regions(code),
  requested   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  expires_at  timestamptz,
  ended_at    timestamptz,
  end_reason  text
);

CREATE INDEX sessions_org_active_idx ON sessions(org_id)
  WHERE state IN ('QUEUED','ALLOCATING','ACTIVE');
CREATE INDEX sessions_expiry_idx ON sessions(expires_at)
  WHERE state IN ('ALLOCATING','ACTIVE');

-- At most one live session per device. This is a database-enforced invariant, not a convention:
-- if the allocator ever regresses, this constraint fails the transaction instead of silently
-- handing one device to two tenants.
CREATE UNIQUE INDEX sessions_one_live_per_device
  ON sessions(device_id)
  WHERE state IN ('ALLOCATING','ACTIVE');

-- ---------------------------------------------------------------- metering

-- Append-only, idempotent by event_id supplied by the worker (v2 decision 6). Reconstructing usage
-- later from session timestamps does not survive crashed sessions or queued time.
CREATE TABLE metering_events (
  event_id       uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  device_id      uuid REFERENCES devices(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('device_seconds','artifact_bytes','egress_bytes')),
  quantity       numeric(20,3) NOT NULL CHECK (quantity >= 0),
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metering_org_time_idx ON metering_events(org_id, occurred_at);
CREATE INDEX metering_session_idx  ON metering_events(session_id);

-- ---------------------------------------------------------------- grants

GRANT USAGE ON SCHEMA public TO mfarm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mfarm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mfarm_app;

COMMIT;
