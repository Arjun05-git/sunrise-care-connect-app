-- =============================================================================
-- Integrations: HIS events (patient master on first booking + identity changes, consultation summary +
-- prescription on signing, billing on capture / refund), MRN ordering, LeadSquared only with the marketing
-- consent and with no clinical fields, retries / backoff / skip, flags, HIS doctor master matching, ABHA
-- linking behind the ABDM flag, native device tokens for push, access rules. Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/integrations_flow.sql
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
create function pg_temp.login(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;
create function pg_temp.put(key text, val text) returns void language sql as $$ insert into t_vars values (key, val) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.ev(p_key text) returns text language sql as $$ select status from integration_events where idempotency_key = p_key $$;
create function pg_temp.kinds(p_entity uuid) returns text language sql as $$
  select coalesce(string_agg(system || ':' || kind, ',' order by system, kind), '') from integration_events where entity_id = p_entity $$;

\set pu    'dddddddd-0000-4000-8000-000000000001'
\set pu2   'dddddddd-0000-4000-8000-000000000002'
\set admin '00000001-0000-4000-8000-000000000001'
\set coord '00000001-0000-4000-8000-000000000003'

update app_settings set value = '{"his": true, "leadsquared": true}' where key = 'integrations';
insert into app_settings (key, value) values ('integrations', '{"his": true, "leadsquared": true}') on conflict (key) do nothing;
insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'pu', 'authenticated', 'authenticated', '919800000301', '{"full_name":"Devika Integr"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'pu2', 'authenticated', 'authenticated', '919800000302', '{"full_name":"Mathew Other"}', now(), now());
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender, is_primary, address) values (:'pu', 'Devika Integr', '1991-03-03', 'female', true, 'Kakkanad, Kochi') returning id)
insert into t_vars select 'pt', id::text from x;
-- a test doctor of our own (no generated slots to collide with)
with d as (insert into doctors (full_name, phone, qualification, registration_no, registration_council, hospital_id, department_id, verification_status, modes, his_doctor_code)
           select 'Dr. Integration Test', '+919800000303', 'MBBS', 'TCMC/INTG-1', 'TCMC', hospital_id, department_id, 'verified', '{video,audio}', 'HIS-D-001'
             from doctors where verification_status = 'verified' limit 1 returning id)
insert into t_vars select 'doc', id::text from d;

create function pg_temp.book(p_key text, p_status appointment_status, p_offset int default 2880) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = pg_temp.v('doc');
  st := st + make_interval(mins => 20 * (select count(*)::int from slots where doctor_id = d.id));   -- each booking its own time
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', 'booked') returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, hold_expires_at)
  values ('IN-' || substr(md5(random()::text), 1, 6), pg_temp.v('pt'), 'dddddddd-0000-4000-8000-000000000001', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes',
          'video', 'first', 700, p_status, case when p_status = 'pending_payment' then now() + interval '10 minutes' end)
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  perform pg_temp.put(p_key, aid::text);
  return aid;
end $$;

-- ================================================================ HIS + LeadSquared on booking
select pg_temp.expect_value('leads', 'sign-up without marketing consent → no lead', $q$select count(*)::text from integration_events where entity_id = pg_temp.v('pt')$q$, '0');
select pg_temp.book('a1', 'pending_payment');
select pg_temp.expect_value('his', 'nothing for an unpaid hold', $q$select pg_temp.kinds(pg_temp.v('a1'))$q$, '');
update appointments set status = 'confirmed', hold_expires_at = null where id = pg_temp.v('a1');
select pg_temp.expect_value('his', 'first confirmed booking → patient master queued', $q$select pg_temp.kinds(pg_temp.v('pt'))$q$, 'his:patient_upsert');
select pg_temp.expect_value('leads', 'no marketing consent → no LeadSquared event', $q$select pg_temp.kinds(pg_temp.v('a1'))$q$, '');
insert into consents (user_id, consent_type, version, granted) values (:'pu', 'marketing', '1.0', true);
select pg_temp.book('a2', 'confirmed');
select pg_temp.expect_value('leads', 'with the consent → "booked" lead event', $q$select pg_temp.kinds(pg_temp.v('a2'))$q$, 'leadsquared:lead_event');
select pg_temp.expect_value('his', 'second booking: same identity → no duplicate patient master', $q$select count(*)::text from integration_events where entity_id = pg_temp.v('pt')$q$, '1');
update patients set blood_group = 'O+' where id = pg_temp.v('pt');
select pg_temp.expect_value('his', 'non-identity change → nothing', $q$select count(*)::text from integration_events where entity_id = pg_temp.v('pt')$q$, '1');
update patients set address = 'Edappally, Kochi' where id = pg_temp.v('pt');
select pg_temp.expect_value('his', 'address change → patient master re-sent', $q$select count(*)::text from integration_events where entity_id = pg_temp.v('pt')$q$, '2');

