-- =============================================================================
-- Security regressions (docs/SECURITY.md): every bypass found in the ASVS / MASVS review stays closed.
--   direct writes to RPC-owned tables · consultation notes for unrelated patients · audit-log forgery ·
--   anon function surface · document detach / delete after a consultation · document registration rules ·
--   storage reads of unregistered files · staff MFA (aal2) · admin-only settings. Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/security_hardening.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
create temp table t_vars (k text primary key, v text);
grant all on t_results, t_vars to authenticated, anon, service_role;
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
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;

\set anjali '00000001-0000-4000-8000-0000000000c8'
\set rajan  '00000001-0000-4000-8000-0000000000c9'
\set pt     '00000005-0000-4000-8000-000000000001'
\set pt2    '00000005-0000-4000-8000-000000000002'
\set admin  '00000001-0000-4000-8000-000000000001'
\set arun   '00000001-0000-4000-8000-000000000064'

-- fixtures: a completed consultation of Anjali's with a registered file, a loose file, an unregistered upload
insert into t_vars select 'done', a.id::text from appointments a where a.patient_id = :'pt' and a.status = 'completed' limit 1;
insert into t_vars select 'other_pt', p.id::text from patients p
  where not exists (select 1 from appointments a join doctors d on d.id = a.doctor_id where a.patient_id = p.id and d.profile_id = :'arun') limit 1;
insert into t_vars select 'arun_appt', a.id::text from appointments a join doctors d on d.id = a.doctor_id
  where d.profile_id = :'arun' and not exists (select 1 from consultations c where c.appointment_id = a.id) limit 1;
