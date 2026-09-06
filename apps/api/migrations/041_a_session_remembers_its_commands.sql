-- 041: a session remembers the commands that were run against it.
--
-- ---------------------------------------------------------------- what is missing, and why it matters
--
-- A failed run today shows: the test's name, the message the suite reported, and — after 040 — a
-- screenshot and a logcat taken up to ten seconds later. What it cannot show is the ONE thing every
-- commercial farm puts on that screen: the list of steps, with the failing one in red.
--
-- Not for want of a screen. There is no source. `test_results` has no steps, and the hub records
-- nothing about what it forwards:
--
--   > The hub does not model WebDriver commands and must not start: the automation server is the
--   > authority on what exists, and a hub that enumerates commands is a hub that breaks every time
--   > Appium adds one.                                    — `routes/webdriver.ts`, the command proxy
--
-- That rule is right and this migration does not break it. What BrowserStack and LambdaTest show as
-- a step list is not a semantic model of WebDriver. It is method, path, status, duration and
-- timestamp — written down as the bytes go past. A proxy that records
-- `POST …/element/abc/click → 200 in 84ms` has not modelled anything; it has written down what it
-- already forwarded. When Appium adds a command tomorrow, this logs it correctly WITHOUT KNOWING
-- WHAT IT IS, which is precisely the property that comment is protecting.
--
-- ---------------------------------------------------------------- what is deliberately not stored
--
-- **NO REQUEST OR RESPONSE BODIES.** A WebDriver body carries the customer's selectors, their test
-- data, and on `POST /element/:id/value` their passwords. The SHAPE of a session is worth keeping
-- and the CONTENTS are not ours to hold. This is the single most important line in the file: a farm
-- that quietly retains its tenants' credentials for fourteen days is not a debugging feature, it is
-- an incident with a date on it.
--
-- **NO HEADERS**, for the same reason and one more: the automation grant is in them.
--
-- `error` holds the W3C error CODE only — `no such element`, `stale element reference` — which is a
-- fixed vocabulary defined by the specification, not caller data. The message beside it in the
-- response body frequently quotes the selector, so it stays out.

BEGIN;

CREATE TABLE session_commands (
  -- bigserial, not uuid. This is the only table in the schema written once per WebDriver command:
  -- a saturated four-device farm produces a few hundred rows a minute, and a random uuid primary key
  -- on that write rate fragments the index for no benefit anybody can see.
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id)     ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- The step number a person reads, counted within the session. Assigned by
  -- `record_session_commands` from what is already stored rather than by the API process, so a
  -- control plane that restarts mid-suite continues the numbering instead of starting again at 1.
  seq         integer NOT NULL,

  method      text NOT NULL CHECK (length(method) BETWEEN 1 AND 10),
  -- The upstream path with the `/session/<id>` prefix removed — it is the same for every row and
  -- naming it here would put the AUTOMATION SERVER'S session id in a tenant-readable table. What is
  -- left is `element/abc-123/click`, which is what makes one step distinguishable from the next.
  path        text NOT NULL CHECK (length(path) <= 2000),

  -- NULL when the proxy never got an answer: a timeout, or a host that went away mid-command. That
  -- is a distinct and important state — the command was sent and its outcome is unknown — and a 0
  -- or a 599 here would be this table inventing a status the wire never carried.
  status      integer,
  duration_ms integer CHECK (duration_ms >= 0),
  started_at  timestamptz NOT NULL,
  -- W3C error code only. See the header: the message beside it quotes selectors.
  error       text CHECK (length(error) <= 200),

  -- Two rows cannot claim the same step number. This is also what makes the recorder's batched
  -- insert safe against itself: a retry that raced would violate it rather than duplicate a step.
  UNIQUE (session_id, seq)
);

-- The only query this table exists to serve: one session's steps, in order.
CREATE INDEX session_commands_session_idx ON session_commands(session_id, seq);
-- The sweep. Retention is not optional — see below.
CREATE INDEX session_commands_age_idx ON session_commands(started_at);

ALTER TABLE session_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_commands FORCE  ROW LEVEL SECURITY;

CREATE POLICY session_commands_own_org ON session_commands
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- APPEND-ONLY, exactly as 030 made `execution_events`. A trace that can be rewritten is not
-- evidence, and the whole value of this table is answering "what actually happened" for a run that
-- has already gone wrong. 001's ALTER DEFAULT PRIVILEGES hands `mfarm_app` the full set on every
-- table the owner creates, so this arrived with UPDATE and DELETE attached; the revoke is the point
-- rather than a tidy-up.
REVOKE UPDATE, DELETE ON session_commands FROM mfarm_app;
GRANT  SELECT          ON session_commands TO mfarm_app;
GRANT  USAGE, SELECT   ON SEQUENCE session_commands_id_seq TO mfarm_app;

