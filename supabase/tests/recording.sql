-- =============================================================================
-- Consultation recording, part 1 (phase 11a): consent, the recording record and its state machine, storage rules.
--   * recording happens only for consultations held through the app, started and stopped by hand by the treating doctor
--   * both the doctor and the patient must have consented for THIS appointment; withdrawing stops a recording in progress
--   * the recording's storage path is chosen by the server and never shown to a client
--   * the doctor can upload under the active recording's prefix; nobody can read, overwrite or delete media through storage
--   * every change is audited; clients cannot write the tables directly
-- (Playback is 11c, capture 11b, retention 11d.) Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/recording.sql
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
/** The statement runs without error (its effect is verified separately). */
create function pg_temp.expect_ok(area text, name text, q text) returns void language plpgsql as $$
begin
  begin
    execute q;
    insert into t_results (persona, check_name, expected, actual, ok) values (area, name, 'succeeds', 'succeeded', true);
  exception when others then
    insert into t_results (persona, check_name, expected, actual, ok) values (area, name, 'succeeds', left(sqlerrm, 60), false);
  end;
end $$;
create function pg_temp.login(uid text, aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;
create function pg_temp.s(key text) returns text language sql as $$ select v from t_vars where k = key $$;

\set rajan   '00000001-0000-4000-8000-0000000000c9'
\set anjali  '00000001-0000-4000-8000-0000000000c8'
\set arun    '00000001-0000-4000-8000-000000000064'
\set admin   '00000001-0000-4000-8000-000000000001'
\set coord   '00000001-0000-4000-8000-000000000003'
\set docuser 'aaaaaaaa-0000-4000-8000-000000000006'

-- a doctor of our own; Rajan's patient (the family that consults); Anjali is an unrelated patient
insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', :'docuser', 'authenticated', 'authenticated', '919800000006', '{"full_name":"Dr. Recording Test"}', now(), now());
delete from user_roles where user_id = :'docuser';
insert into user_roles (user_id, role) values (:'docuser', 'doctor');
with d as (insert into doctors (profile_id, full_name, qualification, registration_no, registration_council, hospital_id, department_id, verification_status, modes)
           select :'docuser', 'Dr. Recording Test', 'MBBS, MD', 'TCMC-99996', 'Travancore-Cochin Medical Council', hospital_id, department_id, 'verified', '{video,audio}' from doctors limit 1 returning id)
insert into t_vars select 'doc', id::text from d;
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender) values (:'rajan', 'Recording Rx Test', '1990-01-01', 'female') returning id)
insert into t_vars select 'pt', id::text from x;

create function pg_temp.consult(p_offset int, p_key text, p_mode consult_mode, p_status appointment_status) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = pg_temp.v('doc');
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', 'booked') returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, doctor_joined_at, patient_joined_at)
  values ('RC-' || substr(md5(random()::text), 1, 8), pg_temp.v('pt'), '00000001-0000-4000-8000-0000000000c9', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes',
          p_mode, 'first', 500, p_status, case when p_status = 'in_progress' then st end, case when p_status = 'in_progress' then st end)
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  insert into t_vars values (p_key, aid::text);
  return aid;
end $$;
select pg_temp.consult(-10, 'live', 'video', 'in_progress');     -- the consultation being held
select pg_temp.consult(60, 'later', 'audio', 'confirmed');         -- not started yet
select pg_temp.consult(-300, 'done', 'video', 'completed');        -- already over
insert into t_vars select 'other', a.id::text from appointments a join doctors d on d.id = a.doctor_id where d.profile_id = :'arun' limit 1;

-- ================================================================ A. the feature switch
-- the demo seed turns recording on; this suite starts from the production default (off)
insert into app_settings (key, value) values ('recording_enabled', 'false') on conflict (key) do update set value = excluded.value;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('switch', 'consent cannot be recorded while recording is switched off (the default)', $q$select set_recording_consent(pg_temp.v('live'), true)$q$, 'recording_disabled');
reset role;
insert into app_settings (key, value) values ('recording_enabled', 'true') on conflict (key) do update set value = excluded.value;

-- ================================================================ B. consent
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('consent', 'the patient consents: one party recorded, not yet both',
  $q$select (r ->> 'party') || '/' || (r ->> 'granted') || '/' || (r ->> 'both') from (select set_recording_consent(pg_temp.v('live'), true) r) x$q$, 'patient/true/false');
