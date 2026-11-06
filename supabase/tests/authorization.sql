-- =============================================================================
-- Authorization hardening (phase 4): tables whose rules live in SECURITY DEFINER RPCs are closed to direct writes at
-- the PRIVILEGE level (not only by RLS), internal tables are unreachable, anon is minimal, and nobody (not even an
-- admin with MFA) can change slots, roles, doctors, refunds, prescriptions or call / chat records except through the RPCs.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/authorization.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
grant all on t_results to authenticated, anon, service_role;
grant usage on sequence t_results_n_seq to authenticated, anon, service_role;
create function pg_temp.expect_value(area text, name text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v; exception when others then v := 'error: ' || sqlerrm; end;
  insert into t_results (persona, check_name, expected, actual, ok) values (area, name, expected, coalesce(v, 'null'), v is not distinct from expected);
end $$;
create function pg_temp.expect_error(area text, name text, q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
    insert into t_results (persona, check_name, expected, actual, ok) values (area, name, 'error: ' || needle, 'succeeded', false);
  exception when others then
    insert into t_results (persona, check_name, expected, actual, ok) values (area, name, 'error: ' || needle, left(sqlerrm, 60), sqlerrm ilike '%' || needle || '%');
  end;
end $$;
create function pg_temp.login(uid text, aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;

\set admin  '00000001-0000-4000-8000-000000000001'
\set coord  '00000001-0000-4000-8000-000000000003'
\set arun   '00000001-0000-4000-8000-000000000064'
\set anjali '00000001-0000-4000-8000-0000000000c8'

-- ---------------------------------------------------------------- A. RPC-owned tables: no direct write privilege
select pg_temp.expect_value('grants', 'authenticated cannot write ' || t,
  format($q$select count(*)::text from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p where has_table_privilege('authenticated', %L, p)$q$, 'public.' || t), '0')
from unnest(array['appointments','auth_step_up','call_logs','chat_messages','doctor_availability','doctor_secrets','doctors','fee_config',
                  'payment_webhook_events','payments','prescription_items','prescriptions','rate_limits','refunds','reschedule_requests',
                  'support_tickets','user_roles','slots']) as t;

-- ---------------------------------------------------------------- B. internal tables: not even readable by signed-in users
select pg_temp.expect_value('grants', 'authenticated cannot even read ' || t,
  format($q$select has_table_privilege('authenticated', %L, 'SELECT')::text$q$, 'public.' || t), 'false')
from unnest(array['doctor_secrets','auth_step_up','rate_limits','payment_webhook_events']) as t;

-- ---------------------------------------------------------------- C. anon: only the published legal / consent texts
select pg_temp.expect_value('anon', 'anon holds no table privilege except SELECT on content_versions',
  $q$select count(*)::text from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' and not (table_name = 'content_versions' and privilege_type = 'SELECT')$q$, '0');
select pg_temp.expect_value('anon', 'published texts are still readable', $q$select has_table_privilege('anon', 'public.content_versions', 'SELECT')::text$q$, 'true');

-- ---------------------------------------------------------------- D. admin with MFA still cannot bypass the RPCs
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_error('admin', 'cannot rewrite roles directly', $q$update user_roles set role = 'admin' where role = 'patient'$q$, 'permission denied');
select pg_temp.expect_error('admin', 'cannot verify a doctor directly (two-person rule lives in the RPC)', $q$update doctors set verification_status = 'verified'$q$, 'permission denied');
select pg_temp.expect_error('admin', 'cannot mark a refund processed directly', $q$update refunds set status = 'processed'$q$, 'permission denied');
select pg_temp.expect_error('admin', 'cannot edit slots directly', $q$update slots set status = 'open'$q$, 'permission denied');
select pg_temp.expect_error('admin', 'cannot create slots directly', $q$insert into slots (doctor_id, start_at, end_at) select doctor_id, start_at + interval '400 days', end_at + interval '400 days' from slots limit 1$q$, 'permission denied');
select pg_temp.expect_error('admin', 'cannot delete slots directly', $q$delete from slots$q$, 'permission denied');
select pg_temp.expect_value('admin', 'but can still see the calendar', $q$select (count(*) > 0)::text from slots$q$, 'true');
reset role;

select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('coordinator', 'cannot edit slots directly', $q$update slots set status = 'open'$q$, 'permission denied');
select pg_temp.expect_error('coordinator', 'cannot create slots directly', $q$insert into slots (doctor_id, start_at, end_at) select doctor_id, start_at + interval '401 days', end_at + interval '401 days' from slots limit 1$q$, 'permission denied');
select pg_temp.expect_value('coordinator', 'but can still see the calendar', $q$select (count(*) > 0)::text from slots$q$, 'true');
reset role;

-- ---------------------------------------------------------------- E. doctor: prescriptions, logs and chat only through the RPCs
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('doctor', 'cannot insert a prescription for any appointment', $q$insert into prescriptions (appointment_id, doctor_id, patient_id) select a.id, a.doctor_id, a.patient_id from appointments a limit 1$q$, 'permission denied');
select pg_temp.expect_error('doctor', 'cannot rewrite a draft prescription', $q$update prescriptions set advice = 'x'$q$, 'permission denied');
select pg_temp.expect_error('doctor', 'cannot write prescription items', $q$insert into prescription_items (prescription_id, drug_id, drug_name) select id, 'drug-001', 'x' from prescriptions limit 1$q$, 'permission denied');
select pg_temp.expect_error('doctor', 'cannot forge call-log events', $q$insert into call_logs (appointment_id, provider, room_name, event) select id, 'x', 'x', 'join' from appointments limit 1$q$, 'permission denied');
select pg_temp.expect_error('doctor', 'cannot forge a chat message', $q$insert into chat_messages (appointment_id, sender_user_id, sender_role, body) select id, auth.uid(), 'patient', 'x' from appointments limit 1$q$, 'permission denied');
select pg_temp.expect_error('doctor', 'cannot edit the own doctor record (name, registration, status)', $q$update doctors set full_name = 'x'$q$, 'permission denied');
select pg_temp.expect_value('doctor', 'still reads own prescriptions', $q$select (count(*) > 0)::text from prescriptions$q$, 'true');
reset role;

-- ---------------------------------------------------------------- F. patient: bookings and money only through the RPCs
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_error('patient', 'cannot grant self a role', $q$insert into user_roles (user_id, role) values (auth.uid(), 'admin')$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot edit an appointment', $q$update appointments set fee_amount = 0$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot write a payment', $q$update payments set status = 'captured'$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot touch a refund', $q$update refunds set amount = 99999$q$, 'permission denied');
select pg_temp.expect_value('patient', 'still sees own appointments', $q$select (count(*) > 0)::text from appointments$q$, 'true');
reset role;

-- ---------------------------------------------------------------- G. tables added later get no automatic access
create table public.zz_authz_probe (id int);
select pg_temp.expect_value('defaults', 'a new table is closed to signed-in users until granted on purpose', $q$select has_table_privilege('authenticated', 'public.zz_authz_probe', 'SELECT')::text$q$, 'false');
select pg_temp.expect_value('defaults', 'and to anon', $q$select has_table_privilege('anon', 'public.zz_authz_probe', 'SELECT')::text$q$, 'false');

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
