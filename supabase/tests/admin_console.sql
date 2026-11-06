-- =============================================================================
-- Admin console rules: doctor onboarding + two-person registration verification, suspension (future
-- bookings cancelled for a doctor-side reason) and reinstatement; staff roles with guards; masters;
-- appointment monitor actions (cancel with chosen refund, move, outcome, extend); versioned consent
-- and legal content; support tickets; audit search; dashboard and reports (role limits, no patient
-- identity). Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/admin_console.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
create temp table t_vars (k text primary key, v text);
grant all on t_results, t_vars to authenticated, anon;
grant usage on sequence t_results_n_seq to authenticated, anon;
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
create function pg_temp.login(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;
create function pg_temp.put(key text, val text) returns void language sql as $$ insert into t_vars values (key, val) on conflict (k) do update set v = excluded.v $$;

\set admin   '00000001-0000-4000-8000-000000000001'
\set finance '00000001-0000-4000-8000-000000000002'
\set coord   '00000001-0000-4000-8000-000000000003'
\set anjali  '00000001-0000-4000-8000-0000000000c8'
\set admin2  'cccccccc-0000-4000-8000-000000000001'
\set newdoc  'cccccccc-0000-4000-8000-000000000002'
\set staffu  'cccccccc-0000-4000-8000-000000000003'
\set pu      'cccccccc-0000-4000-8000-000000000004'

-- fixtures: a second admin, a fresh phone login for the new doctor, an invited staff user, a patient
insert into auth.users (instance_id, id, aud, role, email, phone, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'admin2', 'authenticated', 'authenticated', 'admin2@sunrise.test', null, '{"full_name":"Second Admin"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'newdoc', 'authenticated', 'authenticated', null, '919800000201', '{"full_name":""}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'staffu', 'authenticated', 'authenticated', 'new.coordinator@sunrise.test', null, '{"full_name":"New Coordinator"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'pu', 'authenticated', 'authenticated', null, '919800000202', '{"full_name":"Meera Console"}', now(), now());
delete from user_roles where user_id = :'admin2';
insert into user_roles (user_id, role) values (:'admin2', 'admin');
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender, is_primary) values (:'pu', 'Meera Console', '1990-02-02', 'female', true) returning id)
insert into t_vars select 'pt', id::text from x;
insert into t_vars select 'hosp', hospital_id::text from doctors where verification_status = 'verified' limit 1;
insert into t_vars select 'dept', department_id::text from doctors where hospital_id = pg_temp.v('hosp') and verification_status = 'verified' limit 1;

-- two verified doctors (with logins) in one department for the monitor (made directly; onboarding is tested below)
insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-0000-4000-8000-000000000011', 'authenticated', 'authenticated', '919800000211', '{"full_name":"Dr. Monitor One"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-0000-4000-8000-000000000012', 'authenticated', 'authenticated', '919800000212', '{"full_name":"Dr. Monitor Two"}', now(), now());
update user_roles set role = 'doctor' where user_id in ('cccccccc-0000-4000-8000-000000000011', 'cccccccc-0000-4000-8000-000000000012');
with d as (insert into doctors (profile_id, full_name, phone, qualification, registration_no, registration_council, hospital_id, department_id, verification_status, modes)
           values ('cccccccc-0000-4000-8000-000000000011', 'Dr. Monitor One', '+919800000211', 'MBBS', 'TCMC/M1', 'TCMC', pg_temp.v('hosp'), pg_temp.v('dept'), 'verified', '{video,audio}'),
                  ('cccccccc-0000-4000-8000-000000000012', 'Dr. Monitor Two', '+919800000212', 'MBBS', 'TCMC/M2', 'TCMC', pg_temp.v('hosp'), pg_temp.v('dept'), 'verified', '{video}') returning id, full_name)
insert into t_vars select case when full_name like '%One' then 'm1' else 'm2' end, id::text from d;

-- booking for Meera with doctor p_doc at now() + p_offset minutes, optionally paid
create function pg_temp.book(p_doc uuid, p_offset int, p_key text, p_status appointment_status, p_paid int default 0) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = p_doc;
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', case when p_status = 'pending_payment' then 'held' else 'booked' end::slot_status) returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, hold_expires_at)
  values ('AC-' || substr(md5(random()::text), 1, 6), pg_temp.v('pt'), 'cccccccc-0000-4000-8000-000000000004', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes',
          'video', 'first', greatest(p_paid, 600), p_status, case when p_status = 'pending_payment' then now() + interval '10 minutes' end)
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  if p_paid > 0 then
    insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at)
    values (aid, 'mock', 'order_' || aid, 'pay_' || aid, p_paid, 'captured', now());
  end if;
  perform pg_temp.put(p_key, aid::text);
  return aid;
