-- Recording, part 3: playback. Only the treating doctor may open a ready recording; every successful open is audited.
-- The function returns where the media is (the storage prefix, which no client may read directly); the playback edge function
-- (supabase/functions/recording-playback) calls it as the user, joins the parts and mints a short-lived link.
create or replace function public.open_recording(p_rec uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r consult_recordings;
begin
  select * into r from consult_recordings where id = p_rec and doctor_id = public.my_doctor_id();
  if r.id is null then raise exception 'not_found'; end if;
  if r.status <> 'ready' or r.deleted_at is not null then raise exception 'not_ready'; end if;
  perform public.write_audit('recording.played', 'consult_recordings', r.id::text, null,
    jsonb_build_object('appointment_id', r.appointment_id), 'Recording played by the treating doctor');
  return jsonb_build_object('id', r.id, 'appointment_id', r.appointment_id, 'storage_prefix', r.storage_prefix, 'mime_type', r.mime_type, 'size_bytes', r.size_bytes);
end $$;

revoke execute on function public.open_recording(uuid) from public, anon;
grant execute on function public.open_recording(uuid) to authenticated, service_role;
