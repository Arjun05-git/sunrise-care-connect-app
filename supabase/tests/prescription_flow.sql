-- =============================================================================
-- Clinical notes + e-prescriptions: ICD-10 search, notes with diagnoses, templates, the drug-list rule
-- engine (List O / A / B / Prohibited × audio / video × first / follow-up), allergy / interaction
-- warnings, rule-checked drafts, signing PIN + signature, finalise & lock, unique Rx number,
-- verification (valid / superseded / not found), versioned addenda. Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/prescription_flow.sql
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
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal1')::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;
create function pg_temp.s(key text) returns text language sql as $$ select v from t_vars where k = key $$;
/** verdict field for one drug id in a check_rx_drugs result */
create function pg_temp.verdict(res jsonb, drug text) returns jsonb language sql as $$
  select e from jsonb_array_elements(res) e where e ->> 'drug_id' = drug $$;

\set rajan  '00000001-0000-4000-8000-0000000000c9'
\set arun   '00000001-0000-4000-8000-000000000064'
\set docuser 'aaaaaaaa-0000-4000-8000-000000000002'

insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'docuser', 'authenticated', 'authenticated', '919800000002', '{"full_name":"Dr. Rx Test"}', now(), now());
delete from user_roles where user_id = :'docuser';
insert into user_roles (user_id, role) values (:'docuser', 'doctor');
with d as (insert into doctors (profile_id, full_name, qualification, registration_no, registration_council, hospital_id, department_id, verification_status, modes)
           select :'docuser', 'Dr. Rx Test', 'MBBS, MD', 'TCMC-99999', 'Travancore-Cochin Medical Council', hospital_id, department_id, 'verified', '{video,audio}' from doctors limit 1 returning id)
insert into t_vars select 'doc', id::text from d;
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender, allergies) values (:'rajan', 'Meenakshi Rx Test', '1990-01-01', 'female', '{Penicillin}') returning id)
insert into t_vars select 'pt', id::text from x;

create function pg_temp.consult(p_offset int, p_key text, p_mode consult_mode, p_type consult_type, p_status appointment_status) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = pg_temp.v('doc');
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', 'booked') returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, doctor_joined_at, patient_joined_at)
  values ('RX-' || substr(md5(random()::text), 1, 8), pg_temp.v('pt'), '00000001-0000-4000-8000-0000000000c9', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes',
          p_mode, p_type, 500, p_status, case when p_status <> 'confirmed' then st end, case when p_status <> 'confirmed' then st end)
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  insert into appointment_symptoms (appointment_id, symptoms, severity, description, allergies) values (aid, '{}', 3, 'test', 'Sulfa drugs; none');
  insert into t_vars values (p_key, aid::text);
  return aid;
end $$;
select pg_temp.consult(-200, 'vfirst', 'video', 'first', 'in_progress');
select pg_temp.consult(-150, 'afirst', 'audio', 'first', 'in_progress');
select pg_temp.consult(-100, 'afu', 'audio', 'follow_up', 'completed');
select pg_temp.consult(120, 'conf', 'video', 'first', 'confirmed');

-- ================================================================ ICD-10
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('icd', 'description search: I10 in the top 5', $q$select bool_or(code = 'I10')::text from (select code from search_icd10('hypertension') limit 5) x$q$, 'true');
select pg_temp.expect_value('icd', 'code prefix search', $q$select string_agg(code, ',' order by code) from search_icd10('J06')$q$, 'J06.9');
select pg_temp.expect_value('icd', 'fuzzy (typo) search still finds it', $q$select bool_or(code = 'E11.9')::text from search_icd10('diabetis mellitus')$q$, 'true');
select pg_temp.expect_value('icd', 'one character → nothing; wildcards are inert', $q$select (select count(*) from search_icd10('h')) || '/' || (select count(*) from search_icd10('%%'))$q$, '0/0');

-- ================================================================ NOTES
select pg_temp.expect_value('notes', 'diagnoses are resolved from the ICD master (client text ignored), free text kept as provisional',
  $q$select (save_consult_notes(pg_temp.v('afirst'), '{"chief_complaint":"Fever","diagnoses":[{"code":"j06.9","description":"FAKE"},{"description":"Viral fever, provisional"}]}') is not null)::text$q$, 'true');
