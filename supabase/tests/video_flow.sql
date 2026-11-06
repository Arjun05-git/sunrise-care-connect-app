-- =============================================================================
-- Video consultation rules: join windows, rooms, recording off, call-log whitelist, webhook,
-- call summary, chat (role from caller, window, files), live notes, automatic no-shows.
-- A fresh test doctor keeps times around "now" free of seeded bookings. Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/video_flow.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
create temp table t_vars (k text primary key, v text);
grant all on t_results, t_vars to authenticated;
grant usage on sequence t_results_n_seq to authenticated;
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

\set rajan  '00000001-0000-4000-8000-0000000000c9'
\set anjali '00000001-0000-4000-8000-0000000000c8'
\set arun   '00000001-0000-4000-8000-000000000064'
\set docuser 'aaaaaaaa-0000-4000-8000-000000000001'

-- fresh doctor (auth user → profile via trigger), patient of Rajan
insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'docuser', 'authenticated', 'authenticated', '919800000001', '{"full_name":"Dr. Video Test"}', now(), now());
delete from user_roles where user_id = :'docuser';
insert into user_roles (user_id, role) values (:'docuser', 'doctor');
with d as (insert into doctors (profile_id, full_name, hospital_id, department_id, verification_status, modes)
           select :'docuser', 'Dr. Video Test', hospital_id, department_id, 'verified', '{video,audio}' from doctors limit 1 returning id)
insert into t_vars select 'doc', id::text from d;
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender) values (:'rajan', 'Meenakshi Video Test', '1990-01-01', 'female') returning id)
insert into t_vars select 'pt', id::text from x;