insert into documents (id, patient_id, uploaded_by, tag, file_name, mime_type, size_bytes, storage_path, appointment_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', :'pt', :'anjali', 'lab_report', 'cbc.pdf', 'application/pdf', 1000, 'patients/' || :'pt' || '/aaaaaaaa-0000-4000-8000-000000000001.pdf', pg_temp.v('done')),
  ('aaaaaaaa-0000-4000-8000-000000000002', :'pt', :'anjali', 'photo', 'rash.jpg', 'image/jpeg', 1000, 'patients/' || :'pt' || '/aaaaaaaa-0000-4000-8000-000000000002.jpg', null);
insert into storage.objects (bucket_id, name) values
  ('medical-documents', 'patients/' || :'pt' || '/aaaaaaaa-0000-4000-8000-000000000001.pdf'),
  ('medical-documents', 'patients/' || :'pt' || '/aaaaaaaa-0000-4000-8000-000000000002.jpg'),
  ('medical-documents', 'patients/' || :'pt' || '/aaaaaaaa-0000-4000-8000-000000000003.pdf'),   -- uploaded, never registered
  ('medical-documents', 'patients/' || :'pt' || '/bbbbbbbb-0000-4000-8000-000000000004.png');
grant select, delete on storage.objects to authenticated;

-- ---------------------------------------------------------------- patient: direct writes closed
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_error('patient', 'cannot set the HIS MRN on a profile', $q$update patients set his_mrn = 'SUN999999' where id = '00000005-0000-4000-8000-000000000001'$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot mark an ABHA verified without the OTP', $q$update patients set abha_number = '11-1111-1111-1111', abha_verified_at = now() where id = '00000005-0000-4000-8000-000000000001'$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot change the phone on their profile', $q$update profiles set phone = '+919999999999' where id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot rewrite consent versions or dates', $q$update consents set version = '9.9' where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot insert a consent row directly', $q$insert into consents (user_id, consent_type, version, granted) values (auth.uid(), 'marketing', '1.0', true)$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot tamper with notification status', $q$update notifications set status = 'failed' where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot insert a document row directly', $q$insert into documents (patient_id, uploaded_by, tag, file_name, mime_type, size_bytes, storage_path) values ('00000005-0000-4000-8000-000000000001', auth.uid(), 'other', 'x.pdf', 'application/pdf', 1, 'patients/x/y.pdf')$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot detach a file from a finished consultation', $q$update documents set appointment_id = null where id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 'permission denied');
select pg_temp.expect_value('patient', 'cannot delete a file of a finished consultation', $q$with d as (delete from documents where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning 1) select count(*)::text from d$q$, '0');
select pg_temp.expect_value('patient', '… nor its stored object', $q$with d as (delete from storage.objects where name like '%aaaaaaaa-0000-4000-8000-000000000001.pdf' returning 1) select count(*)::text from d$q$, '0');
select pg_temp.expect_value('patient', 'a loose file can still be removed (row, then object)', $q$with d as (delete from documents where id = 'aaaaaaaa-0000-4000-8000-000000000002' returning 1) select count(*)::text from d$q$, '1');
select pg_temp.expect_value('patient', 'save_patient (the RPC) still edits the profile', $q$select (save_patient('00000005-0000-4000-8000-000000000001', 'Anjali Menon', '1988-12-04', 'female', null, 'O+', '{}', null, null, 'Kakkanad, Kochi, Kerala') is not null)::text$q$, 'true');
select pg_temp.expect_value('patient', 'their own uploads (registered or not) stay readable to them', $q$select count(*)::text from storage.objects where name like 'patients/00000005-0000-4000-8000-000000000001/aaaaaaaa%'$q$, '3');
select pg_temp.expect_error('patient', 'cannot write audit entries', $q$select write_audit('forged', 'patients', 'x', null, null, 'nothing to see')$q$, 'permission denied');
select pg_temp.expect_error('patient', 'cannot call the internal settings reader', $q$select setting('integrations')$q$, 'permission denied');
select pg_temp.expect_value('patient', 'HIS doctor-sync summary hidden', $q$select count(*)::text from app_settings where key = 'his_doctor_sync'$q$, '0');
select pg_temp.expect_error('patient', 'cannot register a document (service only)', $q$select register_document(gen_random_uuid(), '00000005-0000-4000-8000-000000000001', auth.uid(), 'other', 'x', 'application/pdf', 10, 'x')$q$, 'permission denied');
reset role;

-- ---------------------------------------------------------------- doctor: notes only through the RPC
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('doctor', 'cannot write a FINAL note for an unrelated patient', format($q$insert into consultations (appointment_id, doctor_id, patient_id, status) values (%L, my_doctor_id(), %L, 'final')$q$, pg_temp.v('arun_appt'), pg_temp.v('other_pt')), 'permission denied');
select pg_temp.expect_error('doctor', 'cannot update notes directly', $q$update consultations set status = 'draft' where doctor_id = my_doctor_id()$q$, 'permission denied');
select pg_temp.expect_value('doctor', 'still reads their own notes', $q$select (count(*) > 0)::text from consultations where doctor_id = my_doctor_id()$q$, 'true');
select pg_temp.expect_value('doctor', 'sees registered files of their patient, not raw uploads', $q$select count(*)::text from storage.objects where name like 'patients/00000005-0000-4000-8000-000000000001/%'$q$, '1');
reset role;

-- ---------------------------------------------------------------- anon surface
set local role anon;
select pg_temp.expect_error('anon', 'cannot write audit entries', $q$select write_audit('forged', 'x', 'x', null, null, null)$q$, 'permission denied');
select pg_temp.expect_value('anon', 'can read published legal text', $q$select (public_content('terms_of_use') is not null)::text$q$, 'true');
reset role;
select pg_temp.expect_value('anon', 'public_content is the only function anon can run', $q$
  select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')$q$, 'public_content');

-- ---------------------------------------------------------------- register_document (service role, after the byte check)
select pg_temp.expect_value('docs', 'registers a checked file with server-side type and size', $q$select tag || '/' || mime_type || '/' || size_bytes from register_document('bbbbbbbb-0000-4000-8000-000000000004', '00000005-0000-4000-8000-000000000001', '00000001-0000-4000-8000-0000000000c8', 'photo', 'scan.png', 'image/png', 2048, 'patients/00000005-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000004.png')$q$, 'photo/image/png/2048');
select pg_temp.expect_error('docs', 'path must be patients/<patient>/<document>.<ext>', $q$select register_document('bbbbbbbb-0000-4000-8000-000000000005', '00000005-0000-4000-8000-000000000001', '00000001-0000-4000-8000-0000000000c8', 'photo', 'x', 'image/png', 10, 'patients/00000005-0000-4000-8000-000000000002/bbbbbbbb-0000-4000-8000-000000000005.png')$q$, 'invalid_path');
select pg_temp.expect_error('docs', 'only for the caller''s own family or a treating doctor', $q$select register_document('bbbbbbbb-0000-4000-8000-000000000006', '00000005-0000-4000-8000-000000000002', '00000001-0000-4000-8000-0000000000c8', 'photo', 'x', 'image/png', 10, 'patients/00000005-0000-4000-8000-000000000002/bbbbbbbb-0000-4000-8000-000000000006.png')$q$, 'forbidden');
select pg_temp.expect_error('docs', 'the uploaded object must exist', $q$select register_document('bbbbbbbb-0000-4000-8000-000000000007', '00000005-0000-4000-8000-000000000001', '00000001-0000-4000-8000-0000000000c8', 'photo', 'x', 'image/png', 10, 'patients/00000005-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000007.png')$q$, 'file_missing');
select pg_temp.expect_error('docs', 'only PDF / JPEG / PNG', $q$select register_document('bbbbbbbb-0000-4000-8000-000000000008', '00000005-0000-4000-8000-000000000001', '00000001-0000-4000-8000-0000000000c8', 'photo', 'x', 'text/html', 10, 'x')$q$, 'type_not_allowed');
select pg_temp.expect_error('docs', 'at most 10 MB', $q$select register_document('bbbbbbbb-0000-4000-8000-000000000009', '00000005-0000-4000-8000-000000000001', '00000001-0000-4000-8000-0000000000c8', 'photo', 'x', 'image/png', 10485761, 'x')$q$, 'size');

-- ---------------------------------------------------------------- staff MFA
insert into app_settings (key, value) values ('staff_mfa_required', 'true') on conflict (key) do update set value = excluded.value;
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('mfa', 'MFA required: an admin with only a password is refused', $q$select admin_dashboard()$q$, 'forbidden');
select pg_temp.expect_value('mfa', '… and reads no audit log', $q$select count(*)::text from audit_logs$q$, '0');
reset role;
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_value('mfa', 'after the TOTP code (aal2) the console works', $q$select (admin_dashboard() is not null)::text$q$, 'true');
reset role;
delete from app_settings where key = 'staff_mfa_required';
select set_config('app.environment', 'production', true);   -- this database is a seeded demo database; this check is about production
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('mfa', 'production without the setting (no seed) = required', $q$select admin_dashboard()$q$, 'forbidden');
reset role;
select set_config('app.environment', 'demo', true);
insert into app_settings (key, value) values ('staff_mfa_required', 'false');
insert into auth.mfa_factors (id, user_id, status) values (gen_random_uuid(), :'admin', 'verified');
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('mfa', 'not required, but a staff member who enrolled must still use it', $q$select admin_dashboard()$q$, 'forbidden');
reset role;

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
