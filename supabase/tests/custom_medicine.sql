-- =============================================================================
-- Custom medicines (phase 10): a doctor can add a medicine that is not in the catalogue, without weakening the
-- prescribing rules. Server-side guard (a name that matches a catalogue medicine must use the catalogue entry, or the
-- List O / A / B / Prohibited rules could be bypassed by retyping it), explicit acknowledgement before signing, the
-- medicine really appears on the printed prescription, addenda keep it, admins can review what is being used.
-- The catalogue flow itself is covered by prescription_flow.sql and must stay green. Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/custom_medicine.sql
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
create function pg_temp.login(uid text, aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;
create function pg_temp.s(key text) returns text language sql as $$ select v from t_vars where k = key $$;

\set rajan   '00000001-0000-4000-8000-0000000000c9'
\set arun    '00000001-0000-4000-8000-000000000064'
\set admin   '00000001-0000-4000-8000-000000000001'
\set coord   '00000001-0000-4000-8000-000000000003'
\set docuser 'aaaaaaaa-0000-4000-8000-000000000005'

-- a doctor of our own, a patient allergic to penicillin, two consultations in progress (audio first / video first)
insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'docuser', 'authenticated', 'authenticated', '919800000005', '{"full_name":"Dr. Custom Test"}', now(), now());
delete from user_roles where user_id = :'docuser';
insert into user_roles (user_id, role) values (:'docuser', 'doctor');
with d as (insert into doctors (profile_id, full_name, qualification, registration_no, registration_council, hospital_id, department_id, verification_status, modes)
           select :'docuser', 'Dr. Custom Test', 'MBBS, MD', 'TCMC-99995', 'Travancore-Cochin Medical Council', hospital_id, department_id, 'verified', '{video,audio}' from doctors limit 1 returning id)
insert into t_vars select 'doc', id::text from d;
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender, allergies) values (:'rajan', 'Custom Rx Test', '1990-01-01', 'female', '{Penicillin}') returning id)
insert into t_vars select 'pt', id::text from x;

create function pg_temp.consult(p_offset int, p_key text, p_mode consult_mode) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = pg_temp.v('doc');
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', 'booked') returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, doctor_joined_at, patient_joined_at)
  values ('CM-' || substr(md5(random()::text), 1, 8), pg_temp.v('pt'), '00000001-0000-4000-8000-0000000000c9', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes',
          p_mode, 'first', 500, 'in_progress', st, st)
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  insert into appointment_symptoms (appointment_id, symptoms, severity, description, allergies) values (aid, '{}', 3, 'test', 'none');
  insert into t_vars values (p_key, aid::text);
  return aid;
end $$;
select pg_temp.consult(-200, 'video', 'video');
select pg_temp.consult(-150, 'audio', 'audio');
-- an appointment of another doctor, to prove ownership is enforced
insert into t_vars select 'other', a.id::text from appointments a join doctors d on d.id = a.doctor_id where d.profile_id = :'arun' limit 1;
insert into t_vars select 'amox', id from drug_master where name = 'Amoxicillin';

-- the demo seed runs in 'direct' mode; sections A-F test the strict (production default) mode, section G the direct one
insert into app_settings (key, value) values ('custom_medicine_mode', '"checked"') on conflict (key) do update set value = excluded.value;

-- ================================================================ A. check_custom_medicine (what the "add manually" dialog asks first)
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('check', 'a medicine that is not in the catalogue is accepted',
  $q$select (r ->> 'ok') || '/' || coalesce(r ->> 'code', 'none') || '/' || (r -> 'match')::text from (select check_custom_medicine(pg_temp.v('audio'), 'Arnica Herbal Gel') r) x$q$, 'true/none/null');
select pg_temp.expect_value('check', 'ordinary dose-form words do not count as a match ("syrup", "tablets", "vitamin")',
  $q$select (check_custom_medicine(pg_temp.v('audio'), 'Herbal cough syrup') ->> 'ok') || '/' || (check_custom_medicine(pg_temp.v('audio'), 'Vitamin B12 tablets') ->> 'ok')$q$, 'true/true');
select pg_temp.expect_value('check', 'the exact catalogue name is refused, naming the catalogue entry',
  $q$select (r ->> 'ok') || '/' || (r ->> 'code') || '/' || (r -> 'match' ->> 'name') || '/' || (r -> 'match' ->> 'drug_id' = pg_temp.s('amox')) from (select check_custom_medicine(pg_temp.v('audio'), 'Amoxicillin') r) x$q$, 'false/use_catalogue_entry/Amoxicillin/true');
