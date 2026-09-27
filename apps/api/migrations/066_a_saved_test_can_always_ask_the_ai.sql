-- 066 — a saved test can be told never to replay its route, and always ask the AI (ADR-0046).
--
-- A saved test replays the route its last passing run took (065), which is what a regression check
-- wants: the same path, checked the same way, for nothing. An EXPLORATORY test wants the opposite —
-- a model looking at every build afresh, finding what nobody wrote down (C7). `replay = false` says
-- so: its runs are driven by the AI from the first step, and it is not let past a model that is down.
-- Its routes are still kept, so switching it back replays the latest one at once.

BEGIN;

ALTER TABLE ai_tests ADD COLUMN replay boolean NOT NULL DEFAULT true;

COMMIT;
