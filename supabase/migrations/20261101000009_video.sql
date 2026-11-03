-- =============================================================================
-- Phase 6: video consultations – join windows, rooms, call logs, in-call chat, automatic no-shows.
--
--  * Join window: from join_window_minutes (10) before the start until end + join_close_minutes (30)
--    + extended_minutes. Enforced here; the video-token edge function only issues credentials after
--    join_consult() succeeds.
--  * Room names are random (no names, no appointment ids) and stored once per booking.
--  * Recording is OFF: there is no code path that starts it; app_settings.recording_enabled is false
--    and join_consult() reports it, the token never grants roomRecord.
--  * call_logs = what happened (join / leave / reconnect / quality / failure / end) from the client
--    (whitelisted events + details, never clinical text) and from the LiveKit webhook (server truth).
--  * No-show sweep (every minute with the other jobs): doctor not in the room `doctor_grace_minutes`
--    after the start → doctor no-show (patient gets free reschedule or refund); doctor joined but the
--    patient didn't within `patient_grace_minutes` → patient no-show.
-- =============================================================================

alter table appointments add column video_room text unique;
alter table call_logs add column source text not null default 'client' check (source in ('client', 'server'));
alter table call_logs add column actor_role text check (actor_role in ('patient', 'doctor', 'system'));
create index call_logs_room_idx on call_logs (room_name);

-- ---------------------------------------------------------------- access
/** Caller's role in this consultation: 'doctor', 'patient' or null. */
create or replace function public.consult_role(a appointments)
returns text language sql stable security definer set search_path = public as $$
  select case when a.doctor_id = public.my_doctor_id() then 'doctor'
              when a.patient_id in (select public.my_patient_ids()) then 'patient' end;
$$;