reset role;
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_error('consent', 'an unrelated patient cannot', $q$select set_recording_consent(pg_temp.v('live'), true)$q$, 'not_found');
select pg_temp.expect_value('consent', '… and sees no consent rows', $q$select count(*)::text from recording_consents$q$, '0');
reset role;
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('consent', 'another doctor cannot', $q$select set_recording_consent(pg_temp.v('live'), true)$q$, 'not_found');
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('consent', 'consent closes when the consultation is over', $q$select set_recording_consent(pg_temp.v('done'), true)$q$, 'consent_closed');
select pg_temp.expect_value('consent', 'the doctor consents: now both',
  $q$select (r ->> 'party') || '/' || (r ->> 'both') from (select set_recording_consent(pg_temp.v('live'), true) r) x$q$, 'doctor/true');
select pg_temp.expect_value('consent', 'the doctor sees both parties'' consent', $q$select string_agg(party || ':' || (withdrawn_at is null), ',' order by party) from recording_consents where appointment_id = pg_temp.v('live')$q$, 'doctor:true,patient:true');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('consent', 'the patient sees the same', $q$select count(*)::text from recording_consents where appointment_id = pg_temp.v('live')$q$, '2');
reset role;
select pg_temp.login(:'coord', 'aal2');
set local role authenticated;
select pg_temp.expect_value('consent', 'staff outside the consultation see no consent rows', $q$select count(*)::text from recording_consents$q$, '0');
reset role;
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_value('consent', 'not even an admin (consent is between the two parties)', $q$select count(*)::text from recording_consents$q$, '0');
reset role;

-- ================================================================ C. starting
-- consent on the audio consultation that has not started
select pg_temp.login(:'rajan');
set local role authenticated;
select set_recording_consent(pg_temp.v('later'), true);
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
select set_recording_consent(pg_temp.v('later'), true);
select pg_temp.expect_error('start', 'not before the consultation has started', $q$select start_recording(pg_temp.v('later'))$q$, 'not_in_progress');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('start', 'the patient cannot start a recording', $q$select start_recording(pg_temp.v('live'))$q$, 'not_found');
reset role;
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('start', 'another doctor cannot', $q$select start_recording(pg_temp.v('live'))$q$, 'not_found');
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('start', 'not on someone else''s consultation', $q$select start_recording(pg_temp.v('other'))$q$, 'not_found');
-- the patient withdraws: no recording without both
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('start', 'withdrawal is recorded', $q$select (set_recording_consent(pg_temp.v('live'), false) ->> 'both')$q$, 'false');
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('start', 'no recording without the patient''s consent', $q$select start_recording(pg_temp.v('live'))$q$, 'consent_required');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('start', 'consent can be given again after withdrawing', $q$select (set_recording_consent(pg_temp.v('live'), true) ->> 'both')$q$, 'true');
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
insert into t_vars select 'rec1', (start_recording(pg_temp.v('live')) ->> 'id');
select pg_temp.expect_value('start', 'started by hand by the treating doctor; AUDIO only, even on a video consultation',
  $q$select kind || '/' || status || '/' || (started_by = auth.uid()) from consult_recordings where id = pg_temp.v('rec1')$q$, 'audio/recording/true');
select pg_temp.expect_error('start', 'one recording at a time', $q$select start_recording(pg_temp.v('live'))$q$, 'already_recording');
reset role;

-- ================================================================ D. the path is the server's secret
select pg_temp.expect_value('path', 'the server chose a path under the appointment and recording',
  $q$select (storage_prefix = 'recordings/' || appointment_id || '/' || id || '/')::text from consult_recordings where id = pg_temp.v('rec1')$q$, 'true');
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('path', 'the doctor cannot read the path', $q$select storage_prefix from consult_recordings$q$, 'permission denied');
select pg_temp.expect_value('path', '… but sees the rest of the record', $q$select (count(*) = 1)::text from (select id, status, kind, started_at, retention_until, legal_hold from consult_recordings) x$q$, 'true');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('path', 'the patient cannot read the path either', $q$select storage_prefix from consult_recordings$q$, 'permission denied');
select pg_temp.expect_value('path', 'the patient sees that a recording exists and its state (not the media)', $q$select status from consult_recordings where id = pg_temp.v('rec1')$q$, 'recording');
reset role;
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_error('path', 'nor can an admin', $q$select storage_prefix from consult_recordings$q$, 'permission denied');
select pg_temp.expect_value('path', 'an admin sees the metadata (who, when, how long), for oversight', $q$select count(*)::text from consult_recordings where id = pg_temp.v('rec1')$q$, '1');
reset role;
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_value('path', 'an unrelated patient sees nothing', $q$select count(*)::text from consult_recordings$q$, '0');
reset role;
select pg_temp.login(:'coord', 'aal2');
set local role authenticated;
select pg_temp.expect_value('path', 'a coordinator sees nothing', $q$select count(*)::text from consult_recordings$q$, '0');
reset role;
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_value('path', 'another doctor sees nothing', $q$select count(*)::text from consult_recordings$q$, '0');
reset role;

