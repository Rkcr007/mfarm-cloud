-- 015: an install is one of three things you do to an app on a device, not the only thing.
--
-- 014 shipped `app_installs` a day ago, and adding launch and uninstall makes the name a lie: a row
-- with `kind = 'uninstall'` in a table called app_installs is the kind of detail that reads fine to
-- whoever wrote it and confuses everyone after. Renamed rather than worked around, and the reason
-- it can be renamed at all is that 014 has never been deployed anywhere — the only databases that
-- have it are development and CI. The window for that closes the first time this runs on the box.
--
-- The three verbs share ONE pipeline deliberately. Each is a job the control plane cannot push, so
-- each needs delivery over the heartbeat, host-scoped confirmation, a fence check and a reaper
-- sweep — and having built that once for installs, a second mechanism for launch would be the same
-- code with different table names and its own bugs. What differs is exactly one thing: only
-- `install` needs the blob, so only `install` authorises a download.

BEGIN;

ALTER TABLE app_installs RENAME TO app_actions;
ALTER TYPE app_install_state RENAME TO app_action_state;

-- Index and constraint names do not follow a table rename, and a name that says `installs` on a
-- table that says `actions` is the same confusion one level down.
ALTER INDEX app_installs_pending_idx RENAME TO app_actions_pending_idx;
ALTER INDEX app_installs_session_idx RENAME TO app_actions_session_idx;
ALTER POLICY app_installs_read    ON app_actions RENAME TO app_actions_read;
ALTER POLICY app_installs_request ON app_actions RENAME TO app_actions_request;

-- INSTALLED was the right word for the only verb that existed and is the wrong one for a launch:
-- a console showing "INSTALLED" against "Launch app" is a UI nobody trusts twice. Renamed with the
-- table, in the same window and for the same reason — nothing has deployed 014 yet.
ALTER TYPE app_action_state RENAME VALUE 'INSTALLED' TO 'DONE';

CREATE TYPE app_action_kind AS ENUM ('install', 'launch', 'uninstall');
-- DEFAULT 'install' so the rows 014 created keep their meaning without a backfill, and so a caller
-- that omits the field gets the verb it would have got yesterday.
ALTER TABLE app_actions ADD COLUMN kind app_action_kind NOT NULL DEFAULT 'install';

-- `launch` and `uninstall` need the package name and nothing else — no bytes move — but they still
-- reference an app_build, because the library row is where the package name comes from and because
-- "uninstall anything you can name" is a different, larger permission than "uninstall something you
-- uploaded". A device-wide uninstall belongs behind an admin surface that does not exist yet.
COMMENT ON COLUMN app_actions.kind IS
  'install moves bytes and authorises a blob download; launch and uninstall carry only the package name.';

-- The partial index 014 created still says WHERE state = ''PENDING'', which is what the heartbeat
-- query filters on, and kind is not selective enough to be worth adding to it: a host has a handful
-- of pending actions, never thousands.

COMMIT;
