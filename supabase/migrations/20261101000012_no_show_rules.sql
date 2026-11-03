-- =============================================================================
-- Join / no-show rules as confirmed by Sunrise (2026-10-26):
--  * "In progress" only once BOTH the doctor and the patient have joined the room.
--  * Automatic no-shows wait 30 minutes after the start (auto_doctor_no_show_minutes,
--    auto_patient_no_show_minutes). The doctor can still mark "patient didn't join" by hand after
--    patient_grace_minutes (10) – record_outcome is unchanged.
--  * Neither joined by then → outcome both_no_show: the booking is cancelled and the patient is offered
--    a free reschedule (any future date); a refund only if they ask for it – never automatic.
--  * Doctor never joined but the patient did → doctor_no_show as before (free reschedule or refund,
--    automatic refund after doctor_no_show_auto_refund_hours).
--  * The join window still closes join_close_minutes (30) after the scheduled end.
-- =============================================================================

-- Settings come from the seed / admin; the functions default to 30 when a key is absent.

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
    'auto_doctor_no_show_minutes', coalesce((setting('auto_doctor_no_show_minutes'))::int, 30),
    'auto_patient_no_show_minutes', coalesce((setting('auto_patient_no_show_minutes'))::int, 30),
    'recording', false);
end $$;

-- Same as 20261101000009 except: "in progress" only when both have joined.
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
    update appointments set doctor_joined_at = coalesce(doctor_joined_at, now()) where id = a.id returning * into a;
    name := (select full_name from doctors where id = a.doctor_id);
  else
    update appointments set patient_joined_at = coalesce(patient_joined_at, now()) where id = a.id returning * into a;
    name := split_part((select full_name from patients where id = a.patient_id), ' ', 1);   -- first name only in the room
  end if;
  if a.status = 'confirmed' and a.doctor_joined_at is not null and a.patient_joined_at is not null then
    perform set_config('app.audit_reason', 'Doctor and patient both in the room', true);
    update appointments set status = 'in_progress' where id = a.id returning * into a;
  end if;
  insert into call_logs (appointment_id, provider, room_name, event, actor_user_id, actor_role, detail)
  values (a.id, p_provider, a.video_room, 'join', auth.uid(), r, null);
  return jsonb_build_object('room', a.video_room, 'identity', r || '-' || left(md5(auth.uid()::text || a.id::text), 12), 'display_name', name,
                            'role', r, 'mode', a.mode, 'closes_at', acc ->> 'closes_at', 'recording', false);
end $$;

create or replace function public.sweep_no_shows()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; ad int := coalesce((setting('auto_doctor_no_show_minutes'))::int, 30); ap int := coalesce((setting('auto_patient_no_show_minutes'))::int, 30);
  pct int := coalesce((setting('patient_no_show_refund_percent'))::int, 0); p payments; nd int := 0; np int := 0; nb int := 0;
begin
  -- only consultations of the last day: a deploy or a paused scheduler never rewrites older history
  for a in select * from appointments where status = 'confirmed' and doctor_joined_at is null
             and start_at + make_interval(mins => ad) < now() and start_at > now() - interval '1 day' for update skip locked loop
    if a.patient_joined_at is null then
      -- neither side joined: free reschedule offered, refund only on request
      perform set_config('app.audit_reason', 'Neither doctor nor patient joined within ' || ad || ' minutes', true);
      update appointments set status = 'cancelled', outcome = 'both_no_show', cancelled_at = now(),
             outcome_reason = 'Neither doctor nor patient joined within ' || ad || ' minutes' where id = a.id;
      update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id and start_at > now();
      perform public.notify_user(a.booked_by_user_id, 'consult_missed', jsonb_build_object('ref', a.ref_code, 'link', '/p/appointments'),
        'Consultation ' || a.ref_code || ' did not take place. Book a free new time; a refund is available on request.', '/p/appointments');
      insert into call_logs (appointment_id, provider, room_name, event, actor_role, detail, source)
      values (a.id, 'system', coalesce(a.video_room, ''), 'both_no_show', 'system', json_build_object('reason', 'nobody_joined')::text, 'server');
      nb := nb + 1;
    else
      perform public.cancel_for_doctor_reason(a.id, 'doctor_no_show', 'Doctor did not join within ' || ad || ' minutes');
      insert into call_logs (appointment_id, provider, room_name, event, actor_role, detail, source)
      values (a.id, 'system', coalesce(a.video_room, ''), 'doctor_no_show', 'system', json_build_object('reason', 'doctor_grace_exceeded')::text, 'server');
      nd := nd + 1;
    end if;
  end loop;
  for a in select * from appointments where status in ('confirmed', 'in_progress') and doctor_joined_at is not null and patient_joined_at is null
             and start_at + make_interval(mins => ap) < now() and start_at > now() - interval '1 day' for update skip locked loop
    perform set_config('app.audit_reason', 'Patient did not join within ' || ap || ' minutes', true);
    update appointments set status = 'no_show', outcome = 'patient_no_show', outcome_reason = 'Patient did not join within ' || ap || ' minutes' where id = a.id;
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
  return jsonb_build_object('doctor_no_show', nd, 'patient_no_show', np, 'both_no_show', nb);
end $$;

-- the patient may resolve a both-missed consultation too (free reschedule, or a refund they ask for)
create or replace function public.resolve_doctor_cancellation(p_appt uuid, p_choice text, p_slot uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; n appointments; rid uuid;
begin
  select * into a from appointments where id = p_appt for update;
  if a.id is null or a.patient_id not in (select public.my_patient_ids()) then raise exception 'not_found'; end if;
  if not (a.status = 'cancelled' and a.outcome in ('cancelled_by_doctor', 'technical_failure', 'doctor_no_show', 'both_no_show') and a.rescheduled_to_id is null) then raise exception 'not_eligible'; end if;
  if exists (select 1 from refunds where appointment_id = a.id and status <> 'failed') then raise exception 'already_refunded'; end if;
  if p_choice = 'reschedule' then
    n := public.move_appointment(a.id, p_slot, 'Free reschedule after ' || a.outcome);
    return jsonb_build_object('appointment_id', n.id);
  elsif p_choice = 'refund' then
    rid := public.full_refund(a.id, 'Full refund after ' || a.outcome || case when a.outcome = 'both_no_show' then ' (requested by the patient)' else '' end);
    perform set_config('app.audit_reason', 'Patient chose refund after ' || a.outcome, true);
    update appointments set outcome_reason = coalesce(outcome_reason, '') || ' – refund chosen' where id = a.id;
    return jsonb_build_object('refund_id', rid);
  end if;
  raise exception 'invalid_input';
end $$;

-- automatic refunds stay for doctor-side failures only; both_no_show is refunded only on request
create or replace function public.sweep_doctor_side_failures()
returns int language plpgsql security definer set search_path = public as $$
declare a appointments; n int := 0; hrs int := coalesce((setting('doctor_no_show_auto_refund_hours'))::int, 24);
begin
  for a in select * from appointments x
            where x.status = 'cancelled' and x.outcome in ('cancelled_by_doctor', 'technical_failure', 'doctor_no_show')
              and x.rescheduled_to_id is null and x.cancelled_at < now() - make_interval(hours => hrs)
              and not exists (select 1 from refunds f where f.appointment_id = x.id and f.status <> 'failed') loop
    perform set_config('app.audit_reason', 'Automatic refund: no patient choice within ' || hrs || ' h', true);
    if public.full_refund(a.id, 'Automatic full refund after ' || a.outcome) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke execute on function public.sweep_no_shows, public.sweep_doctor_side_failures from public, anon, authenticated;