select pg_temp.expect_value('check', '… with a dose, in lower case',
  $q$select check_custom_medicine(pg_temp.v('audio'), 'paracetamol 500 mg') ->> 'code'$q$, 'use_catalogue_entry');
select pg_temp.expect_value('check', '… and with a spelling slip (amoxycillin)',
  $q$select check_custom_medicine(pg_temp.v('audio'), 'Amoxycillin 500mg capsules') ->> 'code'$q$, 'use_catalogue_entry');
select pg_temp.expect_value('check', 'a prohibited drug cannot be retyped as custom (codeine linctus → Codeine Cough Syrup)',
  $q$select (r ->> 'code') || '/' || (r -> 'match' ->> 'name') || '/' || (r -> 'match' ->> 'category') from (select check_custom_medicine(pg_temp.v('audio'), 'Codeine linctus') r) x$q$, 'use_catalogue_entry/Codeine Cough Syrup/prohibited');
select pg_temp.expect_value('check', 'the generic name typed alongside is checked too',
  $q$select check_custom_medicine(pg_temp.v('audio'), 'Brand X Pain Relief', 'Tramadol') ->> 'code'$q$, 'use_catalogue_entry');
select pg_temp.expect_value('check', 'an invalid name is refused (empty, one letter, 81 characters, markup)',
  $q$select (check_custom_medicine(pg_temp.v('audio'), '') ->> 'code') || '/' || (check_custom_medicine(pg_temp.v('audio'), 'x') ->> 'code') || '/' || (check_custom_medicine(pg_temp.v('audio'), repeat('a', 81)) ->> 'code') || '/' || (check_custom_medicine(pg_temp.v('audio'), 'Gel <script>') ->> 'code')$q$, 'custom_invalid/custom_invalid/custom_invalid/custom_invalid');
select pg_temp.expect_value('check', 'the patient''s recorded allergy gives a warning (never a block)',
  $q$select (r ->> 'ok') || '/' || (r -> 'warnings' -> 0 ->> 'code') || '/' || (r -> 'warnings' -> 0 ->> 'allergy') from (select check_custom_medicine(pg_temp.v('audio'), 'Penicillin G benzathine injection') r) x$q$, 'true/allergy/penicillin');
select pg_temp.expect_error('check', 'another doctor''s appointment is not found', $q$select check_custom_medicine(pg_temp.v('other'), 'Arnica Herbal Gel')$q$, 'not_found');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('check', 'a patient cannot use it', $q$select check_custom_medicine(pg_temp.v('audio'), 'Arnica Herbal Gel')$q$, 'not_found');
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;