end $$;
create function pg_temp.open_slot(p_doc uuid, p_offset int, p_key text) returns uuid language plpgsql as $$
declare sid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  insert into slots (doctor_id, start_at, end_at, status) values (p_doc, st, st + interval '15 minutes', 'open') returning id into sid;
  perform pg_temp.put(p_key, sid::text);
  return sid;
end $$;

-- ================================================================ DOCTOR ONBOARDING & VERIFICATION
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('onboard', 'phone must be an Indian mobile', format($q$select admin_save_doctor(null, '{"full_name":"Dr. New Doc","phone":"12345","qualification":"MBBS, MD","registration_no":"TCMC/99","registration_council":"Travancore-Cochin Medical Council","hospital_id":"%s","department_id":"%s","modes":["video"]}', 'New cardiologist joining')$q$, pg_temp.v('hosp'), pg_temp.v('dept')), 'invalid_phone');
select pg_temp.expect_error('onboard', 'a reason is required', format($q$select admin_save_doctor(null, '{"full_name":"Dr. New Doc","phone":"+919800000201","qualification":"MBBS, MD","registration_no":"TCMC/99","registration_council":"Travancore-Cochin Medical Council","hospital_id":"%s","department_id":"%s","modes":["video"]}', '')$q$, pg_temp.v('hosp'), pg_temp.v('dept')), 'reason_required');
select pg_temp.put('doc', admin_save_doctor(null, jsonb_build_object('full_name', 'Dr. New Doc', 'phone', '+919800000201', 'qualification', 'MBBS, MD', 'registration_no', 'tcmc/99',
  'registration_council', 'Travancore-Cochin Medical Council', 'hospital_id', pg_temp.v('hosp'), 'department_id', pg_temp.v('dept'), 'modes', jsonb_build_array('video', 'audio'),
  'languages', jsonb_build_array('English', 'Malayalam'), 'experience_years', 8), 'New cardiologist joining')::text);
select pg_temp.expect_value('onboard', 'coordinator creates a draft (registration upper-cased, creator recorded)',
  $q$select verification_status || '/' || registration_no || '/' || (onboarded_by = auth.uid()) from doctors where id = pg_temp.v('doc')$q$, 'draft/TCMC/99/true');
select pg_temp.expect_error('onboard', 'cannot submit without a login', $q$select admin_submit_doctor(pg_temp.v('doc'))$q$, 'login_missing');
select pg_temp.expect_error('onboard', 'the service-only login link is not callable by staff', $q$select link_doctor_login(pg_temp.v('doc'), 'cccccccc-0000-4000-8000-000000000002', auth.uid())$q$, 'permission denied');
reset role;
select pg_temp.expect_error('onboard', 'a patient account with records cannot become a doctor login', format($q$select link_doctor_login(pg_temp.v('doc'), %L, %L)$q$, :'pu', :'coord'), 'phone_in_use');
select link_doctor_login(pg_temp.v('doc'), :'newdoc', :'coord');
select pg_temp.expect_value('onboard', 'login linked: doctor role only, name copied, audited with the coordinator',
  format($q$select (select string_agg(role::text, ',') from user_roles where user_id = %L) || '/' || (select full_name from profiles where id = %L) || '/' ||
           (select count(*) from audit_logs where action = 'doctors.login_linked' and actor_user_id = %L and entity_id = pg_temp.v('doc')::text)$q$, :'newdoc', :'newdoc', :'coord'),
  'doctor/Dr. New Doc/1');
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('onboard', 'cannot submit without a registration certificate', $q$select admin_submit_doctor(pg_temp.v('doc'))$q$, 'certificate_missing');
select pg_temp.expect_error('onboard', 'credential path must be <doctor>/<uuid>.<ext>', $q$select admin_add_doctor_credential(pg_temp.v('doc'), 'registration_certificate', 'x/../y.pdf', 'cert.pdf', 'application/pdf', 1000)$q$, 'invalid_path');
reset role;
insert into storage.objects (bucket_id, name) select 'doctor-credentials', pg_temp.v('doc') || '/11111111-2222-4333-8444-555555555555.pdf';
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_value('onboard', 'certificate recorded after upload', $q$select (admin_add_doctor_credential(pg_temp.v('doc'), 'registration_certificate', pg_temp.v('doc') || '/11111111-2222-4333-8444-555555555555.pdf', 'TCMC certificate.pdf', 'application/pdf', 120000) is not null)::text$q$, 'true');
select admin_submit_doctor(pg_temp.v('doc'));
select pg_temp.expect_value('onboard', 'submitted → pending (submitter recorded)', $q$select verification_status || '/' || (submitted_by = auth.uid()) from doctors where id = pg_temp.v('doc')$q$, 'pending/true');
select pg_temp.expect_error('verify', 'coordinators cannot verify', $q$select admin_verify_doctor(pg_temp.v('doc'), 'verified', 'Checked on the TCMC register')$q$, 'forbidden');
select pg_temp.expect_error('verify', 'staff cannot edit the doctor row directly',
  $q$update doctors set verification_status = 'verified' where id = pg_temp.v('doc')$q$, 'permission denied');