select pg_temp.expect_value('notes', '… stored as code + master description', $q$select diagnoses::text from consultations where appointment_id = pg_temp.v('afirst')$q$,
  '[{"code": "J06.9", "description": "Acute upper respiratory infection, unspecified"}, {"code": null, "description": "Viral fever, provisional"}]');
select pg_temp.expect_error('notes', 'unknown ICD code refused', $q$select save_consult_notes(pg_temp.v('afirst'), '{"diagnoses":["ZZZ.9"]}')$q$, 'invalid_diagnosis');
select pg_temp.expect_error('notes', 'more than 10 diagnoses refused', $q$select save_consult_notes(pg_temp.v('afirst'), jsonb_build_object('diagnoses', (select jsonb_agg(code) from (select code from icd10_master limit 11) x)))$q$, 'too_many_diagnoses');

-- ================================================================ TEMPLATES
select pg_temp.expect_value('templates', 'Sunrise templates visible to every doctor', $q$select (count(*) >= 9)::text from note_templates where doctor_id is null$q$, 'true');
select pg_temp.expect_value('templates', 'template diagnoses carry master descriptions', $q$select body -> 'diagnoses' -> 0 ->> 'code' from note_templates where name = 'Hypertension follow-up'$q$, 'I10');
insert into t_vars select 'tpl', save_note_template(null, 'My cough template', '{"chief_complaint":"Cough","diagnoses":["J06.9"],"evil":"x"}');
select pg_temp.expect_value('templates', 'own template saved, unknown keys dropped', $q$select (body ? 'evil')::text || '/' || (body -> 'diagnoses' -> 0 ->> 'description') from note_templates where id = pg_temp.v('tpl')$q$, 'false/Acute upper respiratory infection, unspecified');
select pg_temp.expect_error('templates', 'cannot write templates directly', $q$insert into note_templates (doctor_id, name) values (pg_temp.v('doc'), 'x')$q$, 'row-level security');
reset role;
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_value('templates', 'another doctor can''t see my template', $q$select count(*)::text from note_templates where id = pg_temp.v('tpl')$q$, '0');
select pg_temp.expect_error('templates', '… or delete it', $q$select delete_note_template(pg_temp.v('tpl'))$q$, 'not_found');
reset role;

-- ================================================================ RULE ENGINE
select pg_temp.login(:'docuser');
set local role authenticated;
-- drug-002 Paracetamol 650 (O) · Amoxicillin (A, penicillin) · Prednisolone (B) · Alprazolam (prohibited, narcotic)
insert into t_vars select 'amox', id from drug_master where name = 'Amoxicillin';
insert into t_vars select 'pred', id from drug_master where name = 'Prednisolone';
insert into t_vars select 'alpz', id from drug_master where name = 'Alprazolam';
insert into t_vars select 'ibu', id from drug_master where name = 'Ibuprofen';
insert into t_vars select 'warf', id from drug_master where name = 'Warfarin';
insert into t_vars select 'glic', id from drug_master where name = 'Gliclazide';
select pg_temp.expect_value('rules', 'List O allowed in an audio first consult', $q$select pg_temp.verdict(check_rx_drugs(pg_temp.v('afirst'), array['drug-002']), 'drug-002') ->> 'blocked'$q$, 'false');
select pg_temp.expect_value('rules', 'List A blocked in an audio first consult, with the rule and its note',
  $q$select (r ->> 'blocked') || '/' || (r -> 'reasons' -> 0 ->> 'code') || '/' || (r -> 'reasons' -> 0 ->> 'category') || '/' || (r -> 'reasons' -> 0 ->> 'mode') || '/' || (r -> 'reasons' -> 0 ->> 'consult_type') || '/' || ((r -> 'reasons' -> 0 ->> 'note') like 'List A:%')
     from (select pg_temp.verdict(check_rx_drugs(pg_temp.v('afirst'), array[pg_temp.s('amox')]), pg_temp.s('amox')) r) x$q$, 'true/list/A/audio/first/true');
select pg_temp.expect_value('rules', 'List A allowed by video (first) and in an audio follow-up',
  $q$select (pg_temp.verdict(check_rx_drugs(pg_temp.v('vfirst'), array[pg_temp.s('amox')]), pg_temp.s('amox')) ->> 'blocked') || '/' || (pg_temp.verdict(check_rx_drugs(pg_temp.v('afu'), array[pg_temp.s('amox')]), pg_temp.s('amox')) ->> 'blocked')$q$, 'false/false');
