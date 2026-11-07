-- =============================================================================
-- Recording is AUDIO ONLY (hardening phase 11b): even on a video consultation only the voices are recorded (smaller, less
-- intrusive). `kind` says what was captured, so it is always 'audio'. start_recording is otherwise unchanged (migration 023).
-- =============================================================================

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
  values (rid, a.id, a.patient_id, a.doctor_id, 'audio', auth.uid(), prefix);
  return jsonb_build_object('id', rid, 'storage_prefix', prefix, 'kind', 'audio');
end $$;