select pg_temp.expect_value('verify', 'pending doctor is not in the patient directory', $q$select count(*)::text from search_doctors() where id = pg_temp.v('doc')$q$, '0');
reset role;

-- an admin who onboarded and submitted a doctor themselves can't verify them
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.put('doc2', admin_save_doctor(null, jsonb_build_object('full_name', 'Dr. Self Check', 'phone', '+919800000203', 'qualification', 'MBBS', 'registration_no', 'TCMC/77',
  'registration_council', 'TCMC', 'hospital_id', pg_temp.v('hosp'), 'department_id', pg_temp.v('dept'), 'modes', jsonb_build_array('video')), 'Onboarding test doctor')::text);
reset role;
update doctors set verification_status = 'pending', submitted_by = :'admin' where id = pg_temp.v('doc2');
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_error('verify', 'two-person rule: the admin who onboarded / submitted cannot verify', $q$select admin_verify_doctor(pg_temp.v('doc2'), 'verified', 'Checked on the TCMC register')$q$, 'two_person_rule');
select pg_temp.expect_error('verify', 'a verification note is required', $q$select admin_verify_doctor(pg_temp.v('doc'), 'verified', 'ok')$q$, 'note_required');
select admin_verify_doctor(pg_temp.v('doc'), 'rejected', 'Registration number not found on the TCMC register');
select pg_temp.expect_value('verify', 'rejected with the reason', $q$select verification_status || '/' || rejection_reason from doctors where id = pg_temp.v('doc')$q$, 'rejected/Registration number not found on the TCMC register');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select admin_save_doctor(pg_temp.v('doc'), jsonb_build_object('full_name', 'Dr. New Doc', 'phone', '+919800000201', 'qualification', 'MBBS, MD', 'registration_no', 'TCMC/9900',
  'registration_council', 'Travancore-Cochin Medical Council', 'hospital_id', pg_temp.v('hosp'), 'department_id', pg_temp.v('dept'), 'modes', jsonb_build_array('video', 'audio')), 'Corrected registration number');
select admin_submit_doctor(pg_temp.v('doc'));
reset role;
select pg_temp.login(:'admin');
set local role authenticated;
select admin_verify_doctor(pg_temp.v('doc'), 'verified', 'Checked TCMC/9900 on the TCMC online register');
select pg_temp.expect_value('verify', 'a second admin verifies (verifier, time and note kept)', $q$select verification_status || '/' || (verified_by = auth.uid()) || '/' || (verified_at is not null) from doctors where id = pg_temp.v('doc')$q$, 'verified/true/true');
select pg_temp.expect_error('verify', 'registration is locked while verified', $q$select admin_save_doctor(pg_temp.v('doc'), jsonb_build_object('full_name', 'Dr. New Doc', 'phone', '+919800000201', 'qualification', 'MBBS, MD', 'registration_no', 'TCMC/1',
  'registration_council', 'Travancore-Cochin Medical Council', 'hospital_id', pg_temp.v('hosp'), 'department_id', pg_temp.v('dept'), 'modes', jsonb_build_array('video')), 'Typo in number')$q$, 'registration_locked');