-- Everything the waiting room / call screen needs to decide what to show.
create or replace function public.consult_access(p_appt uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a appointments; r text; opens timestamptz; closes timestamptz;
begin
  select * into a from appointments where id = p_appt;
  r := public.consult_role(a);
  if a.id is null or r is null then raise exception 'not_found'; end if;
  opens := a.start_at - make_interval(mins => coalesce((setting('join_window_minutes'))::int, 10));
  closes := a.end_at + make_interval(mins => coalesce((setting('join_close_minutes'))::int, 30) + a.extended_minutes);
  return jsonb_build_object(
    'role', r, 'status', a.status, 'outcome', a.outcome, 'start_at', a.start_at, 'end_at', a.end_at, 'mode', a.mode,
    'opens_at', opens, 'closes_at', closes, 'now', now(),
    'can_join', a.status in ('confirmed', 'in_progress') and now() between opens and closes,
    'doctor_joined_at', a.doctor_joined_at, 'patient_joined_at', a.patient_joined_at,
    'doctor_grace_minutes', coalesce((setting('doctor_grace_minutes'))::int, 10),
    'patient_grace_minutes', coalesce((setting('patient_grace_minutes'))::int, 10),
    'recording', false);
end $$;

-- Called (as the user) by the video-token edge function before it issues credentials.
create or replace function public.join_consult(p_appt uuid, p_provider text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a appointments; r text; acc jsonb; name text;
begin
  select * into a from appointments where id = p_appt for update;
  r := public.consult_role(a);
  if a.id is null or r is null then raise exception 'not_found'; end if;
  acc := public.consult_access(p_appt);
  if a.status not in ('confirmed', 'in_progress') then raise exception 'not_joinable'; end if;
  if now() < (acc ->> 'opens_at')::timestamptz then raise exception 'too_early'; end if;
  if now() > (acc ->> 'closes_at')::timestamptz then raise exception 'window_closed'; end if;
  if p_provider not in ('livekit', 'jitsi') then raise exception 'invalid_input'; end if;
  if not public.check_rate_limit('videojoin:' || auth.uid(), 30, 600) then raise exception 'rate_limited'; end if;

  if a.video_room is null then
    update appointments set video_room = 'scc-' || translate(encode(gen_random_bytes(18), 'base64'), '+/=', 'xyz') where id = a.id returning * into a;
  end if;
  perform set_config('app.audit_reason', 'Joined video consultation', true);
  if r = 'doctor' then
    update appointments set doctor_joined_at = coalesce(doctor_joined_at, now()), status = 'in_progress' where id = a.id returning * into a;
    name := (select full_name from doctors where id = a.doctor_id);
  else
    update appointments set patient_joined_at = coalesce(patient_joined_at, now()) where id = a.id returning * into a;
    name := split_part((select full_name from patients where id = a.patient_id), ' ', 1);   -- first name only in the room
  end if;
  insert into call_logs (appointment_id, provider, room_name, event, actor_user_id, actor_role, detail)
  values (a.id, p_provider, a.video_room, 'join', auth.uid(), r, null);
  return jsonb_build_object('room', a.video_room, 'identity', r || '-' || left(md5(auth.uid()::text || a.id::text), 12), 'display_name', name,
                            'role', r, 'mode', a.mode, 'closes_at', acc ->> 'closes_at', 'recording', false);
end $$;

-- ---------------------------------------------------------------- call logs
-- Whitelisted client events; detail keeps only known, non-clinical keys.
create or replace function public.log_call_event(p_appt uuid, p_event text, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare a appointments; r text; d jsonb;
begin
  select * into a from appointments where id = p_appt;
  r := public.consult_role(a);
  if a.id is null or r is null then raise exception 'not_found'; end if;
  if p_event not in ('leave', 'reconnecting', 'reconnected', 'disconnected', 'quality', 'failure', 'device_error', 'audio_only', 'video_on', 'end') then
    raise exception 'invalid_input';
  end if;
  if p_event = 'end' and r <> 'doctor' then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.check_rate_limit('calllog:' || auth.uid(), 120, 600) then raise exception 'rate_limited'; end if;
  select coalesce(jsonb_object_agg(k, v), '{}') into d
    from jsonb_each(coalesce(p_detail, '{}')) e(k, v)
   where k in ('reason', 'quality', 'samples', 'worst', 'excellent', 'good', 'poor', 'lost', 'seconds', 'attempts', 'device', 'provider', 'code')
     and jsonb_typeof(v) in ('string', 'number') and length(v::text) <= 80;
  insert into call_logs (appointment_id, provider, room_name, event, actor_user_id, actor_role, detail)
  values (a.id, coalesce(d ->> 'provider', 'livekit'), coalesce(a.video_room, ''), p_event, auth.uid(), r, nullif(d, '{}')::text);
end $$;

-- LiveKit webhook (service): participant_joined / participant_left / room_started / room_finished.
create or replace function public.record_video_webhook(p_room text, p_event text, p_identity text, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare a appointments;
begin
  select * into a from appointments where video_room = p_room;
  if a.id is null then return; end if;   -- not our room
  insert into call_logs (appointment_id, provider, room_name, event, actor_role, detail, source)
  values (a.id, 'livekit', p_room, p_event,
          case when p_identity like 'doctor-%' then 'doctor' when p_identity like 'patient-%' then 'patient' else 'system' end,
          nullif(coalesce(p_detail, '{}'), '{}')::text, 'server');
end $$;

-- Start = both in the call, end = last leave / end / room finished, duration, quality, failures.
create or replace function public.call_summary(p_appt uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a appointments; started timestamptz; ended timestamptz; q jsonb;
begin
  select * into a from appointments where id = p_appt;
  if a.id is null or not public.can_see_appointment(a.id) then raise exception 'not_found'; end if;
  started := case when a.doctor_joined_at is not null and a.patient_joined_at is not null then greatest(a.doctor_joined_at, a.patient_joined_at) end;
  select max(created_at) into ended from call_logs where appointment_id = a.id and event in ('end', 'leave', 'room_finished', 'participant_left');
  -- each 'quality' log aggregates ~1 minute of 5-second samples from one side
  select jsonb_build_object(
      'samples', coalesce(sum(x.n), 0),
      'worst', (array_agg(x.w order by case x.w when 'lost' then 0 when 'poor' then 1 when 'good' then 2 when 'excellent' then 3 else 4 end))[1],
      'poor_share', case when sum(x.n) > 0 then round(sum(x.bad)::numeric / sum(x.n), 2) end)
    into q
    from (select detail::jsonb ->> 'worst' w, coalesce((detail::jsonb ->> 'samples')::int, 0) n,
                 coalesce((detail::jsonb ->> 'poor')::int, 0) + coalesce((detail::jsonb ->> 'lost')::int, 0) bad
            from call_logs where appointment_id = a.id and event = 'quality' and detail is not null) x;
  return jsonb_build_object(
    'provider', (select provider from call_logs where appointment_id = a.id and event = 'join' order by created_at limit 1),
    'doctor_joined_at', a.doctor_joined_at, 'patient_joined_at', a.patient_joined_at,
    'started_at', started, 'ended_at', case when started is not null and ended > started then ended end,
    'duration_seconds', case when started is not null and ended > started then extract(epoch from ended - started)::int end,
    'quality', q,
    'reconnects', (select count(*) from call_logs where appointment_id = a.id and event = 'reconnecting'),
    'failures', coalesce((select jsonb_agg(jsonb_build_object('at', created_at, 'who', actor_role, 'reason', detail::jsonb ->> 'reason') order by created_at)
                          from call_logs where appointment_id = a.id and event in ('failure', 'device_error', 'disconnected')), '[]'),
    'recording', false);
end $$;

-- ---------------------------------------------------------------- chat (sender role from the caller, never from input)
create or replace function public.send_chat_message(p_appt uuid, p_body text, p_document_id uuid default null)
returns chat_messages language plpgsql security definer set search_path = public as $$
declare a appointments; r text; acc jsonb; m chat_messages;
begin
  select * into a from appointments where id = p_appt;
  r := public.consult_role(a);
  if a.id is null or r is null then raise exception 'not_found'; end if;
  acc := public.consult_access(p_appt);
  if not (acc ->> 'can_join')::boolean then raise exception 'chat_closed'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 and p_document_id is null then raise exception 'invalid_input'; end if;
  if length(p_body) > 2000 then raise exception 'too_long'; end if;
  if p_document_id is not null and not exists (select 1 from documents where id = p_document_id and patient_id = a.patient_id) then raise exception 'forbidden'; end if;
  if not public.check_rate_limit('chat:' || auth.uid(), 60, 300) then raise exception 'rate_limited'; end if;
  if p_document_id is not null then
    update documents set appointment_id = coalesce(appointment_id, a.id) where id = p_document_id;   -- shared files join the consultation's documents
  end if;
  insert into chat_messages (appointment_id, sender_user_id, sender_role, body, document_id)
  values (a.id, auth.uid(), r, coalesce(trim(p_body), ''), p_document_id) returning * into m;
  return m;
end $$;
drop policy if exists chat_insert on chat_messages;

-- ---------------------------------------------------------------- live notes: doctor's draft consultation
create or replace function public.save_consult_notes(p_appt uuid, p_notes jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare a appointments; c consultations;
begin
  select * into a from appointments where id = p_appt and doctor_id = public.my_doctor_id();
  if a.id is null then raise exception 'not_found'; end if;
  select * into c from consultations where appointment_id = a.id;
  if c.status = 'final' then raise exception 'notes_final'; end if;
  insert into consultations (appointment_id, doctor_id, patient_id, chief_complaint, history, examination, advice, investigations, follow_up_date, updated_at)
  values (a.id, a.doctor_id, a.patient_id, left(coalesce(p_notes ->> 'chief_complaint', ''), 2000), left(coalesce(p_notes ->> 'history', ''), 4000),
          left(coalesce(p_notes ->> 'examination', ''), 4000), left(coalesce(p_notes ->> 'advice', ''), 4000), left(coalesce(p_notes ->> 'investigations', ''), 2000),
          nullif(p_notes ->> 'follow_up_date', '')::date, now())
  on conflict (appointment_id) do update set
    chief_complaint = excluded.chief_complaint, history = excluded.history, examination = excluded.examination,
    advice = excluded.advice, investigations = excluded.investigations, follow_up_date = excluded.follow_up_date, updated_at = now();
  return now();
end $$;

-- ---------------------------------------------------------------- automatic no-shows
create or replace function public.sweep_no_shows()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; dg int := coalesce((setting('doctor_grace_minutes'))::int, 10); pg int := coalesce((setting('patient_grace_minutes'))::int, 10);
  pct int := coalesce((setting('patient_no_show_refund_percent'))::int, 0); p payments; nd int := 0; np int := 0;
begin
  -- only consultations of the last day: never rewrite history
  for a in select * from appointments where status = 'confirmed' and doctor_joined_at is null
             and start_at + make_interval(mins => dg) < now() and start_at > now() - interval '1 day' for update skip locked loop
    perform public.cancel_for_doctor_reason(a.id, 'doctor_no_show', 'Doctor did not join within ' || dg || ' minutes');
    insert into call_logs (appointment_id, provider, room_name, event, actor_role, detail, source)
    values (a.id, 'system', coalesce(a.video_room, ''), 'doctor_no_show', 'system', json_build_object('reason', 'doctor_grace_exceeded')::text, 'server');
    nd := nd + 1;
  end loop;
  for a in select * from appointments where status in ('confirmed', 'in_progress') and doctor_joined_at is not null and patient_joined_at is null
             and start_at + make_interval(mins => pg) < now() and start_at > now() - interval '1 day' for update skip locked loop
    perform set_config('app.audit_reason', 'Patient did not join within ' || pg || ' minutes', true);
    update appointments set status = 'no_show', outcome = 'patient_no_show', outcome_reason = 'Patient did not join within ' || pg || ' minutes' where id = a.id;
    if pct > 0 then
      select * into p from payments where appointment_id = a.id and status = 'captured';
      if p.id is not null then
        insert into refunds (payment_id, appointment_id, amount, reason, status) values (p.id, a.id, round(p.amount * pct / 100.0)::int, 'Patient no-show policy (' || pct || '%)', 'initiated');
      end if;
    end if;
    insert into call_logs (appointment_id, provider, room_name, event, actor_role, detail, source)
    values (a.id, 'system', coalesce(a.video_room, ''), 'patient_no_show', 'system', json_build_object('reason', 'patient_grace_exceeded')::text, 'server');
    np := np + 1;
  end loop;
  return jsonb_build_object('doctor_no_show', nd, 'patient_no_show', np);
end $$;

create or replace function public.run_scheduled_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('holds', public.expire_holds(), 'reschedules', public.expire_reschedule_requests(),
                            'no_shows', public.sweep_no_shows(), 'auto_refunds', public.sweep_doctor_side_failures());
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.consult_role, public.record_video_webhook, public.sweep_no_shows, public.run_scheduled_jobs from public, anon, authenticated;
grant execute on function public.record_video_webhook, public.run_scheduled_jobs to service_role;
revoke execute on function public.consult_access, public.join_consult, public.log_call_event, public.call_summary, public.send_chat_message, public.save_consult_notes from public, anon;
grant execute on function public.consult_access, public.join_consult, public.log_call_event, public.call_summary, public.send_chat_message, public.save_consult_notes to authenticated;

-- call logs are written only through the functions above (no direct inserts)
drop policy if exists call_logs_insert on call_logs;
do $$ begin alter publication supabase_realtime add table call_logs; exception when duplicate_object then null; end $$;
