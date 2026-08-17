-- 012: give the SECURITY DEFINER functions an owner that is not the superuser, and close the
-- PUBLIC EXECUTE grants that migration 008 stopped short of.
--
-- Two separate defects, both about the same sentence in HANDOFF.md: "Revoke EXECUTE from PUBLIC, or
-- the grant is not a control."
--
-- ---------------------------------------------------------------------------------------------
-- 1. THE OWNER IS THE SUPERUSER, SO EVERY DEFINER FUNCTION RUNS AS ONE.
--
-- SECURITY DEFINER executes with the privileges of the function's OWNER. All eight of ours were
-- owned by `mfarm`, the cluster superuser, because that is simply who ran the migration that
-- created them. So a bug in any one of them — a text parameter reaching dynamic SQL, a mistake in a
-- future edit — is not a bug bounded by what the allocator needs. It is superuser execution.
--
-- Nothing is known to be exploitable today. Every function already pins `SET search_path = public`,
-- which closes the classic hijack where a caller plants a same-named table or operator in a schema
-- searched earlier. This migration is about the blast radius when something else goes wrong, which
-- is the only time it will matter.
--
-- `mfarm_definer` is NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE and holds table privileges on
-- exactly the five tables the function bodies touch. It has BYPASSRLS, and that is deliberate: the
-- tenant tables are FORCE ROW LEVEL SECURITY, under which even the table owner obeys policies, and
-- these functions exist precisely to do the fleet-wide work that policies forbid. The trade is
-- explicit — the role can read and write those five tables regardless of org, which is what the
-- functions already did, and it can do nothing else at all. It cannot log in, create objects, read
-- files, or reach any other database.
--
-- ---------------------------------------------------------------------------------------------
-- 2. PUBLIC STILL HAD EXECUTE ON THE THREE TENANT-FACING FUNCTIONS.
--
-- 008 revoked PUBLIC from the fleet-wide five and stopped. `allocate_device`, `release_device` and
-- `session_activate` kept the grant Postgres hands out by default, so their explicit
-- `GRANT EXECUTE ... TO mfarm_app` was decorative — mfarm_app could already call them as PUBLIC.
--
-- Not an escalation today, because the only roles that exist are the owner and mfarm_app. It becomes
-- one silently, the first time anyone adds a role: a read-only reporting user, a metrics exporter,
-- an analytics login — each would arrive holding EXECUTE on the allocator. Including, if this
-- migration had not revoked first, `mfarm_definer` itself.
--
-- ci.yml asserts both properties from here on, because "we revoked it" is not a control either.

-- ---------------------------------------------------------------- the role

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfarm_definer') THEN
    CREATE ROLE mfarm_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  ELSE
    -- Idempotent, and re-asserted rather than assumed: a role that exists with the wrong flags is
    -- exactly the state a half-applied environment lands in.
    ALTER ROLE mfarm_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

COMMENT ON ROLE mfarm_definer IS
  'Owns the SECURITY DEFINER allocator functions so they do not execute as a superuser. NOLOGIN: '
  'reachable only by calling one of those functions. BYPASSRLS because the tenant tables are FORCE '
  'ROW LEVEL SECURITY and these functions do fleet-wide work by design.';

-- Exactly the tables the function bodies touch. `webdriver_sessions`, `api_keys`, `users`,
-- `memberships`, `idempotency_keys` and `regions` are deliberately absent — no definer function
-- reads or writes them, and a grant "just in case" is how a narrow role stops being narrow.
GRANT SELECT, INSERT, UPDATE, DELETE ON devices         TO mfarm_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON hosts           TO mfarm_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON metering_events TO mfarm_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions        TO mfarm_definer;
-- orgs needs more than SELECT, and the reason is easy to get wrong: `allocate_device` runs
--     SELECT max_concurrent INTO v_max FROM orgs WHERE id = p_org FOR UPDATE;
-- to serialise the concurrency-cap check against other allocations for the same org. It writes
-- nothing — but a row LOCK requires UPDATE privilege on at least one column, so SELECT alone fails
-- with "permission denied for table orgs". Found by the test suite, not by reading the grant list.
--
-- Column-scoped rather than table-wide, because "at least one column" is all Postgres asks for.
-- max_concurrent is the right column to expose: it is the value this lock exists to protect and the
-- one the function already reads. Names, slugs and every future column stay unwritable.
GRANT SELECT                          ON orgs           TO mfarm_definer;
GRANT UPDATE (max_concurrent)         ON orgs           TO mfarm_definer;

-- ---------------------------------------------------------------- close PUBLIC

REVOKE EXECUTE ON FUNCTION
  allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION release_device(uuid,uuid,text)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION session_activate(uuid,uuid,bigint)    FROM PUBLIC;

-- ---------------------------------------------------------------- move ownership
--
-- Ownership last. Doing it before the REVOKE above would leave a window where the functions run as
-- the new role while PUBLIC can still call them, and re-granting afterwards keeps the intended ACL
-- explicit rather than relying on what survives an owner change.

ALTER FUNCTION allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb) OWNER TO mfarm_definer;
ALTER FUNCTION release_device(uuid,uuid,text)                                 OWNER TO mfarm_definer;
ALTER FUNCTION session_activate(uuid,uuid,bigint)                             OWNER TO mfarm_definer;
ALTER FUNCTION device_reset_complete(uuid,uuid,bigint)                        OWNER TO mfarm_definer;
ALTER FUNCTION record_metering(uuid,uuid[],uuid[],uuid[],text[],numeric[],timestamptz[])
                                                                              OWNER TO mfarm_definer;
ALTER FUNCTION expire_sessions()                                              OWNER TO mfarm_definer;
ALTER FUNCTION promote_queued(integer)                                        OWNER TO mfarm_definer;
ALTER FUNCTION quarantine_host(uuid,text)                                     OWNER TO mfarm_definer;

-- ---------------------------------------------------------------- re-assert the intended ACL
--
-- The tenant-facing three, and only those three. The fleet-wide five stay callable by the owner
-- pool alone (a superuser bypasses privilege checks, so `withSystem` is unaffected) — 008 established
-- that split and ci.yml enforces it.

GRANT EXECUTE ON FUNCTION
  allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb) TO mfarm_app;
GRANT EXECUTE ON FUNCTION release_device(uuid,uuid,text)         TO mfarm_app;
GRANT EXECUTE ON FUNCTION session_activate(uuid,uuid,bigint)     TO mfarm_app;