select pg_temp.expect_value('verify', 'other details stay editable', $q$select admin_save_doctor(pg_temp.v('doc'), jsonb_build_object('full_name', 'Dr. New Doc', 'phone', '+919800000201', 'qualification', 'MBBS, MD, DM', 'registration_no', 'TCMC/9900',
  'registration_council', 'Travancore-Cochin Medical Council', 'hospital_id', pg_temp.v('hosp'), 'department_id', pg_temp.v('dept'), 'modes', jsonb_build_array('video')), 'Added DM') = pg_temp.v('doc')$q$, 'true');
select pg_temp.expect_value('verify', 'verification audited with the note', $q$select count(*)::text from audit_logs where entity = 'doctors' and entity_id = pg_temp.v('doc')::text and reason like 'Registration verified: Checked TCMC/9900%'$q$, '1');
reset role;

-- suspension
select pg_temp.book(pg_temp.v('doc'), 60 * 24, 'future', 'confirmed', 700);
select pg_temp.book(pg_temp.v('doc'), 60 * 25, 'hold', 'pending_payment');
select pg_temp.open_slot(pg_temp.v('doc'), 60 * 26, 'freeslot');
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('suspend', 'only admins suspend', $q$select admin_suspend_doctor(pg_temp.v('doc'), 'Registration lapsed')$q$, 'forbidden');
reset role;
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_value('suspend', 'suspension cancels future bookings and releases holds', $q$select admin_suspend_doctor(pg_temp.v('doc'), 'Registration lapsed on 26 Oct')::text$q$, '{"cancelled": 1, "holds_released": 1}');
reset role;
select pg_temp.expect_value('suspend', 'booking cancelled for a doctor-side reason (patient gets the choice)', $q$select status || '/' || outcome || '/' || outcome_reason from appointments where id = pg_temp.v('future')$q$, 'cancelled/cancelled_by_doctor/Doctor unavailable');
select pg_temp.expect_value('suspend', 'patient told via doctor_unavailable (no reason in the message)', $q$select count(*)::text from notifications where user_id = 'cccccccc-0000-4000-8000-000000000004' and template_key = 'doctor_unavailable' and channel = 'in_app' and rendered_text not ilike '%lapsed%'$q$, '1');
select pg_temp.expect_value('suspend', 'future open slots blocked', $q$select status::text from slots where id = pg_temp.v('freeslot')$q$, 'blocked');
select pg_temp.login(:'admin');
set local role authenticated;
select admin_reinstate_doctor(pg_temp.v('doc'), 'Renewed registration received');
select pg_temp.expect_value('suspend', 'reinstating needs verification again', $q$select verification_status from doctors where id = pg_temp.v('doc')$q$, 'pending');
select pg_temp.expect_error('suspend', 'the admin who reinstated cannot also verify', $q$select admin_verify_doctor(pg_temp.v('doc'), 'verified', 'Renewal checked on the register')$q$, 'two_person_rule');
reset role;
select pg_temp.login(:'admin2');
set local role authenticated;
select admin_verify_doctor(pg_temp.v('doc'), 'verified', 'Renewal checked on the register');
select pg_temp.expect_value('suspend', 'second admin re-verifies', $q$select verification_status || '/' || (suspended_at is null) from doctors where id = pg_temp.v('doc')$q$, 'verified/true');
reset role;

