-- 030: an execution gets a timeline.
--
-- ADR-0018 settled what an execution IS: a record MFARM owns, around a test process the customer
-- owns. `AutomationExecutionPlan.md` then asks for three things that all turn out to be one table —
-- an explicit state machine whose every transition is persisted (§4), a live event feed (§17), and
-- a per-execution timeline (§18). They are the same rows read three ways, so there is one table.
--
-- WHAT WAS MISSING. A run today reports how many sessions it had and what they installed, all of it
-- DERIVED at read time from `sessions` and `test_results`. Nothing records what HAPPENED: a session
-- that waited four minutes in the queue and one that was allocated instantly are the same two rows
-- afterwards, and "why was this run slow" is not a slow question, it is an unanswerable one — the
-- same shape of gap migration 020 closed for "which sessions belong together".
--
-- ---------------------------------------------------------------- append-only, and why that matters
--
-- Events are INSERTED and never updated. A timeline that can be rewritten is not evidence, and the
-- whole value of this table is answering "what actually happened" for a run that has already gone
-- wrong. `mfarm_app` gets INSERT and SELECT, and no UPDATE or DELETE — retention is a future sweep
-- like `expire_artifacts`, not a handler reaching back to tidy history.
--
-- ---------------------------------------------------------------- what is deliberately NOT here
--
-- **No `state` column on the event.** A transition is `kind` plus its `occurred_at`; deriving the
-- current state from the last event is one query and cannot disagree with the history, whereas a
-- denormalised state on the run can and eventually does. Migration 020 refused `runs.status` for a
-- related reason and that refusal still stands here: this migration records what happened, and a
-- run's OUTCOME is a separate decision that needs the declared end ADR-0018 describes.
--
-- **`run_id` is NOT NULL, so a session with no `mfarm:runId` produces no events.** That is the
-- honest shape: this table is the timeline OF A RUN, and a lease taken by someone poking at a
-- device from the console is not a run. Making it nullable would fill the table with rows no screen
-- can show and no query would group.

BEGIN;

CREATE TABLE execution_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- Which lease this happened to, when it happened to one. NULL for a run-level event: the run
  -- being created belongs to no session, and neither does a queue wait that never got a device.
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  -- SET NULL rather than CASCADE: a device leaving the fleet must not delete the record of what it
  -- did while it was here. Same reasoning as `sessions.device_id` in 001.
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,

  -- text + CHECK, never an enum. `ALTER TYPE ... ADD VALUE` cannot run in the transaction that adds
  -- it, so a new event kind plus a constraint mentioning it would take two migrations — the trap
  -- 019 wrote down and 022 paid for. Adding a kind here is one line.
  kind        text NOT NULL CHECK (kind IN (
    'run-created',
    'session-queued', 'device-allocated', 'session-active',
    'build-install-started', 'build-install-finished',
    'session-ended',
    'device-released',
    'incident'
  )),
  -- Whatever this kind needs and nothing shared: a queue wait carries how long it waited, an
  -- install carries the build. Deliberately not columns — most would be NULL for most kinds, and a
  -- table of mostly-NULL columns is one nobody can read.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- The timeline query, and the only one this table exists to serve: one run, in order.
CREATE INDEX execution_events_run_idx ON execution_events(run_id, occurred_at);
-- "What happened to this session" — the link from a failed test to what the farm was doing.
CREATE INDEX execution_events_session_idx ON execution_events(session_id, occurred_at)
  WHERE session_id IS NOT NULL;

ALTER TABLE execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY execution_events_own_org ON execution_events
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- 001's ALTER DEFAULT PRIVILEGES hands `mfarm_app` the full set on every table the owner creates,
-- so this arrived with UPDATE and DELETE attached. Same trap as 014, 023 and 024; same revoke — and
-- here it is the whole point rather than a tidy-up, because an append-only table that the app can
-- rewrite is not append-only.
REVOKE UPDATE, DELETE ON execution_events FROM mfarm_app;

COMMENT ON TABLE execution_events IS
  'Append-only timeline of what the farm did during a run. Never updated: a timeline that can be '
  'rewritten is not evidence, and this table exists to explain runs that already went wrong.';

COMMIT;
