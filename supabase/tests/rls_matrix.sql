-- =============================================================================
-- RLS / constraint / audit test matrix. Run against a migrated + seeded database as `postgres`:
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_matrix.sql
-- Each persona is impersonated exactly like PostgREST does: JWT claims in `request.jwt.claims`
-- and `SET ROLE authenticated` (or anon). Prints a results table; exits non-zero on any failure.
-- Everything runs in one transaction that is rolled back – the database is left untouched.
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

-- ---------------------------------------------------------------- harness
create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
grant all on t_results to authenticated, anon;
grant usage on sequence t_results_n_seq to authenticated, anon;

-- Count rows returned by `q` (run as the CURRENT role, so RLS applies) and compare: '=N', '>N', '<N'.
create function pg_temp.expect(persona text, name text, q text, expected text) returns void language plpgsql as $$
declare c bigint; op text := left(expected, 1); v bigint := substr(expected, 2)::bigint; ok boolean;
begin
  execute format('select count(*) from (%s) x', q) into c;
  ok := case op when '=' then c = v when '>' then c > v when '<' then c < v end;
  insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, expected, c::text, ok);
end $$;

-- Expect statement `q` to fail with an error containing `needle`.
create function pg_temp.expect_error(persona text, name text, q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
    insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, 'error: ' || needle, 'succeeded', false);
  exception when others then
    insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, 'error: ' || needle, left(sqlerrm, 60), sqlerrm ilike '%' || needle || '%');
  end;
end $$;

-- Number of rows an UPDATE touched (0 = silently filtered by RLS).
create function pg_temp.expect_updated(persona text, name text, q text, expected int) returns void language plpgsql as $$
declare c int;
begin
  execute q;
  get diagnostics c = row_count;
  insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, '=' || expected, c::text, c = expected);
end $$;

-- Impersonate a user: claims as Supabase/PostgREST sets them.
create function pg_temp.login(uid text, aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;

-- seed identities
\set anjali     '00000001-0000-4000-8000-0000000000c8'
\set rajan      '00000001-0000-4000-8000-0000000000c9'
\set arun       '00000001-0000-4000-8000-000000000064'
\set meera      '00000001-0000-4000-8000-000000000065'
\set admin      '00000001-0000-4000-8000-000000000001'
\set finance    '00000001-0000-4000-8000-000000000002'
\set coord      '00000001-0000-4000-8000-000000000003'
\set anjali_pt  '00000005-0000-4000-8000-000000000001'
\set arun_doc   '00000004-0000-4000-8000-000000000001'

-- facts computed as postgres (bypassing RLS) for later assertions
select count(*) as total_appts from appointments \gset
select count(*) as total_patients from patients \gset
select id as foreign_patient from patients where id not in (select patient_id from appointments where doctor_id = :'arun_doc') and owner_user_id <> :'anjali' limit 1 \gset
select id as other_doctor_consult from consultations where doctor_id <> :'arun_doc' limit 1 \gset
select id as rajan_appt from appointments where patient_id = '00000005-0000-4000-8000-000000000002' limit 1 \gset
select id as open_slot from slots where status = 'open' and start_at > now() limit 1 \gset

-- ================================================================ PATIENT (Anjali: self + 2 dependents)
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect('patient', 'sees own + dependent patient records only', 'select 1 from patients', '=3');
select pg_temp.expect('patient', 'cannot see other patients by id', format('select 1 from patients where id = %L', :'foreign_patient'), '=0');
select pg_temp.expect('patient', 'sees own family''s appointments', 'select 1 from appointments', '>0');
select pg_temp.expect('patient', 'no appointment of another family', format('select 1 from appointments where patient_id not in (select id from patients where owner_user_id = %L)', :'anjali'), '=0');
select pg_temp.expect('patient', 'symptoms only for own appointments', 'select 1 from appointment_symptoms s join appointments a on a.id = s.appointment_id', '>0');
select pg_temp.expect('patient', 'only FINAL consultation notes', 'select 1 from consultations where status <> ''final''', '=0');
select pg_temp.expect('patient', 'only FINAL prescriptions', 'select 1 from prescriptions where status <> ''final''', '=0');
select pg_temp.expect('patient', 'own documents only', format('select 1 from documents where patient_id not in (select id from patients where owner_user_id = %L)', :'anjali'), '=0');
select pg_temp.expect('patient', 'own payments only', 'select 1 from payments', '>0');
select pg_temp.expect('patient', 'cannot read other family''s payment', format('select 1 from payments where appointment_id = %L', :'rajan_appt'), '=0');
select pg_temp.expect('patient', 'own notifications only', format('select 1 from notifications where user_id <> %L', :'anjali'), '=0');
select pg_temp.expect('patient', 'own role row only', 'select 1 from user_roles', '=1');
select pg_temp.expect('patient', 'catalogue: verified doctors only (9 of 10)', 'select 1 from doctors', '=9');
select pg_temp.expect('patient', 'cannot read audit log', 'select 1 from audit_logs', '=0');
select pg_temp.expect('patient', 'cannot read doctor PIN hashes', 'select 1 from doctor_secrets', '=0');
select pg_temp.expect_error('patient', 'cannot update another patient', format('update patients set address = ''x'' where id = %L', :'foreign_patient'), 'permission denied');
-- own profile changes go through save_patient only (a direct write could set his_mrn / an unverified ABHA)
select pg_temp.expect_error('patient', 'own profile: no direct writes (save_patient)', format('update patients set blood_group = ''B+'' where id = %L', :'anjali_pt'), 'permission denied');
select pg_temp.expect_error('patient', 'cannot insert appointments directly', format($q$insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status) select 'SC-HACK01', %L, %L, d.id, d.hospital_id, d.department_id, %L, now() + interval '1 day', now() + interval '1 day 15 min', 'video', 'first', 0, 'confirmed' from doctors d limit 1$q$, :'anjali_pt', :'anjali', :'open_slot'), 'row-level security');
select pg_temp.expect_error('patient', 'cannot grant self admin role', format('insert into user_roles (user_id, role) values (%L, ''admin'')', :'anjali'), 'row-level security');
select pg_temp.expect_error('patient', 'cannot record consent for someone else', format('insert into consents (user_id, consent_type, version, granted) values (%L, ''terms'', ''1.0'', true)', :'rajan'), 'permission denied');
select pg_temp.expect_updated('patient', 'cannot change fees (rows filtered)', 'update fee_config set amount = 1', 0);
reset role;

