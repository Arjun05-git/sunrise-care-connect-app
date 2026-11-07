-- Recording, part 4: retention. Stale recordings are failed, an admin can place a legal hold, and recordings past their retention are
-- purged by a scheduled job (supabase/functions/recordings-maintenance): the job removes the media from storage, then calls
-- mark_recording_deleted. The record itself stays (status 'deleted', deleted_at), so there is always proof of what existed and when it went.

-- A recording stuck in recording / uploading (tab closed, device lost) is failed so the "one active recording" lock is released.
create or replace function public.expire_stale_recordings(p_hours int default 6)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform set_config('app.audit_reason', 'Recording failed (stale)', true);
  update consult_recordings set status = 'failed', stop_reason = 'stale', ended_at = coalesce(ended_at, now())
   where status in ('recording', 'uploading') and started_at < now() - make_interval(hours => greatest(p_hours, 1));
  get diagnostics n = row_count;
  return n;
end $$;

-- Recordings whose media is due for removal: ready ones past retention_until, failed ones (partial media) past the retention period
-- counted from when they ended. A legal hold, or a deleted record, is never due.
create or replace function public.recordings_due_for_purge(p_limit int default 100)
returns table (id uuid, storage_prefix text) language sql stable security definer set search_path = public as $$
  select r.id, r.storage_prefix from consult_recordings r
   where r.status in ('ready', 'failed') and r.deleted_at is null and not r.legal_hold
     and coalesce(r.retention_until, coalesce(r.ended_at, r.started_at) + make_interval(days => least(greatest(coalesce((public.setting('recording_retention_days'))::int, 90), 1), 3650))) <= now()
   order by r.created_at limit greatest(p_limit, 1);
$$;

-- Called after the media is gone. Re-checks everything, so a hold placed in the meantime wins.
create or replace function public.mark_recording_deleted(p_rec uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r consult_recordings;
begin
  select * into r from consult_recordings where id = p_rec for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.legal_hold then raise exception 'legal_hold'; end if;
  if not exists (select 1 from public.recordings_due_for_purge(100000) d where d.id = r.id) then raise exception 'not_due'; end if;
  perform set_config('app.audit_reason', 'Recording purged (retention)', true);
  update consult_recordings set status = 'deleted', deleted_at = now() where id = r.id returning * into r;
  return jsonb_build_object('id', r.id, 'status', r.status);
end $$;

-- An admin freezes (or releases) a recording: it is not purged while held. A reason is mandatory and is audited.
create or replace function public.set_recording_legal_hold(p_rec uuid, p_hold boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r consult_recordings;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'reason_required'; end if;
  select * into r from consult_recordings where id = p_rec and deleted_at is null for update;
  if r.id is null then raise exception 'not_found'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  update consult_recordings set legal_hold = coalesce(p_hold, false) where id = r.id returning * into r;
  perform public.write_audit('recording.legal_hold', 'consult_recordings', r.id::text, jsonb_build_object('legal_hold', not r.legal_hold),
    jsonb_build_object('legal_hold', r.legal_hold), left(trim(p_reason), 200));
  return jsonb_build_object('id', r.id, 'legal_hold', r.legal_hold);
end $$;

revoke execute on function public.expire_stale_recordings(int), public.recordings_due_for_purge(int), public.mark_recording_deleted(uuid),
  public.set_recording_legal_hold(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.expire_stale_recordings(int), public.recordings_due_for_purge(int), public.mark_recording_deleted(uuid) to service_role;
grant execute on function public.set_recording_legal_hold(uuid, boolean, text) to authenticated, service_role;