-- ================================================================ payloads
select pg_temp.put('pe', (select id::text from integration_events where entity_id = pg_temp.v('pt') order by created_at desc limit 1));
select pg_temp.expect_value('payload', 'patient master: identity only', $q$select (p ->> 'name') || '/' || (p ->> 'address') || '/' || (p ->> 'mobile') || '/' || (p ? 'allergies')::text from (select integration_payload(pg_temp.v('pe')) p) x$q$,
  'Devika Integr/Edappally, Kochi/+919800000301/false');
select pg_temp.put('le', (select id::text from integration_events where entity_id = pg_temp.v('a2')));
select pg_temp.expect_value('payload', 'lead: name, mobile, city, event – nothing clinical, no doctor or department',
  $q$select (p ->> 'event') || '/' || (p -> 'lead' ->> 'name') || '/' || (p -> 'lead' ->> 'mobile') || '/' || (p -> 'lead' ->> 'city' is not null)::text || '/' ||
            (p::text ~* '(doctor|department|symptom|diagnos|prescri|fee)')::text from (select integration_payload(pg_temp.v('le')) p) x$q$, 'booked/Devika Integr/+919800000301/true/false');
update consents set withdrawn_at = now() where user_id = :'pu' and consent_type = 'marketing';
select pg_temp.expect_value('payload', 'consent withdrawn before sending → skip', $q$select integration_payload(pg_temp.v('le')) ->> 'skip'$q$, 'no_consent');
update consents set withdrawn_at = null where user_id = :'pu' and consent_type = 'marketing';

-- ================================================================ prescription → summary + Rx, waits for the MRN
insert into consultations (appointment_id, doctor_id, patient_id, chief_complaint, diagnoses, advice, status)
select id, doctor_id, patient_id, 'Fever for 3 days', '[{"code":"R50.9","text":"Fever"}]', 'Fluids', 'final' from appointments where id = pg_temp.v('a1');
with r as (insert into prescriptions (appointment_id, doctor_id, patient_id, advice, diagnoses) select id, doctor_id, patient_id, 'Fluids', '[{"code":"R50.9"}]' from appointments where id = pg_temp.v('a1') returning id)
insert into t_vars select 'rx', id::text from r;
insert into prescription_items (prescription_id, drug_id, drug_name, strength, dose, frequency, duration) select pg_temp.v('rx'), id, name, strength, '1', 'TDS', '3 days' from drug_master where category = 'O' limit 1;
update prescriptions set status = 'final', finalized_at = now(), verification_code = 'INTG' || substr(md5(random()::text), 1, 8) where id = pg_temp.v('rx');
select pg_temp.expect_value('his', 'signing queues the consultation summary and the prescription', $q$select pg_temp.kinds(pg_temp.v('rx'))$q$, 'his:consultation_summary,his:prescription');
select pg_temp.put('rxe', (select id::text from integration_events where entity_id = pg_temp.v('rx') and kind = 'prescription'));
select pg_temp.expect_value('his', 'no MRN yet → the prescription waits', $q$select integration_payload(pg_temp.v('rxe')) ->> 'wait'$q$, 'waiting_for_mrn');
select pg_temp.expect_value('his', '… a wait does not use up an attempt', $q$select fail_integration_event(pg_temp.v('rxe'), 'waiting_for_mrn', 'wait') || '/' || (select attempts from integration_events where id = pg_temp.v('rxe'))$q$, 'queued/0');
select complete_integration_event(pg_temp.v('pe'), 'HIS-PAT-1', '{"mrn":"SUN-MRN-000123"}');
select pg_temp.expect_value('his', 'patient master answered with the MRN → stored', $q$select his_mrn || '/' || (his_synced_at is not null) from patients where id = pg_temp.v('pt')$q$, 'SUN-MRN-000123/true');
select pg_temp.expect_value('his', 'prescription payload: MRN, Rx no, items, doctor code',
  $q$select (p ->> 'mrn') || '/' || (p ->> 'rx_no' like 'SCRX-%')::text || '/' || jsonb_array_length(p -> 'items') || '/' || (p ->> 'doctor_code' is not null)::text from (select integration_payload(pg_temp.v('rxe')) p) x$q$,
  'SUN-MRN-000123/true/1/true');