-- ---------------------------------------------------------------- the batched write
--
-- ONE STATEMENT PER FLUSH, NOT ONE PER COMMAND. The proxy hop's entire justification is that it
-- adds "a few milliseconds", and a round trip to Postgres inside it would be a self-inflicted
-- regression on the hot path of every customer's suite. The recorder buffers in the API process and
-- calls this with a batch; this function turns the batch into a single insert.
--
-- SEQ IS ASSIGNED HERE, from `MAX(seq)` plus the batch's own ordinality. Two reasons, and the second
-- is the one that matters: an in-process counter would restart at 1 when the API restarts, silently
-- colliding with the rows already stored — the UNIQUE constraint would then reject the whole batch
-- and the suite would lose its trace at exactly the moment something interesting was happening.
--
-- ---------------------------------------------------------------- the org is CHECKED, not derived
--
-- THE TRAP THIS FUNCTION FELL INTO IN DRAFT, and it is worth writing down because the reasoning
-- that produced it sounds correct:
--
--   "The org is derived from the session, never accepted from the caller — architecture rule 4. A
--   tenant naming another org's session finds no row, because `sessions` is FORCE ROW LEVEL
--   SECURITY and this function's owner is not that table's owner, so the policy applies."
--
-- Every sentence there is true except the last, and the last one is the whole control.
-- `mfarm_definer` HAS **BYPASSRLS** — migration 012 gave it that deliberately, because
-- `promote_queued` has to read every org's queued sessions to do its job. So inside ANY definer
-- function, RLS is simply not there, and a derived org is not a scoped org: it is whatever org owns
-- whatever session id the caller passed.
--
-- A test written to confirm the reasoning found org B writing a forged step into org A's session,
-- filed under A. `request_capture` in migration 040 has the correct shape — it takes `p_org` and
-- puts it in the predicate — and this now matches it. The org still never comes from a request
-- BODY; it comes from `requireTenant`, which is the authenticated caller.
--
-- The rule, stated for the next definer function somebody writes: **a SECURITY DEFINER function
-- that accepts an id from a tenant must name that tenant in its WHERE clause.** RLS will not do it.
CREATE OR REPLACE FUNCTION record_session_commands(p_org uuid, p_session uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_base integer; v_n integer;
BEGIN
  SELECT org_id INTO v_org FROM sessions WHERE id = p_session AND org_id = p_org;
  -- Covers both "no such session" and "not yours", and they are the same answer to the caller.
  --
  -- NOT AN ERROR either way. The recorder flushes asynchronously, so a run whose rows were deleted
  -- between the command and the flush is an ordinary race — and a caller that reached here with the
  -- wrong org has a bug the trace is not the place to report.
  IF v_org IS NULL THEN RETURN 0; END IF;

  /**
   * SERIALISED PER SESSION, so two concurrent flushes cannot both read the same MAX and then
   * collide on the UNIQUE. One session is driven by one suite, so contention here is near zero —
   * but "near zero" is how every fence bug in this repo started.
   *
   * AN ADVISORY LOCK, not `SELECT ... FOR UPDATE`. Two reasons, and the first is that Postgres
   * refuses the other: `FOR UPDATE` is not allowed with an aggregate. The first draft of this
   * function tried it, and the recorder's swallow-and-count then hid the error as a silently empty
   * trace — the failure mode that module is designed to have, working exactly as intended, and a
   * reminder that "it did not crash" is not the same as "it worked".
   *
   * The second reason is that there is no row to lock. The first batch of a session has nothing in
   * this table yet, so a row lock could not serialise the case that needs it most.
   *
   * `_xact_` so COMMIT releases it and there is no unlock to forget. The first key is a constant so
   * this cannot collide with an advisory lock taken anywhere else in the schema.
   */
  PERFORM pg_advisory_xact_lock(hashtext('session_commands'), hashtext(p_session::text));

  SELECT COALESCE(MAX(seq), 0) INTO v_base
    FROM session_commands WHERE session_id = p_session;

  INSERT INTO session_commands
    (org_id, session_id, seq, method, path, status, duration_ms, started_at, error)
  SELECT v_org, p_session, v_base + t.ord,
         t.r->>'method',
         left(t.r->>'path', 2000),
         (t.r->>'status')::integer,
         (t.r->>'durationMs')::integer,
         (t.r->>'startedAt')::timestamptz,
         left(t.r->>'error', 200)
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL   ON FUNCTION record_session_commands(uuid, uuid, jsonb) FROM PUBLIC;
ALTER FUNCTION record_session_commands(uuid, uuid, jsonb) OWNER TO mfarm_definer;
GRANT EXECUTE ON FUNCTION record_session_commands(uuid, uuid, jsonb) TO mfarm_app;

GRANT SELECT, INSERT ON session_commands TO mfarm_definer;
GRANT USAGE, SELECT  ON SEQUENCE session_commands_id_seq TO mfarm_definer;

-- ---------------------------------------------------------------- retention is not optional
--
-- 019 said it for artifacts and it is more true here: this is the highest-write table in the
-- schema. A 500 GB disk and unbounded capture is an outage with a date on it, and the date is
-- sooner for something written once per click than for something written once per session.
--
-- BOUNDED PER SWEEP, like `expire_artifacts`. A first sweep after a retention change must not take
-- a table lock for however long it takes to delete a month of rows.
CREATE OR REPLACE FUNCTION expire_session_commands(p_ttl interval, p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH doomed AS (
    SELECT id FROM session_commands
     WHERE started_at < now() - p_ttl
     ORDER BY started_at
     LIMIT p_limit
  )
  DELETE FROM session_commands c USING doomed d WHERE c.id = d.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Fleet-wide: it deletes rows belonging to every org, and RLS says nothing about a definer
-- function. So it is revoked from `mfarm_app` as well as PUBLIC and called by the reaper on the
-- system pool — the rule 039 restated after getting it wrong in draft, and the one
-- `test/definer-acl.test.ts` checks.
REVOKE ALL   ON FUNCTION expire_session_commands(interval, integer) FROM PUBLIC, mfarm_app;
ALTER FUNCTION expire_session_commands(interval, integer) OWNER TO mfarm_definer;

GRANT DELETE ON session_commands TO mfarm_definer;

COMMIT;
