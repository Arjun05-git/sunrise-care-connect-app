-- =============================================================================
-- Phase 5: doctor experience – availability, outcomes, same-day reschedule with patient response,
-- fallback (free reschedule or full refund) after doctor-side failures, scheduled jobs.
--
--  Reschedule lifecycle (reschedule_requests.status)
--    propose_reschedule()        doctor proposes another slot on the SAME day; it is held for the patient
--    respond_reschedule()        patient: accept → booking moves | decline → free reschedule ('alternate_booked')
--                                or full refund ('refund_requested')
--    expire_reschedule_requests() no answer by respond_by → 'expired', booking cancelled by doctor → fallback
--  Doctor-side failures (cancelled_by_doctor, technical_failure, doctor_no_show) → the patient chooses
--  a free reschedule with the same doctor or a full refund (resolve_doctor_cancellation); without an
--  answer the refund is issued automatically after app_settings.doctor_no_show_auto_refund_hours.
--  A moved booking becomes a NEW appointment row (old row: status 'rescheduled', ref '…-R'); payment,
--  symptoms and documents move with it, so history and audit stay intact.
-- =============================================================================

alter table reschedule_requests add column respond_by timestamptz;

-- every proposal carries its answer deadline (also rows created by imports / seed without one)
create or replace function public.reschedule_fill_deadline()
returns trigger language plpgsql as $$
begin
  if new.respond_by is null and new.proposed_start_at is not null then
    new.respond_by := least((select start_at from appointments where id = new.appointment_id), new.proposed_start_at) - interval '15 minutes';
  end if;
  return new;
end $$;
create trigger reschedule_deadline before insert on reschedule_requests for each row execute function public.reschedule_fill_deadline();

-- deadline: 15 minutes before the earlier of the original and the proposed time
create or replace function public.reschedule_deadline(r reschedule_requests)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(r.respond_by, least((select start_at from appointments where id = r.appointment_id), r.proposed_start_at) - interval '15 minutes');
$$;