-- ================================================================ PATIENT (Rajan) – isolation from Anjali
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect('patient 2', 'cannot see Anjali''s appointments', format('select 1 from appointments where patient_id = %L', :'anjali_pt'), '=0');
select pg_temp.expect('patient 2', 'cannot see Anjali''s documents', format('select 1 from documents where patient_id = %L', :'anjali_pt'), '=0');
reset role;

-- ================================================================ DOCTOR (Dr Arun)
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect('doctor', 'sees own appointments', 'select 1 from appointments', '>0');
select pg_temp.expect('doctor', 'no other doctor''s appointments', format('select 1 from appointments where doctor_id <> %L', :'arun_doc'), '=0');
select pg_temp.expect('doctor', 'only patients with an appointment with him', format('select 1 from patients p where not exists (select 1 from appointments a where a.patient_id = p.id and a.doctor_id = %L)', :'arun_doc'), '=0');
select pg_temp.expect('doctor', 'cannot see unrelated patient', format('select 1 from patients where id = %L', :'foreign_patient'), '=0');
select pg_temp.expect('doctor', 'sees his patients'' symptoms', 'select 1 from appointment_symptoms', '>0');
select pg_temp.expect('doctor', 'sees his patients'' documents', 'select 1 from documents', '>0');
select pg_temp.expect('doctor', 'sees prior FINAL Rx of his patients (any doctor)', format('select 1 from prescriptions where doctor_id <> %L', :'arun_doc'), '>0');
select pg_temp.expect('doctor', 'cannot read payments', 'select 1 from payments', '=0');
select pg_temp.expect('doctor', 'cannot read audit log', 'select 1 from audit_logs', '=0');
select pg_temp.expect_error('doctor', 'cannot edit another doctor''s notes', format('update consultations set advice = ''x'' where id = %L', :'other_doctor_consult'), 'permission denied');
select pg_temp.expect_updated('doctor', 'cannot edit own doctor record / verification', format('update doctors set verification_status = ''verified'' where id = %L', :'arun_doc'), 0);
reset role;
-- step-up gate: when enabled, the doctor sees nothing until PIN/biometric is verified
update app_settings set value = 'true' where key = 'require_doctor_step_up';
set local role authenticated;
select pg_temp.expect('doctor', 'step-up ON, no PIN yet → no appointments', 'select 1 from appointments', '=0');
reset role;
insert into auth_step_up (user_id, verified_until) values (:'arun', now() + interval '1 hour');
set local role authenticated;
select pg_temp.expect('doctor', 'step-up ON, PIN verified → appointments visible', 'select 1 from appointments', '>0');
reset role;
update app_settings set value = 'false' where key = 'require_doctor_step_up';

