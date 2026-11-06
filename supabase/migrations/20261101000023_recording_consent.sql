-- =============================================================================
-- Consultation recording, part 1 (hardening phase 11a): consent, the recording record and its state machine, storage.
-- (Capture in the browser is 11b, audited playback 11c, retention purge 11d.)
--
-- Rules:
--   * only consultations held through the app; started and stopped BY HAND by the treating doctor, while the call is in progress
--   * both parties must have consented for THIS appointment; withdrawing consent stops a recording in progress
--   * the feature is off unless app_settings.recording_enabled = true (the demo seed turns it on; production is a deliberate choice)
--   * the storage path is chosen by the server and never granted to any client (column privileges): the only way to the media
--     will be the audited playback path (11c). Storage allows the doctor to upload under the ACTIVE recording's prefix and
--     nothing else: no read, no overwrite, no delete
--   * clients cannot write either table; every change goes through the functions below and is audited
--   * retention: ready recordings get retention_until = ended_at + app_settings.recording_retention_days (default 90; the
--     purge job and legal hold handling are 11d)
-- =============================================================================

-- ---------------------------------------------------------------- consent: one row per party per appointment
create table recording_consents (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id) on delete cascade,
  party text not null check (party in ('doctor', 'patient')),
  user_id uuid not null references profiles (id),
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (appointment_id, party)
);

