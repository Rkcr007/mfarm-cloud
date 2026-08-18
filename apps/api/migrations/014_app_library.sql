-- 014: the app library — upload an APK once, install it onto a device you hold.
--
-- Phase 3's first bullet, and the first thing in this schema that stores a tenant's own BYTES
-- rather than facts about the fleet. Two tables, and the split is the whole design:
--
--   app_builds    an immutable, content-addressed artifact. Uploading the same file twice is the
--                 same row, because the identity of a build is its sha256 and nothing else.
--   app_installs  a JOB: put build X on the device session Y holds. Requested by the tenant,
--                 performed by the worker, and reported back exactly like a reset.
--
-- Why a job table rather than a synchronous call. The control plane cannot reach a worker — the
-- traffic only ever goes the other way, and that is deliberate (a worker sits behind a tailnet with
-- nothing listening). Resets already solved this in 2026-08-18: the heartbeat carries work down and
-- `POST /v1/workers/events` carries the confirmation up. Reusing that shape means an install
-- survives a worker restart, a partition, and a missed beat for free, and it costs one indexed read
-- per beat. The price is latency — up to one heartbeat interval (10s) before the install starts,
-- against an install that itself takes tens of seconds.
--
-- The bytes are NOT in this database. `sha256` is the storage key; the blob lives in the store
-- `APP_STORE_DIR` names (`apps/api/src/appstore.ts`). There is deliberately no `storage_key` column
-- to drift out of step with the digest, and a 200 MB APK in a bytea column would be read into the
-- API's heap on every download and dumped into every pg_dump the backup sidecar takes every 6h.

BEGIN;

-- ---------------------------------------------------------------- builds

CREATE TABLE app_builds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  platform      text NOT NULL DEFAULT 'android' CHECK (platform IN ('android','ios')),
  -- Parsed out of the binary AndroidManifest.xml at upload time, never accepted from the client:
  -- the package name decides which app a later `launch` or `uninstall` acts on, so a caller that
  -- can name it can act on an app it did not upload.
  package_name  text NOT NULL,
  version_name  text,
  version_code  bigint,
  -- NULL when the manifest gives a resource reference (`@string/app_name`) rather than a literal.
  -- Resolving it needs resources.arsc, which the parser deliberately does not read.
  label         text,
  min_sdk       integer,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  -- What the uploader called the file. Cosmetic, for the library UI; nothing resolves it to a path.
  filename      text,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Per ORG, not global. Two orgs uploading the same APK get one blob and two rows, because the row
-- is the org's claim on it — and deleting one org's row must never remove the other's app.
CREATE UNIQUE INDEX app_builds_org_sha_key ON app_builds(org_id, sha256);
-- The library view: every version of one package, newest first.
CREATE INDEX app_builds_org_package_idx ON app_builds(org_id, package_name, created_at DESC);

-- ---------------------------------------------------------------- installs

-- Three states, and there is no INSTALLING. A worker reports the OUTCOME, never the start, so a
-- worker that dies mid-install leaves the row PENDING and the next heartbeat re-delivers it. An
-- INSTALLING state would be a lie the moment that worker never comes back, and it would have to be
-- swept by something. `adb install -r` is repeatable, which is what makes re-delivery safe.
CREATE TYPE app_install_state AS ENUM ('PENDING', 'INSTALLED', 'FAILED');

CREATE TABLE app_installs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_id       uuid NOT NULL REFERENCES app_builds(id) ON DELETE CASCADE,
  -- The session is the tenant's PROOF that it holds this device, and the only reason this job is
  -- authorised. It also gives the install an owner in the history: "who put that build on cf-2".
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- Copied from the session at request time. Delivery re-checks it against devices.fence, so an
  -- install requested just before a device was reclaimed is never performed for the next tenant —
  -- the same defence the session token carries, applied to a job that outlives the request.
  fence        bigint NOT NULL,
  state        app_install_state NOT NULL DEFAULT 'PENDING',
  -- Populated on FAILED only. This is what the person who clicked "install" actually reads, so it
  -- carries adb's own words rather than a category.
  error        text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- The heartbeat's query: pending work for the devices of one host, oldest first.
CREATE INDEX app_installs_pending_idx ON app_installs(device_id, requested_at)
  WHERE state = 'PENDING';
CREATE INDEX app_installs_session_idx ON app_installs(session_id, requested_at DESC);

-- ---------------------------------------------------------------- RLS

ALTER TABLE app_builds   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_builds   FORCE  ROW LEVEL SECURITY;
ALTER TABLE app_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_installs FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_builds_own_org ON app_builds
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- Reads and the INSERT are the tenant's; the state transitions are not. A tenant must not be able
-- to mark its own install INSTALLED — only the worker that ran it may, through the owner pool with
-- its host id in the WHERE clause (migration 008's rule, applied here without a definer function
-- because the fleet side of this carries no tenant scope to get wrong).
CREATE POLICY app_installs_read ON app_installs
  FOR SELECT USING (org_id = current_org());
CREATE POLICY app_installs_request ON app_installs
  FOR INSERT WITH CHECK (org_id = current_org());

-- ---------------------------------------------------------------- grants
--
-- REVOKE FIRST, and this is not defensive noise. 001 ends with
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mfarm_app`, so
-- every table created by the owner from then on arrives with the full set ALREADY GRANTED. Writing
-- only the GRANT below would therefore leave mfarm_app able to UPDATE an install row — i.e. a
-- tenant could mark its own install INSTALLED, or rewrite the error a failed one reported. Same
-- shape as the PUBLIC EXECUTE default that migration 012 had to undo.
REVOKE ALL ON app_builds, app_installs FROM mfarm_app;
GRANT SELECT, INSERT ON app_builds   TO mfarm_app;
GRANT SELECT, INSERT ON app_installs TO mfarm_app;

COMMIT;