select pg_temp.expect_value('rules', 'List B blocked in a first consult (even video), allowed in a follow-up',
  $q$select (pg_temp.verdict(check_rx_drugs(pg_temp.v('vfirst'), array[pg_temp.s('pred')]), pg_temp.s('pred')) ->> 'blocked') || '/' || (pg_temp.verdict(check_rx_drugs(pg_temp.v('afu'), array[pg_temp.s('pred')]), pg_temp.s('pred')) ->> 'blocked')$q$, 'true/false');
select pg_temp.expect_value('rules', 'Prohibited + narcotic blocked even in a video follow-up, with both reasons',
  $q$select (r ->> 'blocked') || '/' || (select string_agg(x ->> 'code', ',' order by x ->> 'code') from jsonb_array_elements(r -> 'reasons') x)
     from (select pg_temp.verdict(check_rx_drugs(pg_temp.v('afu'), array[pg_temp.s('alpz')]), pg_temp.s('alpz')) r) y$q$, 'true/prohibited,schedule');
select pg_temp.expect_value('rules', 'allergy warning from the patient record (penicillin)',
  $q$select (r ->> 'blocked') || '/' || (r -> 'warnings' -> 0 ->> 'code') || '/' || (r -> 'warnings' -> 0 ->> 'allergy') from (select pg_temp.verdict(check_rx_drugs(pg_temp.v('vfirst'), array[pg_temp.s('amox')]), pg_temp.s('amox')) r) x$q$, 'false/allergy/penicillin');
select pg_temp.expect_value('rules', 'allergy warning from the pre-consult form ("Sulfa drugs; none")',
  $q$select pg_temp.verdict(check_rx_drugs(pg_temp.v('afu'), array[pg_temp.s('glic')]), pg_temp.s('glic')) -> 'warnings' -> 0 ->> 'allergy'$q$, 'sulfa drugs');
select pg_temp.expect_value('rules', 'interaction warning both ways (warfarin + ibuprofen)',
  $q$select (pg_temp.verdict(r, pg_temp.s('ibu')) -> 'warnings' -> 0 ->> 'key') || '/' || (pg_temp.verdict(r, pg_temp.s('warf')) -> 'warnings' -> 0 ->> 'with')
     from (select check_rx_drugs(pg_temp.v('afu'), array[pg_temp.s('ibu'), pg_temp.s('warf')]) r) x$q$, 'bleeding_nsaid/Ibuprofen');
select pg_temp.expect_value('rules', 'duplicate drug warned', $q$select pg_temp.verdict(check_rx_drugs(pg_temp.v('afu'), array['drug-002', 'drug-002']), 'drug-002') -> 'warnings' -> 0 ->> 'code'$q$, 'duplicate');
select pg_temp.expect_value('rules', 'search shows matches with their verdict', $q$select (e ->> 'name') || '/' || (e ->> 'blocked') from jsonb_array_elements(search_rx_drugs(pg_temp.v('afirst'), 'amoxic', '{}')) e limit 1$q$, 'Amoxicillin/true');
reset role;
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('rules', 'another doctor''s consultation can''t be checked', $q$select check_rx_drugs(pg_temp.v('afirst'), array['drug-002'])$q$, 'not_found');
reset role;
select pg_temp.login(:'docuser');
-- admin changes the rule matrix → the verdict follows
update drug_rules set allowed = true where category = 'A' and mode = 'audio' and consult_type = 'first';
set local role authenticated;
select pg_temp.expect_value('rules', 'admin rule change applies immediately', $q$select pg_temp.verdict(check_rx_drugs(pg_temp.v('afirst'), array[pg_temp.s('amox')]), pg_temp.s('amox')) ->> 'blocked'$q$, 'false');
reset role;
update drug_rules set allowed = false where category = 'A' and mode = 'audio' and consult_type = 'first';
select pg_temp.expect_error('rules', 'Prohibited can never be allowed (constraint)', $q$update drug_rules set allowed = true where category = 'prohibited'$q$, 'check constraint');

