-- 070: an operation can be about the cloud.
--
-- The operations log (053) records what an operator did to a host, a service or the fleet. ADR-0053
-- adds two operations that are about none of those: taking a snapshot of a disk, and deleting one.
-- Filing them under `fleet` would make "what was done to the fleet" return disk names, and the log's
-- own filter by target kind would stop meaning what it says.
--
-- ---------------------------------------------------------------- rewritten from the LIVE constraint
--
-- A CHECK cannot be extended, only dropped and rewritten in full, and rewriting it from the migration
-- that created it silently drops every value added in between — architecture rule 8, learned from
-- migration 042. The list below is what `pg_get_constraintdef` returned on 2026-10-09:
--
--     CHECK ((target_kind = ANY (ARRAY['host'::text, 'service'::text, 'fleet'::text])))
--
-- plus the one value this adds.
--
-- The append-only trigger does not stand in the way: it guards rows, and this changes the table.

BEGIN;

ALTER TABLE infra_operations
  DROP CONSTRAINT infra_operations_target_kind_check,
  ADD CONSTRAINT infra_operations_target_kind_check
    CHECK (target_kind IN ('host', 'service', 'fleet', 'cloud'));

COMMIT;