-- ================================================================ COORDINATOR (operations, no clinical)
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect('coordinator', 'sees all appointments', 'select 1 from appointments', '=' || :'total_appts');
select pg_temp.expect('coordinator', 'sees patient demographics', 'select 1 from patients', '=' || :'total_patients');
select pg_temp.expect('coordinator', 'NO symptoms', 'select 1 from appointment_symptoms', '=0');
select pg_temp.expect('coordinator', 'NO consultation notes', 'select 1 from consultations', '=0');
select pg_temp.expect('coordinator', 'NO prescriptions', 'select 1 from prescriptions', '=0');
select pg_temp.expect('coordinator', 'NO medical documents', 'select 1 from documents', '=0');
select pg_temp.expect('coordinator', 'NO payments', 'select 1 from payments', '=0');
select pg_temp.expect('coordinator', 'sees support tickets', 'select 1 from support_tickets', '>0');
select pg_temp.expect('coordinator', 'sees notification outbox', 'select 1 from notifications', '>0');
select pg_temp.expect('coordinator', 'cannot read audit log', 'select 1 from audit_logs', '=0');
reset role;

-- ================================================================ FINANCE (money, no clinical)
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect('finance', 'sees payments', 'select 1 from payments', '>0');
select pg_temp.expect('finance', 'sees refunds', 'select 1 from refunds', '>0');
select pg_temp.expect('finance', 'sees appointment metadata', 'select 1 from appointments', '=' || :'total_appts');
select pg_temp.expect('finance', 'NO symptoms', 'select 1 from appointment_symptoms', '=0');
select pg_temp.expect('finance', 'NO consultation notes', 'select 1 from consultations', '=0');
select pg_temp.expect('finance', 'NO prescriptions', 'select 1 from prescriptions', '=0');
select pg_temp.expect('finance', 'NO support tickets', 'select 1 from support_tickets', '=0');
select pg_temp.expect_updated('finance', 'no direct fee edits (only via save_fee)', 'update fee_config set amount = amount where id = (select id from fee_config limit 1)', 0);
select pg_temp.expect('finance', 'can change a fee via save_fee (reason required)',
  $q$select save_fee(scope, doctor_id, department_id, mode, consult_type, amount + 1, 'Annual revision') from fee_config where scope = 'department' limit 1$q$, '=1');
select pg_temp.expect_updated('finance', 'cannot change follow-up policy', 'update follow_up_policy set free_window_days = 30', 0);
reset role;

-- ================================================================ ADMIN
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect('admin', 'sees all appointments', 'select 1 from appointments', '=' || :'total_appts');
select pg_temp.expect('admin', 'sees clinical notes', 'select 1 from consultations', '>0');
select pg_temp.expect('admin', 'reads audit log', 'select 1 from audit_logs', '>0');
select pg_temp.expect('admin', 'sees unverified doctors too (10)', 'select 1 from doctors', '=10');
select pg_temp.expect_updated('admin', 'can change follow-up policy', 'update follow_up_policy set free_window_days = free_window_days', 1);
reset role;
-- MFA: once a TOTP factor is enrolled, an aal1 session loses admin access; aal2 restores it
insert into auth.mfa_factors (id, user_id, status) values (gen_random_uuid(), :'admin', 'verified');
set local role authenticated;
select pg_temp.expect('admin', 'MFA enrolled, aal1 session → no access', 'select 1 from audit_logs', '=0');
reset role;
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect('admin', 'MFA enrolled, aal2 session → access', 'select 1 from audit_logs', '>0');
reset role;

-- ================================================================ ANON
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select pg_temp.expect_error('anon', 'cannot read appointments', 'select 1 from appointments', 'permission denied');
select pg_temp.expect_error('anon', 'cannot read doctors', 'select 1 from doctors', 'permission denied');
select pg_temp.expect_error('anon', 'cannot read patients', 'select 1 from patients', 'permission denied');
reset role;