-- ================================================================ DRAFTS
set local role authenticated;
select pg_temp.expect_error('draft', 'no prescription before the consultation happens', $q$select save_rx_draft(pg_temp.v('conf'), '[]')$q$, 'rx_not_allowed');
select pg_temp.expect_error('draft', 'blocked drug refused by the server', $q$select save_rx_draft(pg_temp.v('afirst'), jsonb_build_array(jsonb_build_object('drug_id', pg_temp.s('amox'))))$q$, 'drug_blocked');
insert into t_vars select 'rx1', save_rx_draft(pg_temp.v('afirst'), '[{"drug_id":"drug-002","dose":"1 tablet","frequency":"TDS","duration":"5 days"},{"drug_id":"drug-004","dose":"1 sachet"}]') ->> 'id';
select pg_temp.expect_value('draft', 'allowed drugs saved with names / strengths from the master', $q$select string_agg(drug_name || ' ' || strength || ' ' || route, ' | ' order by position) from prescription_items where prescription_id = pg_temp.v('rx1')$q$, 'Paracetamol 650 650 mg Oral | ORS Sachet 21 g Oral');
select pg_temp.expect_value('draft', 'saving again replaces items, same draft', $q$select (save_rx_draft(pg_temp.v('afirst'), '[{"drug_id":"drug-002","dose":"1 tablet","frequency":"TDS","duration":"5 days","instructions":"After food"}]') ->> 'id') = pg_temp.s('rx1')$q$, 'true');
select pg_temp.expect_error('draft', 'no direct inserts (rules are checked in the RPC)', $q$insert into prescriptions (appointment_id, doctor_id, patient_id) values (pg_temp.v('vfirst'), pg_temp.v('doc'), pg_temp.v('pt'))$q$, 'row-level security');
select pg_temp.expect_error('draft', 'no direct item writes', $q$insert into prescription_items (prescription_id, drug_id, drug_name) values (pg_temp.v('rx1'), 'drug-101', 'Morphine')$q$, 'row-level security');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('draft', 'patient cannot see a draft', $q$select count(*)::text from prescriptions where id = pg_temp.v('rx1')$q$, '0');
reset role;

-- ================================================================ SIGN + FINALISE
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('sign', 'no signature on file → cannot finalise', $q$select finalize_prescription(pg_temp.v('rx1'), '123456')$q$, 'signature_missing');
reset role;
select record_signature(pg_temp.v('doc'));
set local role authenticated;
select pg_temp.expect_value('sign', 'no PIN yet', $q$select finalize_prescription(pg_temp.v('rx1'), '123456') ->> 'error'$q$, 'pin_not_set');
select pg_temp.expect_error('sign', 'weak PIN refused', $q$select set_signing_pin(null, '1111')$q$, 'pin_weak');
select pg_temp.expect_error('sign', 'PIN must be 4–6 digits', $q$select set_signing_pin(null, '12ab')$q$, 'pin_format');
select pg_temp.expect_value('sign', 'PIN set', $q$select set_signing_pin(null, '482916') ->> 'ok'$q$, 'true');
select pg_temp.expect_value('sign', 'changing the PIN needs the current one', $q$select set_signing_pin('000000', '582916') ->> 'error'$q$, 'pin_wrong');
select pg_temp.expect_value('sign', 'signing status', $q$select (s ->> 'pin_set') || '/' || (s ->> 'signature_updated_at' is not null) from (select signing_status() s) x$q$, 'true/true');
-- the version-1 diagnosis comes from the notes: clear it first to prove it is required
select save_consult_notes(pg_temp.v('afirst'), '{"chief_complaint":"Fever","diagnoses":[]}');
select pg_temp.expect_error('sign', 'a diagnosis is required', $q$select finalize_prescription(pg_temp.v('rx1'), '482916')$q$, 'diagnosis_required');
select save_consult_notes(pg_temp.v('afirst'), '{"chief_complaint":"Fever","diagnoses":["J06.9"],"advice":"Fluids, rest","investigations":"CBC","follow_up_date":"2030-01-05"}');
select pg_temp.expect_value('sign', 'wrong PIN → refused, attempts left', $q$select (r ->> 'error') || '/' || (r ->> 'attempts_left') from (select finalize_prescription(pg_temp.v('rx1'), '111222') r) x$q$, 'pin_wrong/3');
reset role;
select pg_temp.expect_value('sign', '… and the failed attempt is remembered (not rolled back)', $q$select failed_attempts::text from doctor_secrets where profile_id = '$q$ || :'docuser' || $q$'$q$, '2');
set local role authenticated;
insert into t_vars select 'fin1', finalize_prescription(pg_temp.v('rx1'), '482916')::text;
select pg_temp.expect_value('final', 'finalised with a unique Rx number and a 10-character verification code',
  $q$select (f ->> 'ok') || '/' || ((f ->> 'rx_no') ~ '^SCRX-\d{4}-\d{6}$') || '/' || ((f ->> 'verification_code') ~ '^[A-HJ-NP-Z2-9]{10}$') from (select pg_temp.s('fin1')::jsonb f) x$q$, 'true/true/true');