select pg_temp.expect_value('his', 'summary payload carries the diagnosis', $q$select integration_payload((select id from integration_events where entity_id = pg_temp.v('rx') and kind = 'consultation_summary')) -> 'diagnoses' -> 0 ->> 'code'$q$, 'R50.9');
select pg_temp.expect_value('his', 'a later MRN in a response never overwrites the first', $q$select complete_integration_event(pg_temp.v('pe'), 'HIS-PAT-1', '{"mrn":"OTHER"}')::text || (select his_mrn from patients where id = pg_temp.v('pt'))$q$, 'SUN-MRN-000123');

-- ================================================================ billing
with p as (insert into payments (appointment_id, provider, provider_order_id, amount, status) select pg_temp.v('a2'), 'mock', 'order_intg_' || pg_temp.v('a2'), 700, 'created' returning id)
insert into t_vars select 'pay', id::text from p;
update payments set status = 'captured', captured_at = now(), provider_payment_id = 'pay_intg', method = 'upi' where id = pg_temp.v('pay');
select pg_temp.expect_value('billing', 'payment captured → billing entry + "paid" lead', $q$select pg_temp.kinds(pg_temp.v('pay'))$q$, 'his:billing_payment,leadsquared:lead_event');
select pg_temp.expect_value('billing', 'billing payload: service code, amount, receipt', $q$select (p ->> 'service_code') || '/' || (p ->> 'amount') || '/' || (p ->> 'receipt_no' is not null)::text
  from (select integration_payload((select id from integration_events where entity_id = pg_temp.v('pay') and kind = 'billing_payment')) p) x$q$, 'TELE-VIDEO-FIRST/700/true');
with r as (insert into refunds (payment_id, appointment_id, amount, reason, status) values (pg_temp.v('pay'), pg_temp.v('a2'), 700, 'Test refund', 'initiated') returning id)
insert into t_vars select 'rf', id::text from r;
select pg_temp.expect_value('billing', 'refund started → nothing yet', $q$select pg_temp.kinds(pg_temp.v('rf'))$q$, '');
update refunds set status = 'processed', processed_at = now(), provider_refund_id = 'rfnd_intg' where id = pg_temp.v('rf');
select pg_temp.expect_value('billing', 'refund paid out → billing refund entry', $q$select pg_temp.kinds(pg_temp.v('rf'))$q$, 'his:billing_refund');

-- ================================================================ dispatcher state machine
select pg_temp.put('n', (select count(*)::text from claim_integration_events(200)));
select pg_temp.expect_value('dispatch', 'claim leases due events', $q$select (count(*) filter (where status = 'sending') > 0)::text from integration_events where created_at > now() - interval '1 hour'$q$, 'true');
select pg_temp.expect_value('dispatch', 'temporary failure → queued again', $q$select fail_integration_event(pg_temp.v('le'), 'timeout', 'temporary')$q$, 'queued');
select pg_temp.expect_value('dispatch', '… after a 1-minute back-off', $q$select (next_attempt_at between now() + interval '50 seconds' and now() + interval '70 seconds')::text from integration_events where id = pg_temp.v('le')$q$, 'true');
update integration_events set attempts = 6 where id = pg_temp.v('le');
select pg_temp.expect_value('dispatch', 'after 6 attempts → failed', $q$select fail_integration_event(pg_temp.v('le'), 'timeout', 'temporary')$q$, 'failed');
select pg_temp.expect_value('dispatch', 'permanent error → failed at once', $q$select fail_integration_event((select id from integration_events where entity_id = pg_temp.v('rf')), 'bad_request', 'permanent')$q$, 'failed');
select pg_temp.expect_value('dispatch', 'skip → skipped', $q$select fail_integration_event((select id from integration_events where entity_id = pg_temp.v('pay') and system = 'leadsquared'), 'no_consent', 'skip')$q$, 'skipped');