-- ================================================================ USERS & ROLES
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_error('roles', 'admins cannot change their own roles', format($q$select admin_set_staff_roles(%L, '{finance}', 'Testing self change')$q$, :'admin'), 'own_roles');
select pg_temp.expect_error('roles', 'only staff roles can be granted', format($q$select admin_set_staff_roles(%L, '{doctor}', 'Grant doctor role')$q$, :'staffu'), 'invalid_input');
select pg_temp.expect_error('roles', 'patients with records cannot be made staff', format($q$select admin_set_staff_roles(%L, '{coordinator}', 'Grant coordinator')$q$, :'anjali'), 'no_email');
select pg_temp.expect_error('roles', 'doctor logins cannot be made staff', format($q$select admin_set_staff_roles(%L, '{coordinator}', 'Grant coordinator')$q$, :'newdoc'), 'no_email');
select pg_temp.expect_error('roles', 'roles cannot be inserted directly', format($q$insert into user_roles (user_id, role) values (%L, 'admin')$q$, :'staffu'), 'permission denied');
select admin_set_staff_roles(:'staffu', '{coordinator,finance}', 'New support coordinator');
select pg_temp.expect_value('roles', 'staff roles set, patient role removed', format($q$select string_agg(role::text, ',' order by role::text) from user_roles where user_id = %L$q$, :'staffu'), 'coordinator,finance');
select pg_temp.expect_value('roles', 'staff list includes the new user', $q$select (admin_users('new.coord', 'staff') -> 'rows' -> 0 ->> 'email')$q$, 'new.coordinator@sunrise.test');
select admin_set_staff_roles(:'staffu', '{}', 'Left the support team');
select pg_temp.expect_value('roles', 'removing every role revokes access', format($q$select count(*)::text from user_roles where user_id = %L$q$, :'staffu'), '0');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('roles', 'coordinators cannot manage roles', format($q$select admin_set_staff_roles(%L, '{finance}', 'Promote')$q$, :'staffu'), 'forbidden');
select pg_temp.expect_error('roles', 'coordinators cannot list users', $q$select admin_users()$q$, 'forbidden');
reset role;

-- ================================================================ MASTERS
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_error('masters', 'a hospital with doctors cannot be deactivated', format($q$select admin_save_hospital(%L, '{"name":"Sunrise Test","city":"Kochi","phone":"+914842000100","emergency_phone":"+914842000101","active":false}', 'Closing branch')$q$, pg_temp.v('hosp')), 'in_use');
select pg_temp.put('newdept', admin_save_department(null, '{"name":"Nephrology","name_ml":"നെഫ്രോളജി","icon":"droplets"}', 'New speciality')::text);
select pg_temp.expect_value('masters', 'department created and deactivated (no doctors)', $q$select (admin_save_department(pg_temp.v('newdept'), '{"name":"Nephrology","name_ml":"നെഫ്രോളജി","icon":"droplets","active":false}', 'Not launching yet') = pg_temp.v('newdept'))::text$q$, 'true');
select pg_temp.expect_value('masters', 'holiday: existing bookings that day are reported',
  $q$select (admin_save_holiday(pg_temp.v('hosp'), ((now() at time zone 'Asia/Kolkata')::date + 1), 'Test holiday', 'Hospital closed for audit') ->> 'bookings_that_day')::int >= 0$q$, 'true');
select pg_temp.expect_error('masters', 'no duplicate holiday', $q$select admin_save_holiday(pg_temp.v('hosp'), ((now() at time zone 'Asia/Kolkata')::date + 1), 'Again', 'Hospital closed for audit')$q$, 'duplicate');
select pg_temp.expect_value('masters', 'drug saved (id normalised)', $q$select admin_save_drug('{"id":"Test-Para-500","name":"Testamol 500","generic_name":"Paracetamol","form":"Tablet","strength":"500 mg","category":"O","schedule":"OTC","interaction_groups":["Analgesic"]}', 'Formulary addition')$q$, 'test-para-500');
select pg_temp.expect_error('masters', 'a prohibited drug keeps its schedule rules (constraint)', $q$select admin_save_drug('{"id":"test-x","name":"Testozepam","generic_name":"Testozepam","category":"A","schedule":"X"}', 'Formulary addition')$q$, 'check constraint');
select admin_save_icd('Z99.9', 'Test dependence on enabling machine', true, 'New code');
select pg_temp.expect_value('masters', 'ICD code searchable while active', $q$select count(*)::text from search_icd10('Z99.9')$q$, '1');
select admin_save_icd('Z99.9', 'Test dependence on enabling machine', false, 'Retired code');
select pg_temp.expect_value('masters', 'inactive ICD code disappears from search', $q$select count(*)::text from search_icd10('Z99.9')$q$, '0');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('masters', 'coordinators cannot edit masters', $q$select admin_save_icd('Z99.8', 'Test code', true, 'New code')$q$, 'forbidden');
reset role;

