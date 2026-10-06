-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120400 — Every migration.* history table is append-only (E-I1)
--
-- "Imported history is immutable history." Until now that was true of one of the
-- six history tables: migration.unattributed_payments (20260918130700). The other
-- four held the same kind of record — a verbatim legacy row — with nothing but
-- grants between them and an UPDATE. This attaches the same generic guard,
-- app.block_row_mutation(), which fires for every role, including the owner and
-- service_role (a trigger is part of the table, not a policy).
--
-- The two new history tables (legacy_withdrawal, legacy_overflow) and the
-- provenance registry got their guards in their own migrations.
--
-- CONSEQUENCE, stated plainly: legacy_collection.collection_id and
-- legacy_profile.user_id were declared ON DELETE CASCADE. A cascade from a live
-- row now reaches a row that refuses deletion, so deleting an imported
-- collection or user fails. That is already true of imported collections
-- (M9 immutability) and no code path deletes a user (users → auth.users is
-- ON DELETE RESTRICT). History outliving the live row is the zero-data-loss
-- requirement, not a side effect.
-- ─────────────────────────────────────────────────────────────────────────────

create trigger legacy_profile_no_update
  before update on migration.legacy_profile
  for each row execute function app.block_row_mutation();
create trigger legacy_profile_no_delete
  before delete on migration.legacy_profile
  for each row execute function app.block_row_mutation();

create trigger legacy_collection_no_update
  before update on migration.legacy_collection
  for each row execute function app.block_row_mutation();
create trigger legacy_collection_no_delete
  before delete on migration.legacy_collection
  for each row execute function app.block_row_mutation();

create trigger legacy_contribution_no_update
  before update on migration.legacy_contribution
  for each row execute function app.block_row_mutation();
create trigger legacy_contribution_no_delete
  before delete on migration.legacy_contribution
  for each row execute function app.block_row_mutation();

create trigger legacy_deposit_no_update
  before update on migration.legacy_deposit
  for each row execute function app.block_row_mutation();
create trigger legacy_deposit_no_delete
  before delete on migration.legacy_deposit
  for each row execute function app.block_row_mutation();