select pg_temp.expect_value('final', 'diagnosis / advice / follow-up snapshot from the notes; notes locked',
  $q$select (p.diagnoses -> 0 ->> 'code') || '/' || p.advice || '/' || p.follow_up_date || '/' || c.status from prescriptions p join consultations c on c.appointment_id = p.appointment_id where p.id = pg_temp.v('rx1')$q$, 'J06.9/Fluids, rest/2030-01-05/final');
select pg_temp.expect_value('final', 'doctor, patient and hospital snapshot', $q$select (doctor_snapshot ->> 'registration_no') || '/' || (patient_snapshot ->> 'name') || '/' || (hospital_snapshot ->> 'name' like 'Sunrise%') from prescriptions where id = pg_temp.v('rx1')$q$, 'TCMC-99999/Meenakshi Rx Test/true');
select pg_temp.expect_value('final', 'final prescription is locked (no update path for the doctor)', $q$with u as (update prescriptions set advice = 'changed' where id = pg_temp.v('rx1') returning 1) select count(*)::text from u$q$, '0');
reset role;
select pg_temp.expect_error('final', '… even for the database owner (trigger)', $q$update prescriptions set advice = 'changed' where id = pg_temp.v('rx1')$q$, 'prescription_immutable');
select pg_temp.expect_error('final', '… items too', $q$insert into prescription_items (prescription_id, drug_id, drug_name) values (pg_temp.v('rx1'), 'drug-002', 'x')$q$, 'prescription_immutable');
set local role authenticated;
select pg_temp.expect_error('final', 'saving the notes again is refused', $q$select save_consult_notes(pg_temp.v('afirst'), '{}')$q$, 'notes_final');
select pg_temp.expect_error('final', 'changes after finalising need an addendum', $q$select save_rx_draft(pg_temp.v('afirst'), '[]')$q$, 'use_addendum');
select pg_temp.expect_error('final', 'cannot finalise twice', $q$select finalize_prescription(pg_temp.v('rx1'), '482916')$q$, 'already_final');
reset role;
select pg_temp.expect_value('final', 'patient told (no clinical content)', $q$select (rendered_text not ilike '%paracetamol%' and rendered_text not ilike '%J06%')::text from notifications where template_key = 'prescription_ready' and user_id = '00000001-0000-4000-8000-0000000000c9' order by created_at desc limit 1$q$, 'true');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('final', 'patient now sees the final prescription and its items', $q$select count(*) || '/' || (select count(*) from prescription_items where prescription_id = pg_temp.v('rx1')) from prescriptions where id = pg_temp.v('rx1')$q$, '1/1');
reset role;

-- ================================================================ VERIFICATION (service only)
select pg_temp.expect_value('verify', 'valid: doctor + date only',
  $q$select (v ->> 'status') || '/' || (v ->> 'doctor') || '/' || (v ->> 'registration_no') || '/' || (v ? 'issued_at') || '/' || (select string_agg(k, ',' order by k) from jsonb_object_keys(v) k)
     from (select verify_prescription(lower(pg_temp.s('fin1')::jsonb ->> 'verification_code')) v) x$q$, 'valid/Dr. Rx Test/TCMC-99999/true/council,doctor,issued_at,registration_no,status');
select pg_temp.expect_value('verify', 'unknown code', $q$select verify_prescription('ZZZZZZZZZZ') ->> 'status'$q$, 'not_found');
set local role anon;
select pg_temp.expect_error('verify', 'anon cannot call the RPC directly (edge function only)', $q$select verify_prescription('x')$q$, 'permission denied');
reset role;
set local role authenticated;
select pg_temp.expect_error('verify', 'nor a signed-in user', $q$select rx_pdf_payload(pg_temp.v('rx1'))$q$, 'permission denied');
reset role;

