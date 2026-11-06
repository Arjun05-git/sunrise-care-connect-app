-- =============================================================================
-- Authorization hardening (hardening phase 4).
--
-- Nearly every business rule here lives in a SECURITY DEFINER RPC, and the app only ever writes through those
-- RPCs. Earlier migrations removed the matching write POLICIES, but the table PRIVILEGES stayed wide open
-- (`grant select, insert, update, delete on all tables … to authenticated`), so RLS was the only lock: one
-- permissive policy added by mistake would silently reopen a table. This migration closes the privilege layer too.
--
--   1. slots: admin / coordinator could insert, update and delete slots directly (slots_staff, FOR ALL), bypassing
--      generate_slots, the availability rules and the booking locks. They keep read access; changes go through the RPCs.
--   2. signatures bucket: admins could read AND overwrite doctors' signature images (the images printed on signed
--      prescriptions). Only the doctor-signature function (PIN-protected, service role) may write them. No client
--      policy remains on that bucket.
--   3. Table privileges: signed-in users lose INSERT / UPDATE / DELETE / TRUNCATE on every RPC-owned table, and all
--      access to four internal tables they never use (PIN hashes, step-up, rate limits, webhook log).
--   4. anon: no table privilege except SELECT on content_versions (published legal / consent texts). Hosted Supabase
--      grants new tables to anon by default; this removes whatever it granted.
--   5. Tables added later start closed: nothing is granted to anon / authenticated unless a migration grants it.
--
-- Not changed: SECURITY DEFINER functions (they run as the owner, which owns the tables), service_role, and the
-- read policies. Admin write policies on master data (settings, drugs, ICD-10, hospitals, …) are a separate decision.
-- =============================================================================

-- ---------------------------------------------------------------- 1. slots: staff may read, not write
drop policy if exists slots_staff on slots;
create policy slots_staff_read on slots for select using (public.staff_ok('admin', 'coordinator'));

-- ---------------------------------------------------------------- 2. signatures: written only by the doctor-signature function
drop policy if exists "signatures admin" on storage.objects;

-- ---------------------------------------------------------------- 3. table privileges
revoke insert, update, delete, truncate on
  appointments, auth_step_up, call_logs, chat_messages, doctor_availability, doctor_secrets, doctors, fee_config,
  payment_webhook_events, payments, prescription_items, prescriptions, rate_limits, refunds, reschedule_requests,
  support_tickets, user_roles, slots
from authenticated;

-- never used by the app (the RPCs and edge functions read them as owner / service role)
revoke all on doctor_secrets, auth_step_up, rate_limits, payment_webhook_events from authenticated;

-- ---------------------------------------------------------------- 4. anon
revoke all on all tables in schema public from anon;
grant select on content_versions to anon;   -- published legal / consent texts (RLS limits it to what is published)

-- ---------------------------------------------------------------- 5. later tables start closed
alter default privileges in schema public revoke all on tables from anon, authenticated;