-- ---------------------------------------------------------------- helpers
create or replace function public.notify_user(p_user uuid, p_template text, p_vars jsonb, p_text text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into notifications (user_id, channel, template_key, variables, rendered_text, link)
  select p_user, 'in_app', p_template, p_vars, p_text, p_link where exists (select 1 from notification_templates where key = p_template);
$$;

/** Is [start,end) inside the doctor's weekly hours, outside leave blocks and hospital holidays? */
create or replace function public.slot_in_hours(p_doctor uuid, p_start timestamptz, p_end timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from doctor_availability w
      where w.doctor_id = p_doctor and w.kind = 'weekly' and w.weekday = extract(dow from p_start at time zone 'Asia/Kolkata')::int
        and (p_start at time zone 'Asia/Kolkata')::time >= w.start_time
        and (p_end at time zone 'Asia/Kolkata')::time <= w.end_time
        and (p_start at time zone 'Asia/Kolkata')::date = (p_end at time zone 'Asia/Kolkata')::date)
    and not exists (
      select 1 from doctor_availability b
      where b.doctor_id = p_doctor and b.kind = 'block'
        and (p_start at time zone 'Asia/Kolkata')::date between b.block_date_from and b.block_date_to
        and tstzrange(((p_start at time zone 'Asia/Kolkata')::date + b.start_time) at time zone 'Asia/Kolkata',
                      ((p_start at time zone 'Asia/Kolkata')::date + b.end_time) at time zone 'Asia/Kolkata') && tstzrange(p_start, p_end))
    and not exists (
      select 1 from holidays h join doctors d on d.id = p_doctor
      where h.date = (p_start at time zone 'Asia/Kolkata')::date and (h.hospital_id is null or h.hospital_id = d.hospital_id));
$$;

-- Bring future open slots in line with availability: drop / block slots outside hours, reopen blocked
-- ones that are inside again, and generate the next 14 days. Booked and held slots are never touched.
create or replace function public.rebuild_slots(p_doctor uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from slots s
   where s.doctor_id = p_doctor and s.start_at > now() and s.status in ('open', 'blocked') and s.appointment_id is null
     and not public.slot_in_hours(p_doctor, s.start_at, s.end_at)
     and not exists (select 1 from appointments a where a.slot_id = s.id)
     and not exists (select 1 from reschedule_requests r where r.proposed_slot_id = s.id);
  update slots s set status = 'blocked'
   where s.doctor_id = p_doctor and s.start_at > now() and s.status = 'open' and s.appointment_id is null
     and not public.slot_in_hours(p_doctor, s.start_at, s.end_at);
  update slots s set status = 'open'
   where s.doctor_id = p_doctor and s.start_at > now() and s.status = 'blocked' and s.appointment_id is null
     and public.slot_in_hours(p_doctor, s.start_at, s.end_at);
  perform public.generate_slots(p_doctor, (now() at time zone 'Asia/Kolkata')::date, 14);
end $$;

/** Doctor the caller acts for: their own record, or (admin / coordinator) the one passed in. */
create or replace function public.acting_doctor(p_doctor uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare me uuid := public.my_doctor_id();
begin
  if me is not null and (p_doctor is null or p_doctor = me) then return me; end if;
  if p_doctor is not null and public.staff_ok('admin', 'coordinator') then return p_doctor; end if;
  raise exception 'forbidden' using errcode = '42501';
end $$;

-- Confirmed upcoming bookings that no longer fit the doctor's hours (after an availability change).
create or replace function public.availability_clashes(p_doctor uuid default null)
returns table (appointment_id uuid, ref_code text, start_at timestamptz, patient_name text)
language sql stable security definer set search_path = public as $$
  select a.id, a.ref_code, a.start_at, p.full_name
  from appointments a join patients p on p.id = a.patient_id
  where a.doctor_id = public.acting_doctor(p_doctor) and a.status = 'confirmed' and a.start_at > now()
    and not public.slot_in_hours(a.doctor_id, a.start_at, a.end_at)
  order by a.start_at;
$$;

-- ---------------------------------------------------------------- availability
-- Weekly hours: [{weekday 0-6 (Sun=0), start "HH:MM", end "HH:MM"}], replaces the current set.
create or replace function public.save_weekly_hours(p_rows jsonb, p_doctor uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare d uuid := public.acting_doctor(p_doctor); r jsonb; n int;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 42 then raise exception 'invalid_input'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if (r ->> 'weekday')::int not between 0 and 6 or (r ->> 'start')::time >= (r ->> 'end')::time then raise exception 'invalid_input'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_rows) x, jsonb_array_elements(p_rows) y
             where x <> y and x ->> 'weekday' = y ->> 'weekday' and (x ->> 'start')::time < (y ->> 'end')::time and (y ->> 'start')::time < (x ->> 'end')::time) then
    raise exception 'overlapping_hours';
  end if;
  perform set_config('app.audit_reason', 'Weekly hours updated', true);
  delete from doctor_availability where doctor_id = d and kind = 'weekly';
  insert into doctor_availability (doctor_id, kind, weekday, start_time, end_time)
  select d, 'weekly', (x ->> 'weekday')::int, (x ->> 'start')::time, (x ->> 'end')::time from jsonb_array_elements(p_rows) x;
  perform public.rebuild_slots(d);
  select count(*) into n from public.availability_clashes(p_doctor);
  return n;   -- bookings now outside hours (the doctor reschedules or cancels them)
end $$;

create or replace function public.add_leave(p_from date, p_to date, p_start time, p_end time, p_reason text, p_doctor uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare d uuid := public.acting_doctor(p_doctor); n int;
begin
  if p_from is null or p_to is null or p_from > p_to or p_from < (now() at time zone 'Asia/Kolkata')::date or p_to > p_from + 90 then raise exception 'invalid_input'; end if;
  if coalesce(p_start, '00:00') >= coalesce(p_end, '23:59') then raise exception 'invalid_input'; end if;
  perform set_config('app.audit_reason', 'Leave added', true);
  insert into doctor_availability (doctor_id, kind, start_time, end_time, block_date_from, block_date_to, reason)
  values (d, 'block', coalesce(p_start, '00:00'), coalesce(p_end, '23:59'), p_from, p_to, left(nullif(trim(p_reason), ''), 120));
  perform public.rebuild_slots(d);
  select count(*) into n from public.availability_clashes(p_doctor) c
   where (c.start_at at time zone 'Asia/Kolkata')::date between p_from and p_to;
  return n;   -- booked consults inside the leave (the doctor reschedules or cancels them)
end $$;

create or replace function public.remove_leave(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b doctor_availability;
begin
  select * into b from doctor_availability where id = p_id and kind = 'block';
  if b.id is null then raise exception 'not_found'; end if;
  perform public.acting_doctor(b.doctor_id);
  perform set_config('app.audit_reason', 'Leave removed', true);
  delete from doctor_availability where id = p_id;
  perform public.rebuild_slots(b.doctor_id);
end $$;

-- ---------------------------------------------------------------- moving a booking
create or replace function public.move_appointment(p_appt uuid, p_slot uuid, p_reason text, p_allow_proposal boolean default false)
returns appointments language plpgsql security definer set search_path = public as $$
declare a appointments; s slots; n appointments;
begin
  select * into a from appointments where id = p_appt for update;
  select * into s from slots where id = p_slot for update;
  if s.id is null or s.doctor_id <> a.doctor_id then raise exception 'slot_not_found'; end if;
  if s.start_at <= now() then raise exception 'slot_taken'; end if;
  if not (public.slot_bookable(s) or (p_allow_proposal and s.status = 'held' and s.appointment_id is null)) then raise exception 'slot_taken'; end if;
  if exists (select 1 from appointments x where x.patient_id = a.patient_id and x.id <> a.id and x.status in ('pending_payment', 'confirmed', 'in_progress')
             and tstzrange(x.start_at, x.end_at) && tstzrange(s.start_at, s.end_at)) then raise exception 'patient_overlap'; end if;

  perform set_config('app.audit_reason', left(p_reason, 200), true);
  -- retire the old booking (frees its slot) …
  update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id;
  update appointments set status = 'rescheduled', ref_code = ref_code || '-R', outcome_reason = coalesce(outcome_reason, left(p_reason, 300)) where id = a.id;
  -- … and create the new one with the same reference, fee and follow-up link
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type,
                            index_appointment_id, follow_up_override_id, fee_amount, is_free, status, rescheduled_from_id)
  values (a.ref_code, a.patient_id, a.booked_by_user_id, a.doctor_id, a.hospital_id, a.department_id, s.id, s.start_at, s.end_at, a.mode, a.consult_type,
          a.index_appointment_id, a.follow_up_override_id, a.fee_amount, a.is_free, 'confirmed', a.id)
  returning * into n;
  update appointments set rescheduled_to_id = n.id where id = a.id;
  update slots set status = 'booked', held_until = null, appointment_id = n.id where id = s.id;
  insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, voice_note_path, vitals, allergies, current_medicines, past_history)
  select n.id, body_area, symptoms, duration, severity, description, voice_note_path, vitals, allergies, current_medicines, past_history
    from appointment_symptoms where appointment_id = a.id;
  update documents set appointment_id = n.id where appointment_id = a.id;
  update payments set appointment_id = n.id where appointment_id = a.id;
  perform public.notify_user(a.booked_by_user_id, 'rescheduled', jsonb_build_object('ref', n.ref_code),
    'Booking ' || n.ref_code || ' has been moved to ' || to_char(n.start_at at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM') || ' IST.', '/p/appointments');
  return n;
end $$;

-- Cancel a booking for a doctor-side reason; the patient then chooses free reschedule or refund.
create or replace function public.cancel_for_doctor_reason(p_appt uuid, p_outcome appointment_outcome, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare a appointments;
begin
  select * into a from appointments where id = p_appt for update;
  perform set_config('app.audit_reason', left(p_reason, 200), true);
  update appointments set status = 'cancelled', outcome = p_outcome, outcome_reason = left(p_reason, 300), cancelled_at = now() where id = a.id;
  update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id and start_at > now();
  perform public.notify_user(a.booked_by_user_id, 'doctor_unavailable', jsonb_build_object('ref', a.ref_code),
    'Your doctor is unable to take booking ' || a.ref_code || '. Choose a free reschedule or a full refund.', '/p/appointments');
end $$;

create or replace function public.full_refund(p_appt uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare p payments; done int; rid uuid;
begin
  select * into p from payments where appointment_id = p_appt and status in ('captured', 'partially_refunded') for update;
  if p.id is null then return null; end if;
  select coalesce(sum(amount), 0) into done from refunds where payment_id = p.id and status <> 'failed';
  if p.amount - done <= 0 then return null; end if;
  insert into refunds (payment_id, appointment_id, amount, reason, status, initiated_by)
  values (p.id, p_appt, p.amount - done, left(p_reason, 300), 'initiated', auth.uid()) returning id into rid;
  return rid;
end $$;

-- ---------------------------------------------------------------- doctor actions
create or replace function public.propose_reschedule(p_appt uuid, p_slot uuid, p_reason text)
returns reschedule_requests language plpgsql security definer set search_path = public as $$
declare me uuid := public.my_doctor_id(); a appointments; s slots; r reschedule_requests; deadline timestamptz; pt patients;
begin
  if me is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  perform public.expire_reschedule_requests();
  select * into a from appointments where id = p_appt and doctor_id = me for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status <> 'confirmed' or a.start_at <= now() then raise exception 'not_reschedulable'; end if;
  if exists (select 1 from reschedule_requests where appointment_id = a.id and status = 'pending') then raise exception 'already_pending'; end if;
  select * into s from slots where id = p_slot and doctor_id = me for update;
  if s.id is null or s.id = a.slot_id then raise exception 'slot_not_found'; end if;
  if (s.start_at at time zone 'Asia/Kolkata')::date <> (a.start_at at time zone 'Asia/Kolkata')::date then raise exception 'same_day_only'; end if;
  if not public.slot_bookable(s) then raise exception 'slot_taken'; end if;
  deadline := least(a.start_at, s.start_at) - interval '15 minutes';
  if deadline < now() + interval '5 minutes' then raise exception 'too_late_to_propose'; end if;   -- cancel instead (patient gets the fallback)

  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  update slots set status = 'held', held_until = deadline, appointment_id = null where id = s.id;   -- kept for the patient until the deadline
  insert into reschedule_requests (appointment_id, requested_by, proposed_slot_id, proposed_start_at, reason, status, respond_by)
  values (a.id, 'doctor', s.id, s.start_at, left(trim(p_reason), 300), 'pending', deadline) returning * into r;
  perform public.notify_user(a.booked_by_user_id, 'reschedule_proposed', jsonb_build_object('ref', a.ref_code, 'time', to_char(s.start_at at time zone 'Asia/Kolkata', 'HH12:MI AM')),
    'Your doctor has proposed ' || to_char(s.start_at at time zone 'Asia/Kolkata', 'HH12:MI AM') || ' IST today for booking ' || a.ref_code || '. Please respond.', '/p/appointments');
  return r;
end $$;

create or replace function public.withdraw_reschedule(p_req uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r reschedule_requests;
begin
  select r2.* into r from reschedule_requests r2 join appointments a on a.id = r2.appointment_id
   where r2.id = p_req and a.doctor_id = public.my_doctor_id() and r2.status = 'pending' for update of r2;
  if r.id is null then raise exception 'not_pending'; end if;
  perform set_config('app.audit_reason', 'Reschedule proposal withdrawn by doctor', true);
  update reschedule_requests set status = 'expired', response_note = 'withdrawn', responded_at = now() where id = r.id;
  update slots set status = 'open', held_until = null where id = r.proposed_slot_id and status = 'held' and appointment_id is null;
end $$;

-- Doctor cannot take a booking at all (emergency): cancel, patient gets free reschedule or refund.
create or replace function public.doctor_cancel(p_appt uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare a appointments;
begin
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  select * into a from appointments where id = p_appt and doctor_id = public.my_doctor_id() for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status <> 'confirmed' then raise exception 'not_cancellable'; end if;
  update reschedule_requests set status = 'expired', response_note = 'doctor cancelled', responded_at = now() where appointment_id = a.id and status = 'pending';
  perform public.cancel_for_doctor_reason(a.id, 'cancelled_by_doctor', 'Doctor unavailable: ' || trim(p_reason));
end $$;

-- Outcome after (or during) the consultation.
--   completed        from the join window (10 min before start) onwards
--   patient_no_show  only after start + patient grace (10 min); refund per patient_no_show_refund_percent
--   technical_failure note required; the patient gets free reschedule or full refund
create or replace function public.record_outcome(p_appt uuid, p_outcome text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; join_min int := coalesce((setting('join_window_minutes'))::int, 10);
  grace int := coalesce((setting('patient_grace_minutes'))::int, 10); pct int := coalesce((setting('patient_no_show_refund_percent'))::int, 0);
  p payments; rid uuid;
begin
  select * into a from appointments where id = p_appt and doctor_id = public.my_doctor_id() for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status not in ('confirmed', 'in_progress') then raise exception 'outcome_recorded'; end if;
  if now() < a.start_at - make_interval(mins => join_min) then raise exception 'too_early'; end if;
  perform set_config('app.audit_reason', 'Outcome: ' || p_outcome || coalesce(' – ' || left(nullif(trim(p_note), ''), 150), ''), true);
  update reschedule_requests set status = 'expired', response_note = 'outcome recorded', responded_at = now() where appointment_id = a.id and status = 'pending';
  if p_outcome = 'completed' then
    update appointments set status = 'completed', outcome = 'completed', completed_at = now() where id = a.id;
  elsif p_outcome = 'patient_no_show' then
    if now() < a.start_at + make_interval(mins => grace) then raise exception 'grace_not_over'; end if;
    update appointments set status = 'no_show', outcome = 'patient_no_show', outcome_reason = left(nullif(trim(p_note), ''), 300) where id = a.id;
    if pct > 0 then
      select * into p from payments where appointment_id = a.id and status = 'captured';
      if p.id is not null then
        insert into refunds (payment_id, appointment_id, amount, reason, status) values (p.id, a.id, round(p.amount * pct / 100.0)::int, 'Patient no-show policy (' || pct || '%)', 'initiated') returning id into rid;
      end if;
    end if;
  elsif p_outcome = 'technical_failure' then
    if length(trim(coalesce(p_note, ''))) < 5 then raise exception 'reason_required'; end if;
    perform public.cancel_for_doctor_reason(a.id, 'technical_failure', 'Technical failure: ' || trim(p_note));
  else
    raise exception 'invalid_input';
  end if;
  return jsonb_build_object('status', (select status from appointments where id = a.id), 'refund_id', rid);
end $$;

-- ---------------------------------------------------------------- patient responses
create or replace function public.respond_reschedule(p_req uuid, p_choice text, p_slot uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r reschedule_requests; a appointments; n appointments; rid uuid; doc doctors; label text;
begin
  perform public.expire_reschedule_requests();
  select * into r from reschedule_requests where id = p_req for update;
  if r.id is null then raise exception 'not_found'; end if;
  select * into a from appointments where id = r.appointment_id for update;
  if a.patient_id not in (select public.my_patient_ids()) then raise exception 'not_found'; end if;
  if r.status <> 'pending' then raise exception 'not_pending'; end if;
  if p_choice not in ('accept', 'reschedule', 'refund') then raise exception 'invalid_input'; end if;

  if p_choice = 'accept' then
    n := public.move_appointment(a.id, r.proposed_slot_id, 'Same-day reschedule accepted by patient', true);
    update reschedule_requests set status = 'accepted', new_appointment_id = n.id, responded_at = now() where id = r.id;
    label := 'accepted';
  else
    update slots set status = 'open', held_until = null where id = r.proposed_slot_id and status = 'held' and appointment_id is null;
    if p_choice = 'reschedule' then
      if p_slot is null then raise exception 'slot_not_found'; end if;
      n := public.move_appointment(a.id, p_slot, 'Doctor reschedule declined – free reschedule chosen by patient');
      update reschedule_requests set status = 'alternate_booked', new_appointment_id = n.id, responded_at = now() where id = r.id;
      label := 'chose another time';
    else
      perform public.cancel_for_doctor_reason(a.id, 'cancelled_by_doctor', 'Doctor reschedule declined – refund chosen by patient');
      rid := public.full_refund(a.id, 'Full refund: doctor reschedule declined');
      update reschedule_requests set status = 'refund_requested', responded_at = now() where id = r.id;
      label := 'requested a refund';
    end if;
  end if;
  select * into doc from doctors where id = a.doctor_id;
  perform public.notify_user(doc.profile_id, 'reschedule_response', jsonb_build_object('ref', a.ref_code, 'response', label),
    'Patient ' || label || ' for booking ' || a.ref_code || '.', '/d');
  return jsonb_build_object('status', (select status from reschedule_requests where id = r.id), 'appointment_id', coalesce(n.id, a.id), 'refund_id', rid);
end $$;

-- After a doctor-side failure: free reschedule (same doctor) or full refund – the patient's choice.
create or replace function public.resolve_doctor_cancellation(p_appt uuid, p_choice text, p_slot uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; n appointments; rid uuid;
begin
  select * into a from appointments where id = p_appt for update;
  if a.id is null or a.patient_id not in (select public.my_patient_ids()) then raise exception 'not_found'; end if;
  if not (a.status = 'cancelled' and a.outcome in ('cancelled_by_doctor', 'technical_failure', 'doctor_no_show') and a.rescheduled_to_id is null) then raise exception 'not_eligible'; end if;
  if exists (select 1 from refunds where appointment_id = a.id and status <> 'failed') then raise exception 'already_refunded'; end if;
  if p_choice = 'reschedule' then
    n := public.move_appointment(a.id, p_slot, 'Free reschedule after ' || a.outcome);
    return jsonb_build_object('appointment_id', n.id);
  elsif p_choice = 'refund' then
    rid := public.full_refund(a.id, 'Full refund after ' || a.outcome);
    perform set_config('app.audit_reason', 'Patient chose refund after ' || a.outcome, true);
    update appointments set outcome_reason = coalesce(outcome_reason, '') || ' – refund chosen' where id = a.id;
    return jsonb_build_object('refund_id', rid);
  end if;
  raise exception 'invalid_input';
end $$;

-- ---------------------------------------------------------------- scheduled jobs
create or replace function public.expire_reschedule_requests()
returns int language plpgsql security definer set search_path = public as $$
declare r reschedule_requests; n int := 0;
begin
  for r in select * from reschedule_requests x where x.status = 'pending' and public.reschedule_deadline(x) <= now() for update skip locked loop
    update reschedule_requests set status = 'expired', response_note = 'no response', responded_at = now() where id = r.id;
    update slots set status = 'open', held_until = null where id = r.proposed_slot_id and status = 'held' and appointment_id is null;
    if (select status from appointments where id = r.appointment_id) = 'confirmed' then
      perform public.cancel_for_doctor_reason(r.appointment_id, 'cancelled_by_doctor', 'Reschedule proposal not answered in time');
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

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

create or replace function public.run_scheduled_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('holds', public.expire_holds(), 'reschedules', public.expire_reschedule_requests(), 'auto_refunds', public.sweep_doctor_side_failures());
end $$;

-- ---------------------------------------------------------------- doctor reads
-- Opening a patient's history is audited (DPDP: who looked at whose records, when).
create or replace function public.audit_patient_view(p_patient uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.doctor_sees_patient(p_patient) then raise exception 'not_found'; end if;
  perform public.write_audit('patient.view_history', 'patients', p_patient::text, null, null, 'Doctor opened patient timeline');
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.notify_user, public.slot_in_hours, public.rebuild_slots, public.move_appointment, public.cancel_for_doctor_reason,
  public.full_refund, public.expire_reschedule_requests, public.sweep_doctor_side_failures, public.run_scheduled_jobs, public.reschedule_deadline
  from public, anon, authenticated;
grant execute on function public.run_scheduled_jobs to service_role;
revoke execute on function public.acting_doctor, public.availability_clashes, public.save_weekly_hours, public.add_leave, public.remove_leave,
  public.propose_reschedule, public.withdraw_reschedule, public.doctor_cancel, public.record_outcome, public.respond_reschedule,
  public.resolve_doctor_cancellation, public.audit_patient_view from public, anon;
grant execute on function public.acting_doctor, public.availability_clashes, public.save_weekly_hours, public.add_leave, public.remove_leave,
  public.propose_reschedule, public.withdraw_reschedule, public.doctor_cancel, public.record_outcome, public.respond_reschedule,
  public.resolve_doctor_cancellation, public.audit_patient_view to authenticated;

-- availability changes go through the RPCs above (they keep slots consistent)
drop policy if exists availability_own on doctor_availability;
drop policy if exists availability_staff on doctor_availability;

-- realtime: slots too, so the doctor's calendar and patients' pickers update live (RLS applies)
do $$ begin alter publication supabase_realtime add table slots; exception when duplicate_object then null; end $$;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('scc-jobs', '* * * * *', 'select public.run_scheduled_jobs()');
  end if;
end $do$;
