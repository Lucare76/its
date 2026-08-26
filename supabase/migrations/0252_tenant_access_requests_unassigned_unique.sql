-- The existing unique(tenant_id, user_id) constraint (0057) does not protect
-- unassigned requests (tenant_id IS NULL, one row per user pending manual
-- admin assignment to an agency) because NULL is never equal to NULL in a
-- unique constraint. This allows two concurrent /api/auth/register calls for
-- the same user to both insert a pending unassigned request.
--
-- Verified before adding this index (2026-08-26): zero existing rows with
-- tenant_id IS NULL, so no duplicates to reconcile.
create unique index if not exists tenant_access_requests_unassigned_user_unique
  on public.tenant_access_requests (user_id)
  where tenant_id is null;
