-- =============================================================================
-- Patient booking flow (phase 3): directory, fees, consent, follow-up decision, 10-minute slot hold.
-- All writes are SECURITY DEFINER RPCs that re-check ownership; RLS still denies direct writes.
--
--  Hold lifecycle
--    hold_slot()            slot open → held (held_until = now + slot_hold_minutes), appointment pending_payment
--    confirm_free_booking() free follow-up → confirmed, slot booked (paid bookings confirm via payment, next phase)
--    release_hold()         patient goes back / timer runs out → appointment cancelled (payment_expired), slot open
--    expire_holds()         pg_cron every minute + lazily inside hold_slot(): releases any lapsed hold
-- =============================================================================

-- ---------------------------------------------------------------- utilities
create or replace function public.setting(k text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from app_settings where key = k;
$$;

create or replace function public.check_rate_limit(p_key text, p_max int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare r rate_limits;
begin
  select * into r from rate_limits where key = p_key for update;
  if not found or r.window_start < now() - make_interval(secs => p_window_seconds) then
    insert into rate_limits (key, window_start, hits) values (p_key, now(), 1)
    on conflict (key) do update set window_start = now(), hits = 1;
    return true;
  end if;
  if r.hits >= p_max then return false; end if;
  update rate_limits set hits = hits + 1 where key = p_key;
  return true;
end $$;

create or replace function public.make_ref_code()
returns text language plpgsql as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; s text := 'SC-';
begin
  for i in 1..6 loop s := s || substr(alphabet, 1 + floor(random() * 32)::int, 1); end loop;
  return s;
end $$;

-- ---------------------------------------------------------------- slots
create or replace function public.generate_slots(p_doctor uuid, p_from date, p_days int)
returns int language plpgsql security definer set search_path = public as $$
declare d doctors; day date; w record; cur timestamptz; fin timestamptz; n int := 0;
begin
  select * into d from doctors where id = p_doctor;
  for i in 0 .. p_days - 1 loop
    day := p_from + i;
    continue when exists (select 1 from holidays h where h.date = day and (h.hospital_id is null or h.hospital_id = d.hospital_id));
    for w in select * from doctor_availability where doctor_id = p_doctor and kind = 'weekly' and weekday = extract(dow from day)::int loop
      cur := (day + w.start_time) at time zone 'Asia/Kolkata';
      fin := (day + w.end_time) at time zone 'Asia/Kolkata';
      while cur + make_interval(mins => d.slot_minutes) <= fin loop
        if not exists (
          select 1 from doctor_availability b where b.doctor_id = p_doctor and b.kind = 'block' and day between b.block_date_from and b.block_date_to
            and tstzrange((day + b.start_time) at time zone 'Asia/Kolkata', (day + b.end_time) at time zone 'Asia/Kolkata') && tstzrange(cur, cur + make_interval(mins => d.slot_minutes))
        ) then
          insert into slots (doctor_id, start_at, end_at) values (p_doctor, cur, cur + make_interval(mins => d.slot_minutes)) on conflict do nothing;
          n := n + 1;
        end if;
        cur := cur + make_interval(mins => d.slot_minutes);
      end loop;
    end loop;
  end loop;
  return n;
end $$;
revoke execute on function public.generate_slots from public, anon, authenticated;

-- A slot is bookable when open (or its hold lapsed) and it starts at least 5 minutes from now.
create or replace function public.slot_bookable(s slots)
returns boolean language sql stable as $$
  select s.start_at > now() + interval '5 minutes'
     and (s.status = 'open' or (s.status = 'held' and s.held_until < now()));
$$;

-- ---------------------------------------------------------------- consent
create or replace function public.set_consents(p_types consent_type[], p_granted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t consent_type; ver text;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  foreach t in array p_types loop
    ver := coalesce(setting('consent_versions') ->> t::text, '1.0');
    update consents set withdrawn_at = now()
     where user_id = auth.uid() and consent_type = t and granted and withdrawn_at is null and (not p_granted or version <> ver);
    if p_granted and not exists (select 1 from consents where user_id = auth.uid() and consent_type = t and granted and withdrawn_at is null) then
      insert into consents (user_id, consent_type, version, granted, user_agent)
      values (auth.uid(), t, ver, true, left(coalesce(current_setting('request.headers', true), '{}')::jsonb ->> 'user-agent', 120));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- consult type & fee
create or replace function public.determine_consult_type(p_patient uuid, p_doctor uuid, p_start timestamptz)
returns table (consult_type consult_type, is_free boolean, index_appointment_id uuid, free_remaining int, reason text, window_ends_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare pol follow_up_policy; d doctors; idx appointments; used int; ends timestamptz;
begin
  select * into pol from follow_up_policy where id = 1;
  select * into d from doctors where id = p_doctor;
  -- index consult = latest COMPLETED, PAID consult matching the policy's doctor rule
  select a.* into idx from appointments a
   where a.patient_id = p_patient and a.status = 'completed' and not a.is_free and a.fee_amount > 0
     and coalesce(a.completed_at, a.start_at) <= p_start
     and (pol.match_rule = 'any' or (pol.match_rule = 'same_doctor' and a.doctor_id = d.id) or (pol.match_rule = 'same_department' and a.department_id = d.department_id))
   order by coalesce(a.completed_at, a.start_at) desc limit 1;
  if idx.id is null then
    return query select 'first'::consult_type, false, null::uuid, 0, 'no_prior_consult', null::timestamptz; return;
  end if;
  ends := coalesce(idx.completed_at, idx.start_at) + make_interval(days => pol.free_window_days);
  if p_start > ends then
    return query select 'first'::consult_type, false, null::uuid, 0, 'window_expired', ends; return;
  end if;
  select count(*) into used from appointments a where a.index_appointment_id = idx.id and a.is_free and a.status not in ('cancelled', 'rescheduled');
  return query select 'follow_up'::consult_type, (pol.free_follow_up_count - used) > 0, idx.id, greatest(0, pol.free_follow_up_count - used),
    case when (pol.free_follow_up_count - used) > 0 then 'free_follow_up' else 'follow_up_free_exhausted' end, ends;
end $$;
revoke execute on function public.determine_consult_type from public, anon, authenticated;

create or replace function public.resolve_fee(p_doctor uuid, p_mode consult_mode, p_type consult_type)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(
    (select amount from fee_config where scope = 'doctor' and doctor_id = p_doctor and mode = p_mode and consult_type = p_type),
    (select f.amount from fee_config f join doctors d on d.department_id = f.department_id
      where f.scope = 'department' and d.id = p_doctor and f.mode = p_mode and f.consult_type = p_type));
$$;

create or replace function public.doctor_fees(p_doctor uuid)
returns table (mode consult_mode, first_fee int, follow_up_fee int)
language sql stable security definer set search_path = public as $$
  select m, public.resolve_fee(p_doctor, m, 'first'), public.resolve_fee(p_doctor, m, 'follow_up')
  from doctors d, unnest(d.modes) m where d.id = p_doctor and d.active and d.verification_status = 'verified';
$$;

-- ---------------------------------------------------------------- directory
create or replace function public.search_doctors(
  p_q text default null, p_hospital uuid default null, p_department uuid default null,
  p_language text default null, p_mode consult_mode default null, p_available_today boolean default false)
returns table (
  id uuid, full_name text, photo_url text, qualification text, registration_no text, registration_council text,
  experience_years int, languages text[], modes consult_mode[], rating_avg numeric, rating_count int, bio text,
  hospital_id uuid, hospital_name text, hospital_city text, department_id uuid, department_name text, department_name_ml text,
  next_slot timestamptz, fee_from int)
language sql stable security definer set search_path = public as $$
  select d.id, d.full_name, d.photo_url, d.qualification, d.registration_no, d.registration_council, d.experience_years,
         d.languages, d.modes, d.rating_avg, d.rating_count, d.bio, h.id, h.name, h.city, dp.id, dp.name, dp.name_ml,
         ns.start_at, (select min(public.resolve_fee(d.id, m, 'first')) from unnest(d.modes) m)
  from doctors d
  join hospitals h on h.id = d.hospital_id and h.active
  join departments dp on dp.id = d.department_id and dp.active
  left join lateral (
    select s.start_at from slots s where s.doctor_id = d.id and public.slot_bookable(s) order by s.start_at limit 1
  ) ns on true
  where auth.uid() is not null
    and d.active and d.verification_status = 'verified'
    and (p_hospital is null or d.hospital_id = p_hospital)
    and (p_department is null or d.department_id = p_department)
    and (p_language is null or p_language = any(d.languages))
    and (p_mode is null or p_mode = any(d.modes))
    and (not p_available_today or (ns.start_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date)
    and (p_q is null or p_q = '' or d.full_name ilike '%' || p_q || '%' or dp.name ilike '%' || p_q || '%'
         or d.qualification ilike '%' || p_q || '%' or h.city ilike '%' || p_q || '%')
  order by ns.start_at nulls last, d.full_name;
$$;

-- ---------------------------------------------------------------- booking preview & follow-ups
create or replace function public.booking_preview(p_doctor uuid, p_patient uuid, p_slot uuid, p_mode consult_mode)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s slots; dec record; fee int;
begin
  if p_patient not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from slots where id = p_slot and doctor_id = p_doctor;
  if s.id is null then raise exception 'slot_not_found'; end if;
  select * into dec from public.determine_consult_type(p_patient, p_doctor, s.start_at);
  fee := case when dec.is_free then 0 else coalesce(public.resolve_fee(p_doctor, p_mode, dec.consult_type), public.resolve_fee(p_doctor, p_mode, 'first')) end;
  return jsonb_build_object('consult_type', dec.consult_type, 'is_free', dec.is_free, 'reason', dec.reason, 'fee', fee,
    'free_remaining', dec.free_remaining, 'window_ends_at', dec.window_ends_at, 'slot_start', s.start_at, 'bookable', public.slot_bookable(s),
    'hold_minutes', coalesce((setting('slot_hold_minutes'))::int, 10));
end $$;

-- Free follow-ups the caller's family can still use (Home shortcut).
create or replace function public.my_free_follow_ups()
returns table (patient_id uuid, patient_name text, doctor_id uuid, doctor_name text, window_ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (a.patient_id, a.doctor_id) a.patient_id, p.full_name, a.doctor_id, d.full_name, dec.window_ends_at
  from appointments a
  join patients p on p.id = a.patient_id
  join doctors d on d.id = a.doctor_id and d.active and d.verification_status = 'verified'
  cross join lateral public.determine_consult_type(a.patient_id, a.doctor_id, now()) dec
  where a.patient_id in (select public.my_patient_ids()) and a.status = 'completed' and not a.is_free
    and dec.is_free and dec.index_appointment_id = a.id
  order by a.patient_id, a.doctor_id, a.completed_at desc;
$$;

-- ---------------------------------------------------------------- holds
create or replace function public.expire_holds()
returns int language plpgsql security definer set search_path = public as $$
declare a appointments; n int := 0;
begin
  perform set_config('app.audit_reason', 'Slot hold expired', true);
  for a in select * from appointments where status = 'pending_payment' and hold_expires_at < now() for update skip locked loop
    update appointments set status = 'cancelled', outcome = 'payment_expired', outcome_reason = 'Slot hold expired', cancelled_at = now() where id = a.id;
    update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id;
    update payments set status = 'failed' where appointment_id = a.id and status = 'created';
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.expire_holds from public, anon, authenticated;

create or replace function public.hold_slot(p_doctor uuid, p_patient uuid, p_slot uuid, p_mode consult_mode, p_symptoms jsonb, p_document_ids uuid[] default '{}')
returns appointments language plpgsql security definer set search_path = public as $$
declare
  s slots; d doctors; dec record; fee int; a appointments; old appointments;
  hold_min int := coalesce((setting('slot_hold_minutes'))::int, 10);
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_patient not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from consents where user_id = auth.uid() and consent_type = 'teleconsultation' and granted and withdrawn_at is null) then
    raise exception 'consent_required';
  end if;
  if not public.check_rate_limit('hold:' || auth.uid(), 15, 600) then raise exception 'rate_limited'; end if;
  perform public.expire_holds();

  -- one hold at a time per account: starting a new one releases the previous
  for old in select * from appointments where booked_by_user_id = auth.uid() and status = 'pending_payment' for update loop
    perform public.release_hold(old.id);
  end loop;

  select * into d from doctors where id = p_doctor and active and verification_status = 'verified';
  if d.id is null then raise exception 'doctor_unavailable'; end if;
  if not (p_mode = any(d.modes)) then raise exception 'mode_unavailable'; end if;

  select * into s from slots where id = p_slot and doctor_id = p_doctor for update;   -- ★ serialise competing holds
  if s.id is null then raise exception 'slot_not_found'; end if;
  if not public.slot_bookable(s) then raise exception 'slot_taken'; end if;
  if exists (select 1 from appointments x where x.patient_id = p_patient and x.status in ('pending_payment', 'confirmed', 'in_progress')
             and tstzrange(x.start_at, x.end_at) && tstzrange(s.start_at, s.end_at)) then
    raise exception 'patient_overlap';
  end if;

  select * into dec from public.determine_consult_type(p_patient, p_doctor, s.start_at);
  fee := case when dec.is_free then 0 else coalesce(public.resolve_fee(p_doctor, p_mode, dec.consult_type), public.resolve_fee(p_doctor, p_mode, 'first')) end;
  if fee is null then raise exception 'fee_not_configured'; end if;

  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode,
                            consult_type, index_appointment_id, fee_amount, is_free, status, hold_expires_at)
  values (public.make_ref_code(), p_patient, auth.uid(), d.id, d.hospital_id, d.department_id, s.id, s.start_at, s.end_at, p_mode,
          dec.consult_type, dec.index_appointment_id, fee, dec.is_free, 'pending_payment', now() + make_interval(mins => hold_min))
  returning * into a;   -- unique(slot_id) + exclusion constraint remain the final guard

  update slots set status = 'held', held_until = a.hold_expires_at, appointment_id = a.id where id = s.id;

  insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, voice_note_path, vitals, allergies, current_medicines, past_history)
  values (a.id, left(p_symptoms ->> 'body_area', 60),
          coalesce(array(select left(x, 60) from jsonb_array_elements_text(coalesce(p_symptoms -> 'symptoms', '[]')) x limit 20), '{}'),
          left(p_symptoms ->> 'duration', 40), least(10, greatest(0, coalesce((p_symptoms ->> 'severity')::int, 0))),
          left(coalesce(p_symptoms ->> 'description', ''), 1000), null, coalesce(p_symptoms -> 'vitals', '{}'),
          left(coalesce(p_symptoms ->> 'allergies', ''), 300), left(coalesce(p_symptoms ->> 'current_medicines', ''), 500), left(coalesce(p_symptoms ->> 'past_history', ''), 500));

  update documents set appointment_id = a.id where id = any(p_document_ids) and patient_id = p_patient and appointment_id is null;
  return a;
end $$;

create or replace function public.release_hold(p_appt uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a appointments;
begin
  select * into a from appointments where id = p_appt and booked_by_user_id = auth.uid() and status = 'pending_payment' for update;
  if a.id is null then return; end if;   -- idempotent: already released / confirmed / not mine
  perform set_config('app.audit_reason', 'Slot hold released by patient', true);
  update appointments set status = 'cancelled', outcome = 'payment_expired', outcome_reason = 'Hold released', cancelled_at = now() where id = a.id;
  update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id;
  update documents set appointment_id = null where appointment_id = a.id;   -- keep uploads for the next attempt
end $$;

create or replace function public.confirm_free_booking(p_appt uuid)
returns appointments language plpgsql security definer set search_path = public as $$
declare a appointments;
begin
  select * into a from appointments where id = p_appt and booked_by_user_id = auth.uid() for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status = 'confirmed' then return a; end if;                               -- idempotent
  if a.status <> 'pending_payment' then raise exception 'hold_expired'; end if;
  if a.hold_expires_at < now() then perform public.expire_holds(); raise exception 'hold_expired'; end if;
  if not a.is_free then raise exception 'payment_required'; end if;
  update appointments set status = 'confirmed', hold_expires_at = null where id = a.id returning * into a;
  update slots set status = 'booked', held_until = null where id = a.slot_id;
  insert into notifications (user_id, channel, template_key, variables, rendered_text, link)
  select auth.uid(), 'in_app', 'booking_confirmed', jsonb_build_object('ref', a.ref_code),
         'Your free follow-up is confirmed. Ref ' || a.ref_code, '/p/appointments/' || a.id
  where exists (select 1 from notification_templates where key = 'booking_confirmed');
  return a;
end $$;


-- ---------------------------------------------------------------- profile & family
-- Patients manage themselves + family through these RPCs (one transaction for patient + dependent link,
-- and only demographic columns are writable: MRN / ABHA / ownership stay with the hospital side).
create or replace function public.save_patient(
  p_id uuid, p_full_name text, p_date_of_birth date, p_gender text, p_relation text default null,
  p_blood_group text default null, p_allergies text[] default '{}', p_phone text default null, p_email text default null, p_address text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare primary_id uuid; new_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 or length(p_full_name) > 80 then raise exception 'invalid_name'; end if;
  if p_date_of_birth is null or p_date_of_birth > current_date or p_date_of_birth < current_date - interval '120 years' then raise exception 'invalid_dob'; end if;
  if coalesce(p_phone, '') <> '' and p_phone !~ '^\+91[6-9][0-9]{9}$' then raise exception 'invalid_phone'; end if;
  if p_blood_group is not null and p_blood_group not in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') then raise exception 'invalid_blood_group'; end if;
  select id into primary_id from patients where owner_user_id = auth.uid() and is_primary and archived_at is null;

  if p_id is not null then
    if p_id not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;
    update patients set full_name = trim(p_full_name), date_of_birth = p_date_of_birth, gender = p_gender, blood_group = p_blood_group,
           allergies = coalesce(p_allergies, '{}'), phone = coalesce(p_phone, ''), email = nullif(p_email, ''), address = coalesce(p_address, '')
     where id = p_id;
    if p_relation is not null and p_id <> primary_id then update dependents set relation = p_relation where patient_id = p_id; end if;
    if p_id = primary_id then update profiles set full_name = trim(p_full_name), email = coalesce(nullif(p_email, ''), email) where id = auth.uid(); end if;
    return p_id;
  end if;

  if primary_id is null then   -- first record = the account holder
    insert into patients (owner_user_id, full_name, date_of_birth, gender, phone, email, address, blood_group, allergies, is_primary)
    values (auth.uid(), trim(p_full_name), p_date_of_birth, p_gender,
            coalesce(nullif(p_phone, ''), (select phone from profiles where id = auth.uid()), ''), nullif(p_email, ''), coalesce(p_address, ''), p_blood_group, coalesce(p_allergies, '{}'), true)
    returning id into new_id;
    update profiles set full_name = trim(p_full_name) where id = auth.uid();
    return new_id;
  end if;

  if p_relation is null then raise exception 'relation_required'; end if;
  if (select count(*) from patients where owner_user_id = auth.uid() and archived_at is null) >= 10 then raise exception 'family_limit'; end if;
  insert into patients (owner_user_id, full_name, date_of_birth, gender, phone, email, address, blood_group, allergies, is_primary)
  values (auth.uid(), trim(p_full_name), p_date_of_birth, p_gender, coalesce(p_phone, ''), nullif(p_email, ''), coalesce(p_address, ''), p_blood_group, coalesce(p_allergies, '{}'), false)
  returning id into new_id;
  insert into dependents (owner_patient_id, patient_id, relation) values (primary_id, new_id, p_relation);
  return new_id;
end $$;

-- Removing a family member archives it (records are kept for medical-record retention).
create or replace function public.archive_patient(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_id not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from patients where id = p_id and is_primary) then raise exception 'cannot_archive_self'; end if;
  if exists (select 1 from appointments where patient_id = p_id and status in ('pending_payment', 'confirmed', 'in_progress') and end_at > now()) then
    raise exception 'has_upcoming_appointments';
  end if;
  update patients set archived_at = now() where id = p_id;
end $$;

-- Hold status for the countdown: seconds left are computed on the server clock (no client clock skew).
create or replace function public.get_hold(p_appt uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', a.status, 'hold_expires_at', a.hold_expires_at,
           'seconds_left', greatest(0, floor(extract(epoch from a.hold_expires_at - now())))::int)
  from appointments a where a.id = p_appt and a.booked_by_user_id = auth.uid();
$$;

revoke execute on function public.save_patient, public.archive_patient, public.get_hold, public.hold_slot, public.release_hold, public.confirm_free_booking, public.booking_preview,
  public.my_free_follow_ups, public.search_doctors, public.doctor_fees, public.set_consents from public, anon;
grant execute on function public.save_patient, public.archive_patient, public.get_hold, public.hold_slot, public.release_hold, public.confirm_free_booking, public.booking_preview,
  public.my_free_follow_ups, public.search_doctors, public.doctor_fees, public.set_consents to authenticated;

-- ---------------------------------------------------------------- scheduling (pg_cron when available: Supabase has it)
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('scc-expire-holds', '* * * * *', 'select public.expire_holds()');
    perform cron.schedule('scc-generate-slots', '17 0 * * *',
      $$select public.generate_slots(id, (now() at time zone 'Asia/Kolkata')::date, 14) from doctors where active$$);
  else
    raise notice 'pg_cron not available: holds still expire lazily (hold_slot / confirm) and on the client timer';
  end if;
end $do$;
