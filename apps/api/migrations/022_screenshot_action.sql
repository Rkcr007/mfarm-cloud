-- 022: an on-demand screenshot, and the end of the enum that made it awkward.
--
-- THE BUG THIS FIXES. The release-time screenshot is taken when a device is handed back, and by
-- then Appium's `deleteSession()` has already force-stopped the app — so the one artifact a person
-- opens to see WHY a test failed reliably shows the launcher. `examples/medishop-suite` works
-- around it by screenshotting locally inside `withDevice()`, which works and which every other
-- suite would have to reinvent.
--
-- The fix is a `screenshot` verb on `app_actions`, because that pipeline already solves the four
-- hard parts: heartbeat delivery (the control plane cannot dial a worker), host scoping, the fence
-- re-check at delivery, and the orphan sweep. Migration 015 generalised it from `app_installs` for
-- exactly this, and this is the first verb to arrive since.
--
-- ---------------------------------------------------------------- the enum has to go first
--
-- `kind` is a Postgres ENUM, and 019 wrote down why that was the wrong choice before this migration
-- needed it: `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that adds it, so
-- adding a verb AND a constraint mentioning it takes two migrations. `text` + CHECK takes one, and
-- reads identically to every caller.
--
-- So this converts rather than extends. Doing it now costs one rewrite of a small table; doing it
-- at the fifth verb costs the same rewrite plus whatever has been built on the enum by then.
--
-- ---------------------------------------------------------------- a screenshot has no app
--
-- `app_id` was NOT NULL because every verb so far named a build. A screenshot names none — it is a
-- picture of whatever is on screen — so the column becomes nullable and a CHECK carries the real
-- rule: the app verbs still require one, and the constraint says so in the schema rather than in
-- three call sites that could drift.

BEGIN;

-- ---------------------------------------------------------------- kind: enum -> text + CHECK

ALTER TABLE app_actions ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE app_actions ALTER COLUMN kind TYPE text USING kind::text;
ALTER TABLE app_actions ALTER COLUMN kind SET DEFAULT 'install';

ALTER TABLE app_actions ADD CONSTRAINT app_actions_kind_check
  CHECK (kind IN ('install', 'launch', 'uninstall', 'screenshot'));

-- Nothing else referenced it; a type left behind reads like something still in use.
DROP TYPE app_action_kind;

-- ---------------------------------------------------------------- a screenshot names no build

ALTER TABLE app_actions ALTER COLUMN app_id DROP NOT NULL;

-- The rule the NOT NULL used to carry, now stated where it is actually true. A screenshot with an
-- app_id is not refused — a caller that wants to record which build was on screen may say so — but
-- an install without one is nonsense and stays impossible.
ALTER TABLE app_actions ADD CONSTRAINT app_actions_app_required
  CHECK (kind = 'screenshot' OR app_id IS NOT NULL);

COMMENT ON COLUMN app_actions.kind IS
  'install | launch | uninstall | screenshot. text + CHECK rather than an enum so a new verb is one '
  'line inside a transaction — see 019, and 022 which paid for the lesson.';

COMMIT;