-- ================================================================ ADDENDUM
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('addendum', 'reason required', $q$select start_addendum(pg_temp.v('rx1'), 'x')$q$, 'reason_required');
insert into t_vars select 'rx2', start_addendum(pg_temp.v('rx1'), 'Added ORS for dehydration');
select pg_temp.expect_value('addendum', 'version 2 draft copies items and fields', $q$select version || '/' || (select count(*) from prescription_items where prescription_id = p.id) || '/' || p.advice || '/' || (p.parent_prescription_id = pg_temp.v('rx1')) from prescriptions p where id = pg_temp.v('rx2')$q$, '2/1/Fluids, rest/true');
select pg_temp.expect_value('addendum', 'starting again returns the open addendum', $q$select (start_addendum(pg_temp.v('rx1'), 'another reason') = pg_temp.v('rx2'))::text$q$, 'true');
select pg_temp.expect_error('addendum', 'rules still apply in an addendum', $q$select save_rx_draft(pg_temp.v('afirst'), jsonb_build_array(jsonb_build_object('drug_id', pg_temp.s('amox'))))$q$, 'drug_blocked');
select save_rx_draft(pg_temp.v('afirst'), '[{"drug_id":"drug-002","dose":"1 tablet"},{"drug_id":"drug-004","dose":"1 sachet"}]', '{"diagnoses":["J06.9","A09"],"advice":"Fluids, rest, ORS","investigations":"","follow_up_date":""}');
insert into t_vars select 'fin2', finalize_prescription(pg_temp.v('rx2'), '482916')::text;
select pg_temp.expect_value('addendum', 'addendum numbered after the original', $q$select (pg_temp.s('fin2')::jsonb ->> 'rx_no') = (pg_temp.s('fin1')::jsonb ->> 'rx_no') || '-A1'$q$, 'true');
select pg_temp.expect_value('addendum', 'original stays final and unchanged', $q$select status || '/' || advice from prescriptions where id = pg_temp.v('rx1')$q$, 'final/Fluids, rest');
reset role;
select pg_temp.expect_value('addendum', 'old QR → superseded, new QR → valid',
  $q$select (verify_prescription(pg_temp.s('fin1')::jsonb ->> 'verification_code') ->> 'status') || '/' || (verify_prescription(pg_temp.s('fin2')::jsonb ->> 'verification_code') ->> 'status')$q$, 'superseded/valid');
select pg_temp.expect_value('addendum', 'PDF data names the original and the reason', $q$select (p ->> 'parent_rx_no' = pg_temp.s('fin1')::jsonb ->> 'rx_no') || '/' || (p ->> 'addendum_reason') || '/' || jsonb_array_length(p -> 'items') || '/' || (p -> 'diagnoses' -> 1 ->> 'code') from (select rx_pdf_payload(pg_temp.v('rx2')) p) x$q$, 'true/Added ORS for dehydration/2/A09');
set local role authenticated;
select pg_temp.expect_error('addendum', 'only the latest version can be amended', $q$select start_addendum(pg_temp.v('rx1'), 'late correction')$q$, 'not_latest');
insert into t_vars select 'rx3', start_addendum(pg_temp.v('rx2'), 'Third thoughts');
select discard_rx_draft(pg_temp.v('rx3'));
select pg_temp.expect_value('addendum', 'an unsigned addendum can be discarded', $q$select count(*)::text from prescriptions where id = pg_temp.v('rx3')$q$, '0');

-- ================================================================ PIN LOCKOUT
select save_rx_draft(pg_temp.v('vfirst'), '[{"drug_id":"drug-002"}]');
select save_consult_notes(pg_temp.v('vfirst'), '{"diagnoses":["I10"]}');
reset role;
insert into t_vars select 'rxv', id::text from prescriptions where appointment_id = pg_temp.v('vfirst') and status = 'draft';
set local role authenticated;
select finalize_prescription(pg_temp.v('rxv'), '000001'), finalize_prescription(pg_temp.v('rxv'), '000002'), finalize_prescription(pg_temp.v('rxv'), '000003'), finalize_prescription(pg_temp.v('rxv'), '000004');
select pg_temp.expect_value('lockout', '5th wrong PIN locks signing for 15 minutes', $q$select finalize_prescription(pg_temp.v('rxv'), '000005') ->> 'error'$q$, 'pin_locked');
select pg_temp.expect_value('lockout', 'even the right PIN is refused while locked', $q$select finalize_prescription(pg_temp.v('rxv'), '482916') ->> 'error'$q$, 'pin_locked');
reset role;

-- ================================================================ SEED
select pg_temp.expect_value('seed', 'seeded final prescriptions got Rx numbers and snapshots', $q$select count(*)::text from prescriptions where status = 'final' and (rx_no is null or doctor_snapshot is null)$q$, '0');

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