-- ================================================================ APPOINTMENT MONITOR
select pg_temp.book(pg_temp.v('m1'), 60 * 30, 'c1', 'confirmed', 800);
select pg_temp.book(pg_temp.v('m1'), 60 * 31, 'c2', 'confirmed', 800);
select pg_temp.book(pg_temp.v('m1'), 60 * 32, 'c3', 'confirmed', 800);
select pg_temp.book(pg_temp.v('m1'), 60 * 33, 'mv', 'confirmed', 800);
select pg_temp.book(pg_temp.v('m1'), -20, 'late', 'confirmed', 800);
select pg_temp.book(pg_temp.v('m1'), -40, 'late2', 'confirmed', 800);
update appointments set doctor_joined_at = start_at + interval '1 minute' where id = pg_temp.v('late2');
select pg_temp.open_slot(pg_temp.v('m2'), 60 * 34, 'm2slot');
select pg_temp.open_slot(pg_temp.v('m1'), 60 * 35, 'm1slot');
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('monitor', 'coordinators may only cancel with a full refund', $q$select admin_cancel_appointment(pg_temp.v('c1'), 'policy', 'Patient asked by phone')$q$, 'full_refund_only');
select pg_temp.expect_value('monitor', 'coordinator cancels with a full refund', $q$select admin_cancel_appointment(pg_temp.v('c1'), 'full', 'Patient asked by phone') ->> 'refund_amount'$q$, '800');
select pg_temp.expect_value('monitor', 'late booking flagged: doctor not joined',
  $q$select (select r -> 'attention' from jsonb_array_elements(admin_appointments(jsonb_build_object('from', (now() at time zone 'Asia/Kolkata')::date - 1, 'to', (now() at time zone 'Asia/Kolkata')::date + 3)) -> 'rows') r where r ->> 'id' = pg_temp.v('late')::text)::text$q$, '["doctor_not_joined"]');
reset role;
select pg_temp.expect_value('monitor', 'cancelled by Sunrise: patient and doctor told, refund queued',
  $q$select (select count(*) from notifications where appointment_id = pg_temp.v('c1') and template_key in ('cancelled', 'doctor_booking_cancelled') and channel = 'in_app') || '/' ||
           (select amount || ':' || status from refunds where appointment_id = pg_temp.v('c1'))$q$, '2/800:initiated');
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_value('monitor', 'finance cancels with no refund', $q$select admin_cancel_appointment(pg_temp.v('c2'), 'none', 'Duplicate booking, refunded at the counter') ->> 'refund_amount'$q$, '0');
select pg_temp.expect_value('monitor', 'policy refund follows the patient cancellation tiers', $q$select admin_cancel_appointment(pg_temp.v('c3'), 'policy', 'Patient cancelled by phone, policy applies') ->> 'refund_amount'$q$, '800');   -- 32 h ahead: 100 % tier
select pg_temp.expect_error('monitor', 'finance cannot move bookings', $q$select admin_move_appointment(pg_temp.v('mv'), pg_temp.v('m2slot'), 'Doctor on leave')$q$, 'forbidden');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_value('monitor', 'move options include the department colleague', $q$select (admin_move_options(pg_temp.v('mv'), true) @> jsonb_build_array(jsonb_build_object('slot_id', pg_temp.v('m2slot'))))::text$q$, 'true');
select pg_temp.put('moved', admin_move_appointment(pg_temp.v('mv'), pg_temp.v('m2slot'), 'Dr. Monitor One on leave')::text);
reset role;
select pg_temp.expect_value('monitor', 'moved to another doctor: same reference and fee, payment follows',
  $q$select (n.doctor_id = pg_temp.v('m2'))::text || '/' || (n.ref_code = split_part(o.ref_code, '-R', 1))::text || '/' || n.fee_amount || '/' || (select count(*) from payments where appointment_id = n.id)
       from appointments n join appointments o on o.id = pg_temp.v('mv') where n.id = pg_temp.v('moved')$q$, 'true/true/800/1');