-- ---------------------------------------------------------------- the recording record
create table consult_recordings (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id),            -- no cascade: a recording is a record
  patient_id uuid not null references patients (id),
  doctor_id uuid not null references doctors (id),
  kind text not null check (kind in ('audio', 'video')),                 -- follows the consultation
  status text not null default 'recording' check (status in ('recording', 'uploading', 'ready', 'failed', 'deleted')),
  stop_reason text,                                                      -- stopped | consent_withdrawn | upload_failed …
  started_by uuid not null references profiles (id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds int,
  storage_prefix text not null unique,                                   -- recordings/<appointment>/<recording>/  (NOT granted to clients)
  mime_type text,
  size_bytes bigint,
  retention_until timestamptz,
  legal_hold boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index consult_recordings_one_active on consult_recordings (appointment_id) where status = 'recording';
create index consult_recordings_appt_idx on consult_recordings (appointment_id, started_at);

alter table recording_consents enable row level security;
alter table recording_consents force row level security;
alter table consult_recordings enable row level security;
alter table consult_recordings force row level security;

-- ---------------------------------------------------------------- who may see what
/** The doctor or the patient (family account) of this appointment. Staff outside the consultation are not participants. */
create or replace function public.consult_participant(p_appt uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from appointments a where a.id = p_appt and (a.doctor_id = public.my_doctor_id() or a.patient_id in (select public.my_patient_ids())));
$$;

create policy recording_consents_select on recording_consents for select using (public.consult_participant(appointment_id));
create policy consult_recordings_participant on consult_recordings for select using (public.consult_participant(appointment_id));
create policy consult_recordings_admin on consult_recordings for select using (public.staff_ok('admin'));   -- oversight: metadata only (the path is not granted)

grant select on recording_consents to authenticated;
-- every column EXCEPT storage_prefix: no client, whatever its role, can learn where the media is
grant select (id, appointment_id, patient_id, doctor_id, kind, status, stop_reason, started_by, started_at, ended_at, duration_seconds, mime_type, size_bytes,
              retention_until, legal_hold, deleted_at, created_at) on consult_recordings to authenticated;

-- both parties see consent and the recording state live (the "recording" indicator)
do $$ begin alter publication supabase_realtime add table recording_consents; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table consult_recordings; exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- audit (who, what, when, why)
create trigger audit_recording_consents after insert or update or delete on recording_consents for each row execute function public.audit_row_change();
create trigger audit_consult_recordings after insert or update or delete on consult_recordings for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- consent
/** The caller (doctor or patient of the appointment) gives or withdraws consent. Withdrawing stops a recording in progress. */
create or replace function public.set_recording_consent(p_appt uuid, p_granted boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; v_party text; stopped uuid; both_ok boolean;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_granted is null then raise exception 'invalid_input'; end if;
  select * into a from appointments where id = p_appt for update;
  if a.id is null then raise exception 'not_found'; end if;
  v_party := public.consult_role(a);
  if v_party is null then raise exception 'not_found'; end if;
  if not coalesce((public.setting('recording_enabled'))::boolean, false) then raise exception 'recording_disabled'; end if;
  if a.status not in ('confirmed', 'in_progress') then raise exception 'consent_closed'; end if;

  perform set_config('app.audit_reason', 'Recording consent ' || case when p_granted then 'given' else 'withdrawn' end || ' by the ' || v_party, true);
  if p_granted then
    insert into recording_consents (appointment_id, party, user_id) values (a.id, v_party, auth.uid())
    on conflict (appointment_id, party) do update set user_id = auth.uid(), granted_at = now(), withdrawn_at = null, updated_at = now();
  else
    update recording_consents c set withdrawn_at = now(), updated_at = now() where c.appointment_id = a.id and c.party = v_party and c.withdrawn_at is null;
    -- nobody can be recorded without consent: a recording in progress ends now and waits for its upload
    perform set_config('app.audit_reason', 'Recording stopped: consent withdrawn by the ' || v_party, true);
    update consult_recordings r set status = 'uploading', stop_reason = 'consent_withdrawn', ended_at = now(),
           duration_seconds = greatest(0, extract(epoch from now() - r.started_at))::int
     where r.appointment_id = a.id and r.status = 'recording' returning r.id into stopped;
  end if;
  select count(*) = 2 into both_ok from recording_consents c where c.appointment_id = a.id and c.withdrawn_at is null;
  return jsonb_build_object('party', v_party, 'granted', p_granted, 'both', both_ok, 'stopped_recording_id', stopped);
end $$;

-- ---------------------------------------------------------------- the recording: start → stop → finish (or fail)
/** The treating doctor starts a recording by hand. Returns the id and the server-chosen upload prefix. */
create or replace function public.start_recording(p_appt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; rid uuid := gen_random_uuid(); prefix text;
begin
  select * into a from appointments where id = p_appt for update;
  if a.id is null or a.doctor_id is distinct from public.my_doctor_id() then raise exception 'not_found'; end if;
  if not coalesce((public.setting('recording_enabled'))::boolean, false) then raise exception 'recording_disabled'; end if;
  if a.status <> 'in_progress' then raise exception 'not_in_progress'; end if;
  if (select count(*) from recording_consents c where c.appointment_id = a.id and c.withdrawn_at is null) < 2 then raise exception 'consent_required'; end if;
  if exists (select 1 from consult_recordings r where r.appointment_id = a.id and r.status = 'recording') then raise exception 'already_recording'; end if;
  prefix := 'recordings/' || a.id || '/' || rid || '/';
  perform set_config('app.audit_reason', 'Recording started', true);
  insert into consult_recordings (id, appointment_id, patient_id, doctor_id, kind, started_by, storage_prefix)
  values (rid, a.id, a.patient_id, a.doctor_id, a.mode::text, auth.uid(), prefix);
  return jsonb_build_object('id', rid, 'storage_prefix', prefix, 'kind', a.mode::text);
end $$;

/** Ends the recording (by hand); the media then waits for its upload. Repeating it is harmless. */
create or replace function public.stop_recording(p_rec uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r consult_recordings;
begin
  select * into r from consult_recordings where id = p_rec for update;
  if r.id is null or r.doctor_id is distinct from public.my_doctor_id() then raise exception 'not_found'; end if;
  if r.status = 'uploading' then return jsonb_build_object('id', r.id, 'status', r.status, 'duration_seconds', r.duration_seconds); end if;
  if r.status <> 'recording' then raise exception 'not_recording'; end if;
  perform set_config('app.audit_reason', 'Recording stopped', true);
  update consult_recordings set status = 'uploading', stop_reason = 'stopped', ended_at = now(),
         duration_seconds = greatest(0, extract(epoch from now() - started_at))::int
   where id = r.id returning * into r;
  return jsonb_build_object('id', r.id, 'status', r.status, 'duration_seconds', r.duration_seconds);
end $$;

/** The upload is complete: the file must really be in storage. Sets the retention date from the hospital's setting. */
create or replace function public.finish_recording(p_rec uuid, p_size bigint, p_mime text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r consult_recordings; days int := coalesce((public.setting('recording_retention_days'))::int, 90);
begin
  select * into r from consult_recordings where id = p_rec for update;
  if r.id is null or r.doctor_id is distinct from public.my_doctor_id() then raise exception 'not_found'; end if;
  if r.status <> 'uploading' then raise exception 'not_recording'; end if;
  if p_mime is null or p_mime not in ('audio/webm', 'video/webm', 'audio/mp4', 'video/mp4', 'audio/ogg') then raise exception 'invalid_mime'; end if;
  if p_size is null or p_size <= 0 or p_size > 524288000 then raise exception 'invalid_size'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'consult-recordings' and starts_with(o.name, r.storage_prefix)) then raise exception 'file_missing'; end if;
  days := least(greatest(days, 1), 3650);
  perform set_config('app.audit_reason', 'Recording stored', true);
  update consult_recordings set status = 'ready', size_bytes = p_size, mime_type = p_mime, retention_until = ended_at + make_interval(days => days)
   where id = r.id returning * into r;
  return jsonb_build_object('id', r.id, 'status', r.status, 'retention_until', r.retention_until);
end $$;

/** The capture or upload failed: recorded as such (the partial files are for the purge job). */
create or replace function public.fail_recording(p_rec uuid, p_reason text default 'failed')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r consult_recordings;
begin
  select * into r from consult_recordings where id = p_rec for update;
  if r.id is null or r.doctor_id is distinct from public.my_doctor_id() then raise exception 'not_found'; end if;
  if r.status not in ('recording', 'uploading') then raise exception 'not_recording'; end if;
  perform set_config('app.audit_reason', 'Recording failed', true);
  update consult_recordings set status = 'failed', stop_reason = left(coalesce(nullif(trim(p_reason), ''), 'failed'), 60), ended_at = coalesce(ended_at, now())
   where id = r.id returning * into r;
  return jsonb_build_object('id', r.id, 'status', r.status);
end $$;

-- ---------------------------------------------------------------- storage: a private bucket, upload-only for the treating doctor
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('consult-recordings', 'consult-recordings', false, 524288000, array['audio/webm', 'video/webm', 'audio/mp4', 'video/mp4', 'audio/ogg'])
on conflict (id) do nothing;

/** Is this object name under the active (recording or uploading) recording of the calling doctor? */
create or replace function public.recording_upload_ok(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from consult_recordings r
                  where r.status in ('recording', 'uploading') and r.doctor_id = public.my_doctor_id()
                    and starts_with(p_name, r.storage_prefix) and length(p_name) > length(r.storage_prefix));
$$;

-- INSERT only. No select / update / delete policy exists for this bucket: media cannot be listed, read, overwritten or removed by a client.
create policy "recordings upload" on storage.objects for insert with check (bucket_id = 'consult-recordings' and public.recording_upload_ok(name));

-- ---------------------------------------------------------------- privileges
revoke execute on function public.consult_participant(uuid), public.recording_upload_ok(text), public.set_recording_consent(uuid, boolean),
  public.start_recording(uuid), public.stop_recording(uuid), public.finish_recording(uuid, bigint, text), public.fail_recording(uuid, text) from public, anon;
grant execute on function public.consult_participant(uuid), public.recording_upload_ok(text), public.set_recording_consent(uuid, boolean),
  public.start_recording(uuid), public.stop_recording(uuid), public.finish_recording(uuid, bigint, text), public.fail_recording(uuid, text) to authenticated, service_role;