-- ================================================================ E. no direct writes
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('writes', 'the doctor cannot edit a recording record', $q$update consult_recordings set status = 'ready', retention_until = now() + interval '100 years'$q$, 'permission denied');
select pg_temp.expect_error('writes', '… or delete it', $q$delete from consult_recordings$q$, 'permission denied');
select pg_temp.expect_error('writes', '… or invent one', $q$insert into consult_recordings (appointment_id, patient_id, doctor_id, kind, started_by, storage_prefix) select appointment_id, patient_id, doctor_id, 'audio', auth.uid(), 'recordings/x/' from consult_recordings limit 1$q$, 'permission denied');
select pg_temp.expect_error('writes', '… or write a consent for the patient', $q$update recording_consents set withdrawn_at = null$q$, 'permission denied');
reset role;
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_error('writes', 'an admin cannot rewrite recording records or consent either', $q$update consult_recordings set legal_hold = false$q$, 'permission denied');
select pg_temp.expect_error('writes', '… consents', $q$delete from recording_consents$q$, 'permission denied');
reset role;

-- ================================================================ F. storage: upload under the active prefix only; nothing readable, nothing overwritable
grant select, insert, update, delete on storage.objects to authenticated;   -- hosted Supabase grants these; RLS is the lock
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_ok('storage', 'the doctor uploads a part under the active recording''s prefix',
  $q$insert into storage.objects (bucket_id, name) values ('consult-recordings', 'recordings/' || pg_temp.s('live') || '/' || pg_temp.s('rec1') || '/part-000001.webm')$q$);
select pg_temp.expect_error('storage', 'not under another recording''s prefix', $q$insert into storage.objects (bucket_id, name) values ('consult-recordings', 'recordings/' || pg_temp.s('other') || '/00000000-0000-4000-8000-000000000000/part-000001.webm')$q$, 'row-level security');
select pg_temp.expect_error('storage', 'not outside any recording', $q$insert into storage.objects (bucket_id, name) values ('consult-recordings', 'anything/else.webm')$q$, 'row-level security');
select pg_temp.expect_value('storage', 'the doctor cannot list or read the media through storage', $q$select count(*)::text from storage.objects where bucket_id = 'consult-recordings'$q$, '0');
select pg_temp.expect_value('storage', '… nor overwrite it', $q$with u as (update storage.objects set name = name || 'x' where bucket_id = 'consult-recordings' returning 1) select count(*)::text from u$q$, '0');
select pg_temp.expect_value('storage', '… nor delete it', $q$with d as (delete from storage.objects where bucket_id = 'consult-recordings' returning 1) select count(*)::text from d$q$, '0');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('storage', 'the patient cannot upload', $q$insert into storage.objects (bucket_id, name) select 'consult-recordings', storage_prefix || 'part-000002.webm' from (select 'recordings/' || pg_temp.s('live') || '/' || pg_temp.s('rec1') || '/' storage_prefix) x$q$, 'row-level security');
select pg_temp.expect_value('storage', '… nor read', $q$select count(*)::text from storage.objects where bucket_id = 'consult-recordings'$q$, '0');
reset role;
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('storage', 'another doctor cannot upload', $q$insert into storage.objects (bucket_id, name) select 'consult-recordings', storage_prefix || 'part-000002.webm' from (select 'recordings/' || pg_temp.s('live') || '/' || pg_temp.s('rec1') || '/' storage_prefix) x$q$, 'row-level security');
reset role;
select pg_temp.expect_value('storage', 'the bucket is private and limited to audio / video containers',
  $q$select (not public)::text || '/' || (allowed_mime_types @> array['audio/webm', 'video/webm']) from storage.buckets where id = 'consult-recordings'$q$, 'true/true');

-- ================================================================ G. withdrawal during a recording stops it
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('stop', 'the patient withdrawing consent stops the recording and says which one',
  $q$select (r ->> 'granted') || '/' || ((r ->> 'stopped_recording_id') = pg_temp.s('rec1')) from (select set_recording_consent(pg_temp.v('live'), false) r) x$q$, 'false/true');
select pg_temp.expect_value('stop', '… it now waits for its upload, with the reason', $q$select status || '/' || stop_reason || '/' || (ended_at is not null) from consult_recordings where id = pg_temp.v('rec1')$q$, 'uploading/consent_withdrawn/true');
reset role;