select pg_temp.expect_value('monitor', 'patient, old and new doctor are told',
  $q$select string_agg(distinct template_key, ',' order by template_key) from notifications where channel = 'in_app' and template_key <> 'booking_confirmed' and (appointment_id in (pg_temp.v('mv'), pg_temp.v('moved')))$q$,
  'doctor_booking_cancelled,doctor_new_booking,rescheduled');
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('monitor', 'outcome cannot be recorded before the start', $q$select admin_record_outcome(pg_temp.v('moved'), 'completed', 'Called the doctor')$q$, 'too_early');
select pg_temp.expect_value('monitor', 'doctor no-show by hand → patient gets the choice', $q$select admin_record_outcome(pg_temp.v('late'), 'doctor_no_show', 'Doctor unreachable, confirmed by phone') ->> 'status'$q$, 'cancelled');
select pg_temp.expect_value('monitor', 'join window extended (+20)', $q$select admin_extend_window(pg_temp.v('late2'), 20, 'Call running late')::text$q$, '20');
select pg_temp.expect_error('monitor', 'extension capped at 60 minutes', $q$select admin_extend_window(pg_temp.v('late2'), 30, 'Call running late') + admin_extend_window(pg_temp.v('late2'), 30, 'Call running late')$q$, 'extension_limit');
select pg_temp.expect_value('monitor', 'patient no-show by hand', $q$select admin_record_outcome(pg_temp.v('late2'), 'patient_no_show', 'Patient unreachable on phone') ->> 'status'$q$, 'no_show');
reset role;

-- ================================================================ CONTENT
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_value('content', 'wording fix keeps the version (revision 2)',
  $q$select admin_publish_content('terms', '', '', 'I agree to the Terms of Use, the Refund Policy and the Privacy Notice of Sunrise Care Connect.', (select body_ml from content_versions where key = 'terms' limit 1), false, 'Comma fix') ->> 'revision'$q$, '2');
select pg_temp.expect_value('content', '… consent text updated, version unchanged (no re-consent)',
  $q$select (select value ->> 'terms' from app_settings where key = 'consent_versions') || '/' || (select (value -> 'terms' ->> 'en') like 'I agree to the Terms of Use, the Refund%' from app_settings where key = 'consent_texts')$q$, '1.0/true');
select pg_temp.expect_error('content', 'nothing changed → refused', $q$select admin_publish_content('terms', '', '', 'I agree to the Terms of Use, the Refund Policy and the Privacy Notice of Sunrise Care Connect.', (select body_ml from content_versions where key = 'terms' limit 1), false, 'Again')$q$, 'no_change');
select pg_temp.expect_value('content', 'material change → version 2.0, patients asked again',
  $q$select (r ->> 'version') || '/' || (r ->> 'reconsent') from
     (select admin_publish_content('terms', '', '', 'I agree to the new Terms of Use, Refund Policy and Privacy Notice of Sunrise Care Connect.', 'പുതിയ ഉപയോഗ നിബന്ധനകൾ ഞാൻ അംഗീകരിക്കുന്നു.', true, 'New refund terms') r) x$q$, '2.0/true');
select pg_temp.expect_value('content', '… and the consent version patients must accept is 2.0', $q$select value ->> 'terms' from app_settings where key = 'consent_versions'$q$, '2.0');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('content', 'coordinators cannot publish', $q$select admin_publish_content('privacy_notice', 'Privacy', 'സ്വകാര്യത', 'Some new privacy text here.', 'പുതിയ സ്വകാര്യതാ വാചകം ഇവിടെ.', false, 'Update')$q$, 'forbidden');
reset role;
set local role anon;
select pg_temp.expect_value('content', 'published text is public (latest version, no publisher id)', $q$select (public_content('terms') ->> 'version') || '/' || (public_content('terms') ? 'published_by')::text$q$, '2.0/false');
reset role;