-- ================================================================ B. save_rx_draft with custom items
select pg_temp.expect_value('save', 'a draft with a catalogue medicine and a custom one is saved',
  $q$select (save_rx_draft(pg_temp.v('audio'), '[{"drug_id":"drug-002","dose":"1 tablet","frequency":"TDS","duration":"5 days"},
        {"custom":true,"name":"Arnica Herbal Gel","generic_name":"Arnica montana","strength":"10 %","form":"Gel","dose":"Apply thinly","frequency":"BD","duration":"7 days","route":"Topical","acknowledged":false}]') ->> 'id') is not null$q$, 'true');
select pg_temp.expect_value('save', 'stored as: catalogue item with its drug id, custom item with no drug id',
  $q$select string_agg(coalesce(drug_id, '-') || ':' || is_custom || ':' || drug_name, ' | ' order by position) from prescription_items i join prescriptions p on p.id = i.prescription_id where p.appointment_id = pg_temp.v('audio')$q$,
  'drug-002:false:Paracetamol 650 | -:true:Arnica Herbal Gel');
select pg_temp.expect_value('save', 'the custom item keeps what the doctor typed',
  $q$select (generic_name) || '/' || strength || '/' || form || '/' || route || '/' || dose || '/' || custom_acknowledged from prescription_items where is_custom and prescription_id = (select id from prescriptions where appointment_id = pg_temp.v('audio'))$q$, 'Arnica montana/10 %/Gel/Topical/Apply thinly/false');
select pg_temp.expect_error('save', 'a custom name that matches the catalogue is refused by the server (not just the dialog)',
  $q$select save_rx_draft(pg_temp.v('audio'), '[{"custom":true,"name":"Codeine linctus","strength":"10 mg/5 ml","form":"Syrup","acknowledged":true}]')$q$, 'use_catalogue_entry');
select pg_temp.expect_error('save', 'a blocked catalogue medicine is still blocked in a mixed list (rules unchanged)',
  $q$select save_rx_draft(pg_temp.v('audio'), jsonb_build_array(jsonb_build_object('drug_id', pg_temp.s('amox')), jsonb_build_object('custom', true, 'name', 'Arnica Herbal Gel', 'acknowledged', true)))$q$, 'drug_blocked');
select pg_temp.expect_error('save', 'an invalid custom item is refused', $q$select save_rx_draft(pg_temp.v('audio'), '[{"custom":true,"name":"x"}]')$q$, 'custom_invalid');
select pg_temp.expect_error('save', 'at most 10 custom medicines per prescription',
  $q$select save_rx_draft(pg_temp.v('audio'), (select jsonb_agg(jsonb_build_object('custom', true, 'name', 'Zorbex ' || chr(64 + g) || ' Rub')) from generate_series(1, 11) g))$q$, 'too_many_custom');
select pg_temp.expect_error('save', 'another doctor''s appointment is not found',
  $q$select save_rx_draft(pg_temp.v('other'), '[{"custom":true,"name":"Arnica Herbal Gel"}]')$q$, 'not_found');
select pg_temp.expect_value('save', 'saving again replaces the items (custom ones included) on the same draft',
  $q$select (save_rx_draft(pg_temp.v('audio'), '[{"custom":true,"name":"Arnica Herbal Gel","generic_name":"Arnica montana","strength":"10 %","form":"Gel","acknowledged":true},{"drug_id":"drug-002","dose":"1 tablet"}]') is not null)::text
    || '/' || (select count(*) from prescription_items where prescription_id = (select id from prescriptions where appointment_id = pg_temp.v('audio')))$q$, 'true/2');
select pg_temp.expect_value('save', 'a draft can also be made of custom medicines only',
  $q$select (save_rx_draft(pg_temp.v('video'), '[{"custom":true,"name":"Zorbex Rub","acknowledged":true}]') ->> 'id') is not null$q$, 'true');
reset role;

-- the table itself keeps the two kinds apart
select pg_temp.expect_error('table', 'a custom item cannot carry a catalogue id',
  $q$insert into prescription_items (prescription_id, drug_id, drug_name, is_custom) select id, 'drug-002', 'x', true from prescriptions where appointment_id = pg_temp.v('audio')$q$, 'prescription_items_custom_chk');
select pg_temp.expect_error('table', 'a catalogue item must carry its id',
  $q$insert into prescription_items (prescription_id, drug_id, drug_name, is_custom) select id, null, 'x', false from prescriptions where appointment_id = pg_temp.v('audio')$q$, 'prescription_items_custom_chk');

-- ================================================================ C. switched off by the hospital
insert into app_settings (key, value) values ('allow_custom_medicines', 'false');
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('off', 'check says custom medicines are switched off', $q$select check_custom_medicine(pg_temp.v('audio'), 'Arnica Herbal Gel') ->> 'code'$q$, 'custom_disabled');
select pg_temp.expect_error('off', 'saving a custom item is refused', $q$select save_rx_draft(pg_temp.v('audio'), '[{"custom":true,"name":"Arnica Herbal Gel","acknowledged":true}]')$q$, 'custom_disabled');
select pg_temp.expect_value('off', 'catalogue-only drafts are unaffected', $q$select (save_rx_draft(pg_temp.v('video'), '[{"drug_id":"drug-002","dose":"1 tablet"}]') ->> 'id') is not null$q$, 'true');
reset role;
delete from app_settings where key = 'allow_custom_medicines';
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('off', 'removing the setting means allowed (default)', $q$select check_custom_medicine(pg_temp.v('audio'), 'Arnica Herbal Gel') ->> 'ok'$q$, 'true');
-- restore the custom-only draft on the audio consult for the sections below
select save_rx_draft(pg_temp.v('audio'), '[{"custom":true,"name":"Arnica Herbal Gel","generic_name":"Arnica montana","strength":"10 %","form":"Gel","dose":"Apply thinly","frequency":"BD","duration":"7 days","route":"Topical","acknowledged":false},{"drug_id":"drug-002","dose":"1 tablet","frequency":"TDS","duration":"5 days"}]');
reset role;

-- ================================================================ D. signing: acknowledgement, finalise, the printed prescription
select record_signature(pg_temp.v('doc'));
select pg_temp.login(:'docuser');
set local role authenticated;
select set_signing_pin(null, '482916');
select save_consult_notes(pg_temp.v('audio'), '{"chief_complaint":"Bruise","diagnoses":["J06.9"],"advice":"Rest","investigations":"","follow_up_date":"2030-01-05"}');
insert into t_vars select 'rx', id::text from prescriptions where appointment_id = pg_temp.v('audio') and status = 'draft';
select pg_temp.expect_error('sign', 'an unacknowledged custom medicine blocks signing', $q$select finalize_prescription(pg_temp.v('rx'), '482916')$q$, 'custom_not_acknowledged');
select pg_temp.expect_value('sign', '… nothing was signed', $q$select status from prescriptions where id = pg_temp.v('rx')$q$, 'draft');
select save_rx_draft(pg_temp.v('audio'), '[{"custom":true,"name":"Arnica Herbal Gel","generic_name":"Arnica montana","strength":"10 %","form":"Gel","dose":"Apply thinly","frequency":"BD","duration":"7 days","route":"Topical","acknowledged":true},{"drug_id":"drug-002","dose":"1 tablet","frequency":"TDS","duration":"5 days"}]');
reset role;
-- the catalogue grows later with a medicine that matches the custom name: the doctor must switch to it before signing
insert into drug_master (id, name, generic_name, form, strength, category, schedule, interaction_groups, allergy_class, default_dose, default_frequency, default_route)
values ('drug-zz-arnica', 'Arnica Montana Gel', 'Arnica montana', 'Gel', '10 %', 'O', 'OTC', '{}', null, '—', '—', 'Topical');
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('sign', 'a custom medicine that has since joined the catalogue must be replaced by the catalogue entry', $q$select finalize_prescription(pg_temp.v('rx'), '482916')$q$, 'use_catalogue_entry');
reset role;
delete from drug_master where id = 'drug-zz-arnica';
select pg_temp.login(:'docuser');
set local role authenticated;
insert into t_vars select 'fin', finalize_prescription(pg_temp.v('rx'), '482916')::text;
select pg_temp.expect_value('sign', 'an acknowledged custom medicine can be signed', $q$select (pg_temp.s('fin')::jsonb ->> 'ok') $q$, 'true');
select pg_temp.expect_value('sign', 'the final prescription keeps both items, the custom one flagged', $q$select string_agg(is_custom || ':' || drug_name, ' | ' order by position) from prescription_items where prescription_id = pg_temp.v('rx')$q$, 'true:Arnica Herbal Gel | false:Paracetamol 650');
select pg_temp.expect_error('sign', 'after signing, changes need an addendum', $q$select save_rx_draft(pg_temp.v('audio'), '[]')$q$, 'use_addendum');
reset role;
select pg_temp.expect_value('pdf', 'THE PRINTED PRESCRIPTION lists the custom medicine (not dropped by the catalogue join)',
  $q$select count(*) filter (where i ->> 'drug_name' = 'Arnica Herbal Gel')::text || '/' || count(*) from jsonb_array_elements(rx_pdf_payload(pg_temp.v('rx')) -> 'items') i$q$, '1/2');
select pg_temp.expect_value('pdf', '… with the generic name the doctor typed, and the catalogue one with its catalogue generic',
  $q$select string_agg(i ->> 'generic_name', ' | ' order by i ->> 'drug_name') from jsonb_array_elements(rx_pdf_payload(pg_temp.v('rx')) -> 'items') i$q$, 'Arnica montana | Paracetamol');
select pg_temp.expect_value('pdf', '… and flags which line is custom', $q$select string_agg((i ->> 'custom'), ',' order by i ->> 'drug_name') from jsonb_array_elements(rx_pdf_payload(pg_temp.v('rx')) -> 'items') i$q$, 'true,false');

-- ================================================================ E. addendum keeps the custom medicine
select pg_temp.login(:'docuser');
set local role authenticated;
insert into t_vars select 'rx2', start_addendum(pg_temp.v('rx'), 'Added a second tablet course');
select pg_temp.expect_value('addendum', 'the addendum starts with the same items, custom one included and still acknowledged',
  $q$select string_agg(is_custom || ':' || custom_acknowledged || ':' || drug_name, ' | ' order by position) from prescription_items where prescription_id = pg_temp.v('rx2')$q$, 'true:true:Arnica Herbal Gel | false:false:Paracetamol 650');
select pg_temp.expect_value('addendum', 'and can be signed as version 2', $q$select finalize_prescription(pg_temp.v('rx2'), '482916') ->> 'version'$q$, '2');
reset role;
select pg_temp.expect_value('addendum', 'version 2 prints both too', $q$select count(*)::text from jsonb_array_elements(rx_pdf_payload(pg_temp.v('rx2')) -> 'items')$q$, '2');

-- ================================================================ F. admins can see what is being used
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_value('review', 'admin sees the custom medicine with how often and by how many doctors',
  $q$select (r ->> 'name') || '/' || (r ->> 'uses') || '/' || (r ->> 'doctors') from jsonb_array_elements(admin_custom_medicines(90)) r where r ->> 'name' = 'Arnica Herbal Gel'$q$, 'Arnica Herbal Gel/2/1');
select pg_temp.expect_value('review', 'it lists no patient or appointment detail',
  $q$select (admin_custom_medicines(90)::text ~* '(patient|ref_code|appointment|Custom Rx Test)')::text$q$, 'false');
reset role;
select pg_temp.login(:'coord', 'aal2');
set local role authenticated;
select pg_temp.expect_error('review', 'a coordinator cannot', $q$select admin_custom_medicines(90)$q$, 'forbidden');
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('review', 'a doctor cannot', $q$select admin_custom_medicines(90)$q$, 'forbidden');
reset role;

-- ================================================================ G. demo mode: the typed medicine is added directly
-- (no catalogue match, no acknowledgement). What makes it WORK is not optional: it saves, it is signed, it is printed.
insert into app_settings (key, value) values ('custom_medicine_mode', '"direct"') on conflict (key) do update set value = excluded.value;
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('direct', 'a name that is in the catalogue is accepted as typed, and the answer says the mode',
  $q$select (r ->> 'ok') || '/' || (r ->> 'mode') || '/' || coalesce(r ->> 'code', 'none') from (select check_custom_medicine(pg_temp.v('video'), 'Amoxicillin') r) x$q$, 'true/direct/none');
select pg_temp.expect_value('direct', 'the name is still sanity-checked', $q$select check_custom_medicine(pg_temp.v('video'), 'x') ->> 'code'$q$, 'custom_invalid');
select pg_temp.expect_value('direct', 'it saves with no acknowledgement',
  $q$select (save_rx_draft(pg_temp.v('video'), '[{"custom":true,"name":"Amoxicillin","strength":"500 mg","form":"Capsule","dose":"1 capsule","frequency":"TDS","duration":"5 days","acknowledged":false}]') ->> 'id') is not null$q$, 'true');
select save_consult_notes(pg_temp.v('video'), '{"chief_complaint":"Sore throat","diagnoses":["J06.9"],"advice":"Rest","investigations":"","follow_up_date":"2030-01-05"}');
insert into t_vars select 'rxd', id::text from prescriptions where appointment_id = pg_temp.v('video') and status = 'draft';
select pg_temp.expect_value('direct', 'and it can be signed without one', $q$select finalize_prescription(pg_temp.v('rxd'), '482916') ->> 'ok'$q$, 'true');
reset role;
select pg_temp.expect_value('direct', 'the signed prescription prints it', $q$select count(*)::text from jsonb_array_elements(rx_pdf_payload(pg_temp.v('rxd')) -> 'items') i where i ->> 'drug_name' = 'Amoxicillin' and i ->> 'custom' = 'true'$q$, '1');
-- the switch off still wins, and removing the setting returns to the strict default
insert into app_settings (key, value) values ('allow_custom_medicines', 'false');
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('direct', 'the on/off switch still applies in direct mode', $q$select check_custom_medicine(pg_temp.v('video'), 'Arnica Herbal Gel') ->> 'code'$q$, 'custom_disabled');
reset role;
delete from app_settings where key = 'allow_custom_medicines';
delete from app_settings where key = 'custom_medicine_mode';
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('direct', 'no setting means the strict default again', $q$select (r ->> 'code') || '/' || (r ->> 'mode') from (select check_custom_medicine(pg_temp.v('video'), 'Amoxicillin') r) x$q$, 'use_catalogue_entry/checked');
reset role;

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