-- consult starting at now() + p_offset (minutes), 15 min long, confirmed
create function pg_temp.consult(p_offset int, p_key text) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = pg_temp.v('doc');
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', 'booked') returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
  values ('V-' || substr(md5(random()::text), 1, 8), pg_temp.v('pt'), '00000001-0000-4000-8000-0000000000c9', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes', 'video', 'first', 500, 'confirmed')
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  insert into t_vars values (p_key, aid::text);
  return aid;
end $$;
select pg_temp.consult(60, 'later');      -- in an hour: window not open yet
select pg_temp.consult(5, 'soon');        -- in 5 minutes: window open (10 min before)
select pg_temp.consult(-300, 'old');      -- 5 hours ago: window closed
select pg_temp.consult(-45, 'dns');       -- patient waited, doctor never joined
select pg_temp.consult(-80, 'bns');       -- nobody joined
select pg_temp.consult(-27, 'solo');      -- doctor in the room alone, 27 min after the start
select pg_temp.consult(-11, 'early');     -- nobody yet, 11 min after the start (inside the 30-minute wait)
select pg_temp.consult(-60, 'pns');       -- doctor joined, patient never did
select pg_temp.consult(-2000, 'ancient'); -- > 1 day ago: never touched by the sweep
select pg_temp.consult(30, 'chat');

-- ================================================================ JOIN WINDOW
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('window', 'access says not yet', $q$select (consult_access(pg_temp.v('later')) ->> 'can_join')$q$, 'false');
select pg_temp.expect_error('window', 'cannot join an hour early', $q$select join_consult(pg_temp.v('later'), 'livekit')$q$, 'too_early');
select pg_temp.expect_error('window', 'cannot join after the window closed', $q$select join_consult(pg_temp.v('old'), 'livekit')$q$, 'window_closed');
select pg_temp.expect_value('window', 'opens 10 minutes before the start', $q$select ((a ->> 'start_at')::timestamptz - (a ->> 'opens_at')::timestamptz)::text from (select consult_access(pg_temp.v('soon')) a) x$q$, '00:10:00');
select pg_temp.expect_value('window', 'closes 30 minutes after the end', $q$select ((a ->> 'closes_at')::timestamptz - (a ->> 'end_at')::timestamptz)::text from (select consult_access(pg_temp.v('soon')) a) x$q$, '00:30:00');
insert into t_vars select 'pj', join_consult(pg_temp.v('soon'), 'livekit')::text;
select pg_temp.expect_value('join', 'patient joins 5 minutes early', $q$select (select v::jsonb ->> 'role' from t_vars where k = 'pj')$q$, 'patient');
select pg_temp.expect_value('join', 'recording is off', $q$select (select v::jsonb ->> 'recording' from t_vars where k = 'pj')$q$, 'false');
select pg_temp.expect_value('join', 'patient alone in the room: still confirmed', $q$select status || '/' || (patient_joined_at is not null) from appointments where id = pg_temp.v('soon')$q$, 'confirmed/true');
select pg_temp.expect_value('join', 'patient shown by first name only', $q$select (select v::jsonb ->> 'display_name' from t_vars where k = 'pj')$q$, 'Meenakshi');
select pg_temp.expect_value('join', 'room name is random – no ids, no names', $q$select ((r ~ '^scc-[A-Za-z0-9]{24}$') and position((select v from t_vars where k = 'soon') in r) = 0)::text from (select (select v::jsonb ->> 'room' from t_vars where k = 'pj') r) x$q$, 'true');
select pg_temp.expect_value('join', 'identity has no personal data', $q$select ((select v::jsonb ->> 'identity' from t_vars where k = 'pj') ~ '^patient-[0-9a-f]{12}$')::text$q$, 'true');
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_error('join', 'another family cannot join', $q$select join_consult(pg_temp.v('soon'), 'livekit')$q$, 'not_found');
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('join', 'another doctor cannot join', $q$select join_consult(pg_temp.v('soon'), 'livekit')$q$, 'not_found');
select pg_temp.login(:'docuser');
set local role authenticated;
insert into t_vars select 'dj', join_consult(pg_temp.v('soon'), 'livekit')::text;
select pg_temp.expect_value('join', 'doctor joins the same room', $q$select ((select v::jsonb ->> 'room' from t_vars where k = 'dj') = (select v::jsonb ->> 'room' from t_vars where k = 'pj'))::text$q$, 'true');
reset role;
select pg_temp.expect_value('join', 'both in the room → in progress; both join times kept', $q$select status || '/' || (doctor_joined_at is not null) || '/' || (patient_joined_at is not null) from appointments where id = pg_temp.v('soon')$q$, 'in_progress/true/true');
select pg_temp.expect_value('join', 'joins are logged', $q$select count(*)::text from call_logs where appointment_id = pg_temp.v('soon') and event = 'join'$q$, '2');

-- ================================================================ CALL LOGS
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('logs', 'unknown events are rejected', $q$select log_call_event(pg_temp.v('soon'), 'diagnosis', '{}')$q$, 'invalid_input');
select pg_temp.expect_error('logs', 'only the doctor ends the consultation', $q$select log_call_event(pg_temp.v('soon'), 'end', '{}')$q$, 'forbidden');
select log_call_event(pg_temp.v('soon'), 'quality', '{"worst":"poor","samples":6,"poor":2,"good":4,"notes":"patient says chest pain"}');
select log_call_event(pg_temp.v('soon'), 'reconnecting', '{"reason":"network"}');
select log_call_event(pg_temp.v('soon'), 'failure', '{"reason":"ice_failed","attempts":3}');
select pg_temp.expect_error('logs', 'direct inserts into call_logs are closed', $q$insert into call_logs (appointment_id, provider, room_name, event, actor_user_id) values (pg_temp.v('soon'), 'x', 'x', 'join', auth.uid())$q$, 'permission denied');
reset role;
select pg_temp.expect_value('logs', 'detail keeps whitelisted keys only (no free text)', $q$select (detail::jsonb ? 'notes')::text || '/' || (detail::jsonb ->> 'worst') from call_logs where appointment_id = pg_temp.v('soon') and event = 'quality'$q$, 'false/poor');
select record_video_webhook((select video_room from appointments where id = pg_temp.v('soon')), 'participant_joined', 'doctor-abc', '{}');
select record_video_webhook('scc-not-ours', 'participant_joined', 'doctor-abc', '{}');
select pg_temp.expect_value('logs', 'LiveKit webhook events are stored as server events (unknown rooms ignored)', $q$select count(*)::text from call_logs where source = 'server' and event = 'participant_joined'$q$, '1');
update appointments set doctor_joined_at = now() - interval '12 minutes', patient_joined_at = now() - interval '11 minutes' where id = pg_temp.v('soon');
select pg_temp.login(:'docuser');
set local role authenticated;
select log_call_event(pg_temp.v('soon'), 'end', '{}');
select pg_temp.expect_value('summary', 'start = both present, duration ≈ 11 min', $q$select (s ->> 'duration_seconds')::int between 650 and 670 from (select call_summary(pg_temp.v('soon')) s) x$q$, 'true');
select pg_temp.expect_value('summary', 'quality, reconnects, failure reason', $q$select (s -> 'quality' ->> 'worst') || '/' || (s -> 'quality' ->> 'poor_share') || '/' || (s ->> 'reconnects') || '/' || (s -> 'failures' -> 0 ->> 'reason') from (select call_summary(pg_temp.v('soon')) s) x$q$, 'poor/0.33/1/ice_failed');
select pg_temp.expect_value('summary', 'recording reported off', $q$select call_summary(pg_temp.v('soon')) ->> 'recording'$q$, 'false');

-- ================================================================ CHAT
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('chat', 'direct chat inserts are closed (role could be forged)', $q$insert into chat_messages (appointment_id, sender_user_id, sender_role, body) values (pg_temp.v('soon'), auth.uid(), 'doctor', 'I am the doctor')$q$, 'permission denied');
select pg_temp.expect_value('chat', 'patient message is stored with role patient', $q$select (send_chat_message(pg_temp.v('soon'), 'Can you hear me?')).sender_role$q$, 'patient');
select pg_temp.expect_error('chat', 'chat is closed before the join window', $q$select send_chat_message(pg_temp.v('later'), 'hello?')$q$, 'chat_closed');
reset role;   -- registered by documents-register (service role) after its byte check
with d as (insert into documents (patient_id, uploaded_by, tag, file_name, mime_type, size_bytes, storage_path)
           values (pg_temp.v('pt'), auth.uid(), 'photo', 'rash.png', 'image/png', 100, 'patients/' || pg_temp.v('pt') || '/' || gen_random_uuid() || '.png') returning id)
insert into t_vars select 'doc1', id::text from d;
set local role authenticated;
insert into t_vars select 'chatdoc', (send_chat_message(pg_temp.v('soon'), '', pg_temp.v('doc1'))).document_id::text;
select pg_temp.expect_value('chat', 'file shared in chat joins the consultation documents', $q$select (pg_temp.v('chatdoc') = pg_temp.v('doc1') and (select appointment_id from documents where id = pg_temp.v('doc1')) = pg_temp.v('soon'))::text$q$, 'true');
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('chat', 'doctor reply is stored with role doctor', $q$select (send_chat_message(pg_temp.v('soon'), 'Yes, clearly.')).sender_role$q$, 'doctor');
select pg_temp.expect_value('chat', 'doctor sees the whole thread', $q$select count(*)::text from chat_messages where appointment_id = pg_temp.v('soon')$q$, '3');
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_value('chat', 'other families see nothing', $q$select count(*)::text from chat_messages where appointment_id = pg_temp.v('soon')$q$, '0');
select pg_temp.expect_error('chat', 'other families cannot post', $q$select send_chat_message(pg_temp.v('soon'), 'hi')$q$, 'not_found');

-- ================================================================ LIVE NOTES
select pg_temp.login(:'docuser');
set local role authenticated;
select save_consult_notes(pg_temp.v('soon'), '{"chief_complaint":"Fever 3 days","advice":"Fluids"}');
select save_consult_notes(pg_temp.v('soon'), '{"chief_complaint":"Fever 3 days, chills","advice":"Fluids, rest"}');
select pg_temp.expect_value('notes', 'autosave upserts one draft', $q$select count(*) || '/' || max(chief_complaint) || '/' || max(status) from consultations where appointment_id = pg_temp.v('soon')$q$, '1/Fever 3 days, chills/draft');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('notes', 'patients cannot write notes', $q$select save_consult_notes(pg_temp.v('soon'), '{}')$q$, 'not_found');
select pg_temp.expect_value('notes', 'patients cannot read draft notes', $q$select count(*)::text from consultations where appointment_id = pg_temp.v('soon')$q$, '0');
reset role;
select pg_temp.expect_value('notes', 'note text is redacted in the audit log', $q$select (after ->> 'chief_complaint') from audit_logs where entity = 'consultations' and action = 'consultations.update' order by created_at desc limit 1$q$, '[redacted]');

-- ================================================================ NO-SHOWS
select pg_temp.login(:'docuser');
set local role authenticated;
select join_consult(pg_temp.v('solo'), 'livekit');
reset role;
update appointments set doctor_joined_at = start_at where id = pg_temp.v('solo');
select pg_temp.expect_value('join', 'doctor alone in the room: still confirmed', $q$select status from appointments where id = pg_temp.v('solo')$q$, 'confirmed');
update appointments set patient_joined_at = start_at + interval '1 minute' where id = pg_temp.v('dns');
insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at, method)
select id, 'mock', 'order_vt_' || id, 'pay_vt_' || id, 500, 'captured', now(), 'upi' from appointments where id in (pg_temp.v('dns'), pg_temp.v('bns'));
update appointments set doctor_joined_at = now() - interval '55 minutes' where id = pg_temp.v('pns');
update appointments set status = 'completed', outcome = 'completed', doctor_joined_at = start_at, patient_joined_at = start_at where id = pg_temp.v('old');
select pg_temp.expect_value('no-show', 'sweep: one doctor, one patient, one both no-show', $q$select (s ->> 'doctor_no_show') || '/' || (s ->> 'patient_no_show') || '/' || (s ->> 'both_no_show') from (select sweep_no_shows() s) x$q$, '1/1/1');
select pg_temp.expect_value('no-show', 'automatic actions wait 30 minutes (11 min: nobody; 27 min: doctor alone)', $q$select (select status from appointments where id = pg_temp.v('early')) || '/' || (select status from appointments where id = pg_temp.v('solo'))$q$, 'confirmed/confirmed');
select pg_temp.expect_value('no-show', 'nobody joined → both no-show, patient told to rebook (refund on request)', $q$select status || '/' || outcome || '/' || (select count(distinct event_key) from notifications where template_key = 'consult_missed' and variables ->> 'ref' = a.ref_code) from appointments a where id = pg_temp.v('bns')$q$, 'cancelled/both_no_show/1');
select pg_temp.expect_value('no-show', 'doctor never joined → cancelled, patient gets the fallback', $q$select status || '/' || outcome || '/' || (select count(distinct event_key) from notifications where template_key = 'doctor_unavailable' and variables ->> 'ref' = a.ref_code) from appointments a where id = pg_temp.v('dns')$q$, 'cancelled/doctor_no_show/1');
select pg_temp.expect_value('no-show', 'doctor joined, patient never did → patient no-show', $q$select status || '/' || outcome from appointments where id = pg_temp.v('pns')$q$, 'no_show/patient_no_show');
select pg_temp.expect_value('no-show', 'logged as system events', $q$select count(*)::text from call_logs where appointment_id in (pg_temp.v('dns'), pg_temp.v('pns'), pg_temp.v('bns')) and actor_role = 'system'$q$, '3');
select pg_temp.expect_value('no-show', 'consultations older than a day are never rewritten', $q$select status from appointments where id = pg_temp.v('ancient')$q$, 'confirmed');
select pg_temp.expect_value('no-show', 'upcoming / in-progress consultations untouched', $q$select (select status from appointments where id = pg_temp.v('chat')) || '/' || (select status from appointments where id = pg_temp.v('soon'))$q$, 'confirmed/in_progress');
select pg_temp.expect_value('no-show', 'second sweep is a no-op', $q$select sweep_no_shows()::text$q$, '{"both_no_show": 0, "doctor_no_show": 0, "patient_no_show": 0}');
-- 25 hours later with no choice: automatic refund for the doctor no-show only
update appointments set cancelled_at = now() - interval '25 hours' where id in (pg_temp.v('dns'), pg_temp.v('bns'));
select sweep_doctor_side_failures();
select pg_temp.expect_value('no-show', 'no automatic refund when nobody joined (doctor no-show still refunded)', $q$select (select count(*) from refunds where appointment_id = pg_temp.v('dns')) || '/' || (select count(*) from refunds where appointment_id = pg_temp.v('bns'))$q$, '1/0');
select pg_temp.expect_value('jobs', 'run_scheduled_jobs includes the no-show sweep', $q$select (run_scheduled_jobs() ? 'no_shows')::text$q$, 'true');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('jobs', 'clients cannot run the sweep', $q$select sweep_no_shows()$q$, 'permission denied');
select pg_temp.expect_value('no-show', 'both no-show: the patient can still ask for a refund', $q$select (resolve_doctor_cancellation(pg_temp.v('bns'), 'refund') ? 'refund_id')::text$q$, 'true');

-- ---------------------------------------------------------------- report
reset role;
\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