-- ================================================================ flags
update app_settings set value = '{"his": false, "leadsquared": true}' where key = 'integrations';
select pg_temp.book('a3', 'confirmed');
select pg_temp.expect_value('flags', 'HIS off → nothing queued for HIS', $q$select count(*)::text from integration_events where system = 'his' and created_at > now() - interval '1 second' and entity_id = pg_temp.v('pt') and status = 'queued'$q$, '0');
select pg_temp.expect_value('flags', 'HIS off → queued events are skipped when sent', $q$select integration_payload(pg_temp.v('rxe')) ->> 'skip'$q$, 'integration_off');
update app_settings set value = '{"his": true, "leadsquared": true}' where key = 'integrations';
set local app.suppress_notifications = 'on';
select pg_temp.book('a4', 'confirmed');
reset app.suppress_notifications;
select pg_temp.expect_value('flags', 'seed / bulk import (suppressed) → nothing queued', $q$select pg_temp.kinds(pg_temp.v('a4'))$q$, '');

-- ================================================================ HIS doctor master
update doctors set his_doctor_code = null where id = pg_temp.v('doc');
select pg_temp.put('docreg', (select registration_no from doctors where id = pg_temp.v('doc')));
select pg_temp.expect_value('doctors', 'master sync: links by registration, reports unknown codes, never creates doctors',
  $q$select (r ->> 'linked') || '/' || (r -> 'unmatched' ->> 0)
     from (select his_apply_doctor_master(jsonb_build_array(jsonb_build_object('his_doctor_code', 'HIS-D-777', 'registration_no', (select v from t_vars where k = 'docreg')),
                                                              jsonb_build_object('his_doctor_code', 'HIS-D-999', 'registration_no', 'NOPE/1'))) r) x$q$, '1/HIS-D-999');
select pg_temp.expect_value('doctors', '… the code is now on the doctor', $q$select his_doctor_code from doctors where id = pg_temp.v('doc')$q$, 'HIS-D-777');
select pg_temp.expect_value('doctors', 'a registration mismatch on a known code is reported, not applied',
  $q$select (his_apply_doctor_master('[{"his_doctor_code":"HIS-D-777","registration_no":"CHANGED/9"}]') -> 'conflicts' -> 0 ->> 'issue') || '/' || (select registration_no = (select v from t_vars where k = 'docreg') from doctors where id = pg_temp.v('doc'))$q$,
  'registration_differs/true');
select pg_temp.expect_value('doctors', 'verification is untouched', $q$select verification_status from doctors where id = pg_temp.v('doc')$q$, 'verified');

-- ================================================================ ABHA (flag off by default)
select pg_temp.expect_error('abha', 'flag off → linking refused', format($q$select link_abha(pg_temp.v('pt'), '91-1234-5678-9012', 'devika.i@sbx', %L)$q$, :'pu'), 'abdm_disabled');
update app_settings set value = 'true' where key = 'abdm_enabled';
select pg_temp.expect_error('abha', 'malformed ABHA number refused', format($q$select link_abha(pg_temp.v('pt'), '9112345678', null, %L)$q$, :'pu'), 'check constraint');
select pg_temp.expect_error('abha', 'only the account holder''s own patient', format($q$select link_abha(pg_temp.v('pt'), '91-1234-5678-9012', null, %L)$q$, :'pu2'), 'not_found');
select link_abha(pg_temp.v('pt'), '91-1234-5678-9012', 'devika.i@sbx', :'pu');
select pg_temp.expect_value('abha', 'verified ABHA linked', $q$select abha_number || '/' || abha_address || '/' || (abha_verified_at is not null) from patients where id = pg_temp.v('pt')$q$, '91-1234-5678-9012/devika.i@sbx/true');
select pg_temp.expect_value('abha', 'linking the ABHA re-sends the patient master (it carries the ABHA)', $q$select count(*)::text from integration_events where entity_id = pg_temp.v('pt') and kind = 'patient_upsert'$q$, '3');
select pg_temp.login(:'pu2');
set local role authenticated;
select pg_temp.expect_error('abha', 'someone else cannot unlink', $q$select unlink_abha(pg_temp.v('pt'))$q$, 'not_found');
reset role;
select pg_temp.login(:'pu');
set local role authenticated;
select unlink_abha(pg_temp.v('pt'));
reset role;
select pg_temp.expect_value('abha', 'the patient can unlink', $q$select coalesce(abha_number, 'none') from patients where id = pg_temp.v('pt')$q$, 'none');
update app_settings set value = 'false' where key = 'abdm_enabled';