-- ================================================================ H. finishing: the file must really be there
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('finish', 'cannot finish a recording that was never started by this doctor', $q$select finish_recording(gen_random_uuid(), 1000, 'video/webm')$q$, 'not_found');
select pg_temp.expect_error('finish', 'a bad container type is refused', $q$select finish_recording(pg_temp.v('rec1'), 1000, 'application/pdf')$q$, 'invalid_mime');
select pg_temp.expect_error('finish', 'an empty file is refused', $q$select finish_recording(pg_temp.v('rec1'), 0, 'video/webm')$q$, 'invalid_size');
reset role;
select pg_temp.expect_value('storage', 'the uploaded part really is in the bucket (checked as the database owner)',
  $q$select count(*)::text from storage.objects where bucket_id = 'consult-recordings' and name = 'recordings/' || pg_temp.s('live') || '/' || pg_temp.s('rec1') || '/part-000001.webm'$q$, '1');
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_value('finish', 'the uploaded part (from section F) counts: the recording becomes ready',
  $q$select finish_recording(pg_temp.v('rec1'), 52428800, 'video/webm') ->> 'status'$q$, 'ready');
select pg_temp.expect_value('finish', '… kept for the default 90 days after it ended, with its size and type',
  $q$select (retention_until::date - ended_at::date) || '/' || size_bytes || '/' || mime_type from consult_recordings where id = pg_temp.v('rec1')$q$, '90/52428800/video/webm');
select pg_temp.expect_error('finish', 'cannot finish twice', $q$select finish_recording(pg_temp.v('rec1'), 52428800, 'video/webm')$q$, 'not_recording');
select pg_temp.expect_error('finish', 'uploads close once ready', $q$insert into storage.objects (bucket_id, name) select 'consult-recordings', 'recordings/' || pg_temp.s('live') || '/' || pg_temp.s('rec1') || '/part-000009.webm'$q$, 'row-level security');
reset role;

-- a second recording: stop by hand, retention from the hospital setting, failure path
insert into app_settings (key, value) values ('recording_retention_days', '30');
select pg_temp.login(:'rajan');
set local role authenticated;
select set_recording_consent(pg_temp.v('live'), true);
reset role;
select pg_temp.login(:'docuser');
set local role authenticated;
insert into t_vars select 'rec2', (start_recording(pg_temp.v('live')) ->> 'id');
select pg_temp.expect_value('stop', 'stopping by hand', $q$select (r ->> 'status') || '/' || ((r ->> 'duration_seconds')::int >= 0) from (select stop_recording(pg_temp.v('rec2')) r) x$q$, 'uploading/true');
select pg_temp.expect_value('stop', '… is idempotent', $q$select stop_recording(pg_temp.v('rec2')) ->> 'status'$q$, 'uploading');
select pg_temp.expect_error('finish', 'no file in storage: file_missing', $q$select finish_recording(pg_temp.v('rec2'), 1000, 'audio/webm')$q$, 'file_missing');
select pg_temp.expect_value('finish', 'failure is recorded', $q$select fail_recording(pg_temp.v('rec2'), 'upload_failed') ->> 'status'$q$, 'failed');
select pg_temp.expect_error('finish', 'a failed recording cannot be stopped or finished', $q$select stop_recording(pg_temp.v('rec2'))$q$, 'not_recording');
reset role;
-- retention follows the setting (30 days) for the next one
select pg_temp.login(:'docuser');
set local role authenticated;
insert into t_vars select 'rec3', (start_recording(pg_temp.v('live')) ->> 'id');
select stop_recording(pg_temp.v('rec3'));
insert into storage.objects (bucket_id, name) select 'consult-recordings', storage_prefix || 'part-000001.webm' from (select 'recordings/' || pg_temp.s('live') || '/' || pg_temp.s('rec3') || '/' storage_prefix) x;
select finish_recording(pg_temp.v('rec3'), 1000, 'audio/webm');
select pg_temp.expect_value('finish', 'retention comes from app_settings.recording_retention_days',
  $q$select (retention_until::date - ended_at::date)::text from consult_recordings where id = pg_temp.v('rec3')$q$, '30');
reset role;

-- ================================================================ I. switching the feature off stops new recordings
insert into app_settings (key, value) values ('recording_enabled', 'false') on conflict (key) do update set value = excluded.value;
select pg_temp.login(:'docuser');
set local role authenticated;
select pg_temp.expect_error('switch', 'with recording switched off, no new recording starts', $q$select start_recording(pg_temp.v('live'))$q$, 'recording_disabled');
reset role;

-- ================================================================ J. everything is audited
select pg_temp.expect_value('audit', 'consent changes are in the audit log, with who did them',
  $q$select (count(*) >= 4)::text from audit_logs where entity = 'recording_consents' and actor_user_id is not null$q$, 'true');
select pg_temp.expect_value('audit', 'recording starts, stops and finishes are in the audit log',
  $q$select (count(*) >= 6)::text from audit_logs where entity = 'consult_recordings' and actor_user_id = '$q$ || :'docuser' || $q$'$q$, 'true');
select pg_temp.expect_value('audit', 'the start carries its reason',
  $q$select (count(*) >= 1)::text from audit_logs where entity = 'consult_recordings' and reason = 'Recording started'$q$, 'true');

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