-- ================================================================ SUPPORT TICKETS
select pg_temp.login(:'pu');
set local role authenticated;
select pg_temp.put('tkt', create_ticket('payment', 'Charged twice for my booking', 'I see two debits of Rs 800 for the same consultation.')::text);
select pg_temp.expect_error('tickets', 'users cannot write internal notes', $q$select post_ticket_message(pg_temp.v('tkt'), 'note', true)$q$, 'forbidden');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select post_ticket_message(pg_temp.v('tkt'), 'Checked with the bank: second debit is a hold, released in 3 days.', true);
select post_ticket_message(pg_temp.v('tkt'), 'The second amount is a temporary hold and will be released within 3 working days.', false);
select pg_temp.expect_value('tickets', 'first reply → in progress, response time stamped', $q$select status || '/' || (first_response_at is not null) from support_tickets where id = pg_temp.v('tkt')$q$, 'in_progress/true');
select pg_temp.expect_error('tickets', 'resolving needs a resolution', $q$select admin_update_ticket(pg_temp.v('tkt'), 'resolved', auth.uid(), '')$q$, 'resolution_required');
select admin_update_ticket(pg_temp.v('tkt'), 'resolved', auth.uid(), 'Bank hold explained; no double charge.');
select pg_temp.expect_value('tickets', 'staff list shows the ticket with its owner', $q$select (admin_tickets('{"q":"Charged twice"}') -> 'rows' -> 0 ->> 'user_name')$q$, 'Meera Console');
reset role;
select pg_temp.login(:'pu');
set local role authenticated;
select pg_temp.expect_value('tickets', 'the user sees the reply but never the internal note', $q$select count(*)::text from ticket_messages where ticket_id = pg_temp.v('tkt')$q$, '1');
select post_ticket_message(pg_temp.v('tkt'), 'Still not released after 5 days.');
select pg_temp.expect_value('tickets', 'a user reply reopens a resolved ticket', $q$select status from support_tickets where id = pg_temp.v('tkt')$q$, 'open');
select pg_temp.expect_error('tickets', 'tickets cannot be updated directly', $q$select admin_update_ticket(pg_temp.v('tkt'), 'closed', null, 'Closing myself')$q$, 'forbidden');
reset role;
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_value('tickets', 'another user cannot read the conversation', $q$select count(*)::text from ticket_messages where ticket_id = pg_temp.v('tkt')$q$, '0');
reset role;
select pg_temp.expect_value('tickets', 'staff replies notify the user (ticket_update)', $q$select count(*)::text from notifications where user_id = 'cccccccc-0000-4000-8000-000000000004' and template_key = 'ticket_update' and channel = 'in_app'$q$, '2');

-- ================================================================ AUDIT, DASHBOARD, REPORTS
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('audit', 'coordinators cannot read the audit log', $q$select admin_audit('{}')$q$, 'forbidden');
select pg_temp.expect_error('reports', 'coordinators cannot see revenue', $q$select admin_report('revenue', current_date - 7, current_date)$q$, 'forbidden');
select pg_temp.expect_value('reports', 'coordinator dashboard hides money', $q$select (admin_dashboard(14) -> 'today' ->> 'revenue') is null and admin_dashboard(14) ->> 'month_revenue' is null$q$, 'true');
reset role;
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_error('reports', 'finance cannot see notification delivery', $q$select admin_report('notifications', current_date - 7, current_date)$q$, 'forbidden');
select pg_temp.expect_value('reports', 'revenue report: one row per day, net = gross − processed refunds',
  $q$select count(*) || '/' || bool_and((r ->> 'net')::int = (r ->> 'gross')::int - (r ->> 'refunds_processed')::int) from jsonb_array_elements(admin_report('revenue', current_date - 6, current_date)) r$q$, '7/true');
reset role;
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_value('audit', 'audit search by reason finds the verification', $q$select (admin_audit(jsonb_build_object('q', 'Checked TCMC/9900')) ->> 'total')::int >= 1$q$, 'true');
select pg_temp.expect_value('reports', 'appointment report rows carry no patient identity',
  $q$select count(*)::text from jsonb_array_elements(admin_report('appointments', (now() at time zone 'Asia/Kolkata')::date - 1, (now() at time zone 'Asia/Kolkata')::date + 3)) r where r ? 'patient_name' or r ? 'patient_id' or r::text like '%Meera Console%' or r::text like '%9800000202%'$q$, '0');
select pg_temp.expect_value('reports', 'no-show report counts the hand-recorded outcomes',
  $q$select (r ->> 'patient_no_show') || '/' || (r ->> 'doctor_no_show') from jsonb_array_elements(admin_report('no_shows', (now() at time zone 'Asia/Kolkata')::date - 1, (now() at time zone 'Asia/Kolkata')::date)) r where r ->> 'doctor' = 'Dr. Monitor One'$q$, '1/1');
select pg_temp.expect_error('reports', 'range limited to a year', $q$select admin_report('appointments', current_date - 400, current_date)$q$, 'invalid_range');
select pg_temp.expect_value('reports', 'every report kind answers', $q$select count(*)::text from unnest(array['appointments','revenue','no_shows','utilisation','follow_ups','notifications']) k where jsonb_typeof(admin_report(k, current_date - 30, current_date)) = 'array'$q$, '6');
select pg_temp.expect_value('dashboard', 'pending verifications counted', $q$select (admin_dashboard(14) ->> 'pending_verifications')::int >= 1$q$, 'true');
reset role;

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