-- ================================================================ native push devices
select pg_temp.login(:'pu');
set local role authenticated;
select pg_temp.expect_error('devices', 'token must look like a token', $q$select register_device_token('android', 'short')$q$, 'invalid_input');
select register_device_token('android', 'fcm-token-' || repeat('x', 40), '1.0.0');
select pg_temp.expect_value('devices', 'own token readable', $q$select platform || '/' || app_version from device_tokens$q$, 'android/1.0.0');
reset role;
select pg_temp.expect_value('devices', 'a native token alone is enough for push messages',
  $q$select public.enqueue_notification('dddddddd-0000-4000-8000-000000000001', 'ticket_update', '{"ref":"T-1"}', '/p/help', 'intg-push-test')::text$q$, '4');
select pg_temp.expect_value('devices', '… including a push copy', $q$select count(*)::text from notifications where event_key = 'intg-push-test' and channel = 'push'$q$, '1');
select pg_temp.expect_value('devices', 'the dispatcher receives the device tokens',
  $q$select x -> 'devices' -> 0 ->> 'platform' from jsonb_array_elements(claim_notifications(500)) x where x ->> 'channel' = 'push' and x ->> 'template_key' = 'ticket_update' limit 1$q$, 'android');
select device_token_result('fcm-token-' || repeat('x', 40), false, true);
select pg_temp.expect_value('devices', 'an unregistered token is removed', $q$select count(*)::text from device_tokens where user_id = 'dddddddd-0000-4000-8000-000000000001'$q$, '0');

-- ================================================================ access
select pg_temp.login(:'pu');
set local role authenticated;
select pg_temp.expect_error('access', 'patients cannot claim events', $q$select count(*) from claim_integration_events(1)$q$, 'permission denied');
select pg_temp.expect_error('access', 'patients cannot build payloads', $q$select integration_payload(pg_temp.v('pe'))$q$, 'permission denied');
select pg_temp.expect_error('access', 'patients cannot link an ABHA directly', $q$select link_abha(pg_temp.v('pt'), '91-1234-5678-9012', null, auth.uid())$q$, 'permission denied');
select pg_temp.expect_value('access', 'patients see no outbox rows', $q$select count(*)::text from integration_events$q$, '0');
reset role;
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('access', 'coordinators cannot see integration stats', $q$select admin_integration_stats()$q$, 'forbidden');
reset role;
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_value('admin', 'stats per system with the flags', $q$select (s -> 'flags' ->> 'abdm') || '/' || (s -> 'by_system' ? 'his')::text from (select admin_integration_stats() s) x$q$, 'false/true');
select admin_retry_integration(pg_temp.v('le'));
select pg_temp.expect_value('admin', 'failed event retried', $q$select status from integration_events where id = pg_temp.v('le')$q$, 'queued');
select pg_temp.expect_error('admin', 'flags need a reason', $q$select admin_set_integrations(true, false, false, '')$q$, 'reason_required');
select admin_set_integrations(true, false, false, 'LeadSquared contract paused');
select pg_temp.expect_value('admin', 'flags saved', $q$select (value ->> 'leadsquared') || '/' || (select value::text from app_settings where key = 'abdm_enabled') from app_settings where key = 'integrations'$q$, 'false/false');
reset role;

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