-- ================================================================ CONSTRAINTS (as postgres – bypassing app code entirely)
-- Same slot_id at a non-overlapping time isolates the UNIQUE(slot_id) guarantee from the overlap guard.
select pg_temp.expect_error('constraint', 'same slot booked twice → unique violation',
  $q$insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
     select 'SC-DUP001', '00000005-0000-4000-8000-000000000003', '00000001-0000-4000-8000-0000000000ca', doctor_id, hospital_id, department_id, slot_id, start_at + interval '30 days', end_at + interval '30 days', mode, 'first', 500, 'confirmed'
     from appointments where status = 'confirmed' limit 1$q$, 'appointments_one_live_per_slot');
select pg_temp.expect_error('constraint', 'overlapping time, different slot → exclusion violation',
  $q$insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
     select 'SC-DUP002', '00000005-0000-4000-8000-000000000003', '00000001-0000-4000-8000-0000000000ca', a.doctor_id, a.hospital_id, a.department_id, s.id, a.start_at + interval '5 min', a.end_at + interval '5 min', a.mode, 'first', 500, 'confirmed'
     from appointments a, slots s where a.status = 'confirmed' and s.status = 'open' and s.doctor_id = a.doctor_id limit 1$q$, 'appointments_no_double_booking');
select pg_temp.expect_error('constraint', 'duplicate doctor slot → unique violation',
  $q$insert into slots (doctor_id, start_at, end_at) select doctor_id, start_at, end_at from slots limit 1$q$, 'slots_doctor_start_uq');
select pg_temp.expect_error('constraint', 'overlapping doctor slot → exclusion violation',
  $q$insert into slots (doctor_id, start_at, end_at) select doctor_id, start_at + interval '5 min', end_at + interval '5 min' from slots limit 1$q$, 'slots_no_overlap');
select pg_temp.expect_error('constraint', 'Schedule X drug must be Prohibited',
  $q$insert into drug_master (id, name, generic_name, form, strength, category, schedule) values ('t-x', 'X', 'X', 'Tab', '1', 'A', 'X')$q$, 'check constraint');
select pg_temp.expect_error('constraint', 'templates cannot carry clinical variables',
  $q$update notification_templates set variables = array['diagnosis'] where key = 'otp'$q$, 'check constraint');

-- ================================================================ AUDIT
select pg_temp.login(:'admin', 'aal2');
set local app.audit_reason = 'Board decision: 21-day window';
set local role authenticated;
update follow_up_policy set free_window_days = 21;
reset role;
select pg_temp.expect('audit', 'policy change logged with actor, reason, before/after diff',
  $q$select 1 from audit_logs where action = 'follow_up_policy.update' and actor_role = 'admin' and reason like 'Board decision%'
       and before = '{"free_window_days": 14}'::jsonb and after ->> 'free_window_days' = '21'$q$, '=1');
-- a draft note on one of Arun's consultations without notes (final notes are locked)
insert into consultations (appointment_id, doctor_id, patient_id, status)
select a.id, a.doctor_id, a.patient_id, 'draft' from appointments a
 where a.doctor_id = :'arun_doc' and not exists (select 1 from consultations c where c.appointment_id = a.id) limit 1;
select pg_temp.login(:'arun');
set local role authenticated;
select save_consult_notes((select appointment_id from consultations where doctor_id = :'arun_doc' and status = 'draft' limit 1), '{"advice": "Walk daily"}');
reset role;
select pg_temp.expect_error('audit', 'final notes are locked', $q$update consultations set advice = 'x' where id = (select id from consultations where status = 'final' limit 1)$q$, 'notes_final');
select pg_temp.expect('audit', 'clinical text is redacted in the log', $q$select 1 from audit_logs where action = 'consultations.update' and after ->> 'advice' = '[redacted]' and actor_role = 'doctor'$q$, '=1');
select pg_temp.expect_error('audit', 'audit_logs cannot be edited (even by postgres)', 'update audit_logs set reason = ''x''', 'append-only');
select pg_temp.expect_error('audit', 'audit_logs cannot be deleted (even by postgres)', 'delete from audit_logs', 'append-only');
select pg_temp.expect_error('audit', 'finalised prescription is immutable', $q$update prescriptions set advice = 'changed' where status = 'final'$q$, 'prescription_immutable');

-- ---------------------------------------------------------------- report
reset role;
\o
select persona, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";   -- non-zero exit in CI
rollback;
