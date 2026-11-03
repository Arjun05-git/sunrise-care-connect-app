-- =============================================================================
-- Phase 4: fee calculation, follow-up policy engine (+ admin overrides), payments, refunds,
-- reconciliation and the admin configuration RPCs.
--
--  Money flow (amounts are whole rupees in the DB; providers get paise)
--    hold_slot()                 fee frozen on the appointment from quote_fee()
--    prepare_payment()           caller-side checks (owner, pending, hold alive, not free)
--    register_payment_order()    service: one open order per appointment
--    capture_payment()           service: idempotent; confirms the booking (or, if the hold lapsed and the
--                                slot was taken meanwhile, records an automatic full refund)
--    request_refund() / cancel_appointment()   create refunds (status initiated)
--    claim_refund() → provider → settle_refund()  service: executes refunds exactly once
--
--  Client-callable functions re-check the caller; service_role-only functions are revoked from
--  PUBLIC / anon / authenticated and are only called by edge functions holding the service key.
-- =============================================================================

-- ---------------------------------------------------------------- schema additions
create table follow_up_overrides (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients (id),
  doctor_id uuid references doctors (id),                 -- null = any doctor
  free_count int not null default 1 check (free_count between 1 and 5),
  valid_until timestamptz not null,
  reason text not null check (length(trim(reason)) >= 5),
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references profiles (id)
);
create index follow_up_overrides_patient_idx on follow_up_overrides (patient_id) where revoked_at is null;

alter table appointments add column follow_up_override_id uuid references follow_up_overrides (id);

create sequence receipt_seq;
alter table payments
  add column receipt_no text unique,
  add column verified_via text check (verified_via in ('checkout', 'webhook')),
  add column failure_reason text;
-- at most one open (unpaid) order per appointment – concurrent "Pay" taps reuse it
create unique index payments_one_open_order on payments (appointment_id) where status = 'created';

-- Sequential receipt number (financial year independent: SCR-<IST year>-NNNNNN) as soon as money is captured.
create or replace function public.assign_receipt_no()
returns trigger language plpgsql as $$
begin
  if new.receipt_no is null and new.status in ('captured', 'partially_refunded', 'refunded') then
    new.receipt_no := 'SCR-' || to_char(coalesce(new.captured_at, now()) at time zone 'Asia/Kolkata', 'YYYY') || '-' || lpad(nextval('receipt_seq')::text, 6, '0');
  end if;
  return new;
end $$;
create trigger payments_receipt_no before insert or update on payments for each row execute function public.assign_receipt_no();

alter table refunds
  add column claimed_at timestamptz,
  add column failure_reason text;

alter table follow_up_overrides enable row level security;
alter table follow_up_overrides force row level security;
create policy overrides_admin on follow_up_overrides for select using (public.staff_ok('admin', 'coordinator'));
grant select on follow_up_overrides to authenticated;

create trigger audit_follow_up_overrides after insert or update or delete on follow_up_overrides
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- follow-up policy engine
-- Decides first consult vs follow-up, and whether it is free:
--   1. index consult = latest COMPLETED, PAID consult of this patient that matches the policy's
--      doctor rule (same doctor / same department / any) and ended before the new slot
--   2. new slot within free_window_days of the index → follow-up; free while fewer than
--      free_follow_up_count free follow-ups were used against that index (cancelled ones don't count)
--   3. otherwise an active admin override (patient, optional doctor, valid until, N free) makes it free
drop function if exists public.determine_consult_type(uuid, uuid, timestamptz);
create function public.determine_consult_type(p_patient uuid, p_doctor uuid, p_start timestamptz)
returns table (consult_type consult_type, is_free boolean, index_appointment_id uuid, free_remaining int, reason text, window_ends_at timestamptz, override_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare pol follow_up_policy; d doctors; idx appointments; used int; ends timestamptz; o record;
  r_type consult_type := 'first'; r_free boolean := false; r_idx uuid; r_left int := 0; r_reason text := 'no_prior_consult'; r_ends timestamptz;
begin
  select * into pol from follow_up_policy where id = 1;
  select * into d from doctors where id = p_doctor;
  select a.* into idx from appointments a
   where a.patient_id = p_patient and a.status = 'completed' and not a.is_free and a.fee_amount > 0
     and coalesce(a.completed_at, a.end_at) <= p_start
     and (pol.match_rule = 'any' or (pol.match_rule = 'same_doctor' and a.doctor_id = d.id) or (pol.match_rule = 'same_department' and a.department_id = d.department_id))
   order by coalesce(a.completed_at, a.end_at) desc limit 1;
  if idx.id is not null then
    ends := coalesce(idx.completed_at, idx.end_at) + make_interval(days => pol.free_window_days);
    r_ends := ends;
    if p_start > ends then
      r_reason := 'window_expired';
    else
      select count(*) into used from appointments a
       where a.index_appointment_id = idx.id and a.is_free and a.follow_up_override_id is null and a.status not in ('cancelled', 'rescheduled');
      r_type := 'follow_up'; r_idx := idx.id; r_left := greatest(0, pol.free_follow_up_count - used);
      r_free := r_left > 0;
      r_reason := case when r_free then 'free_follow_up' else 'follow_up_free_exhausted' end;
    end if;
  end if;
  if r_free then
    return query select r_type, true, r_idx, r_left, r_reason, r_ends, null::uuid; return;
  end if;

  -- admin override (most specific first: doctor-specific before "any doctor", then earliest expiry)
  select ov.id, ov.free_count - (select count(*) from appointments a where a.follow_up_override_id = ov.id and a.status not in ('cancelled', 'rescheduled')) as left_n, ov.valid_until
    into o
    from follow_up_overrides ov
   where ov.patient_id = p_patient and ov.revoked_at is null and ov.valid_until >= p_start
     and (ov.doctor_id is null or ov.doctor_id = p_doctor)
     and ov.free_count > (select count(*) from appointments a where a.follow_up_override_id = ov.id and a.status not in ('cancelled', 'rescheduled'))
   order by (ov.doctor_id is null), ov.valid_until limit 1;
  if o.id is not null then
    return query select 'follow_up'::consult_type, true, r_idx, o.left_n::int, 'admin_override', o.valid_until, o.id; return;
  end if;
  return query select r_type, false, r_idx, r_left, r_reason, r_ends, null::uuid;
end $$;
revoke execute on function public.determine_consult_type from public, anon, authenticated;

-- ---------------------------------------------------------------- fee calculation
-- Fee for a doctor / mode / consult type: doctor-specific config wins over the department default;
-- a follow-up without its own fee falls back to the first-consult fee.
create or replace function public.resolve_consult_fee(p_doctor uuid, p_mode consult_mode, p_type consult_type)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(public.resolve_fee(p_doctor, p_mode, p_type), case when p_type = 'follow_up' then public.resolve_fee(p_doctor, p_mode, 'first') end);
$$;

-- Full quote for a booking. GST: healthcare services by clinical establishments are exempt, so the
-- total is the consultation fee; a free follow-up shows the waived fee as a discount.
create or replace function public.quote_fee(p_doctor uuid, p_patient uuid, p_start timestamptz, p_mode consult_mode)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare dec record; base int;
begin
  select * into dec from public.determine_consult_type(p_patient, p_doctor, p_start);
  base := public.resolve_consult_fee(p_doctor, p_mode, dec.consult_type);
  return jsonb_build_object(
    'consult_type', dec.consult_type, 'is_free', dec.is_free, 'reason', dec.reason,
    'base_fee', base, 'discount', case when dec.is_free then coalesce(base, 0) else 0 end,
    'fee', case when dec.is_free then 0 else base end, 'tax', 0,
    'index_appointment_id', dec.index_appointment_id, 'override_id', dec.override_id,
    'free_remaining', dec.free_remaining, 'window_ends_at', dec.window_ends_at);
end $$;
revoke execute on function public.quote_fee from public, anon, authenticated;

create or replace function public.booking_preview(p_doctor uuid, p_patient uuid, p_slot uuid, p_mode consult_mode)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s slots;
begin
  if p_patient not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from slots where id = p_slot and doctor_id = p_doctor;
  if s.id is null then raise exception 'slot_not_found'; end if;
  return public.quote_fee(p_doctor, p_patient, s.start_at, p_mode)
      || jsonb_build_object('slot_start', s.start_at, 'bookable', public.slot_bookable(s), 'hold_minutes', coalesce((setting('slot_hold_minutes'))::int, 10));
end $$;

create or replace function public.hold_slot(p_doctor uuid, p_patient uuid, p_slot uuid, p_mode consult_mode, p_symptoms jsonb, p_document_ids uuid[] default '{}')
returns appointments language plpgsql security definer set search_path = public as $$
declare
  s slots; d doctors; q jsonb; a appointments; old appointments;
  hold_min int := coalesce((setting('slot_hold_minutes'))::int, 10);
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_patient not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from consents where user_id = auth.uid() and consent_type = 'teleconsultation' and granted and withdrawn_at is null) then
    raise exception 'consent_required';
  end if;
  if not public.check_rate_limit('hold:' || auth.uid(), 15, 600) then raise exception 'rate_limited'; end if;
  perform public.expire_holds();

  for old in select * from appointments where booked_by_user_id = auth.uid() and status = 'pending_payment' for update loop
    perform public.release_hold(old.id);
  end loop;

  select * into d from doctors where id = p_doctor and active and verification_status = 'verified';
  if d.id is null then raise exception 'doctor_unavailable'; end if;
  if not (p_mode = any(d.modes)) then raise exception 'mode_unavailable'; end if;

  select * into s from slots where id = p_slot and doctor_id = p_doctor for update;
  if s.id is null then raise exception 'slot_not_found'; end if;
  if not public.slot_bookable(s) then raise exception 'slot_taken'; end if;
  if exists (select 1 from appointments x where x.patient_id = p_patient and x.status in ('pending_payment', 'confirmed', 'in_progress')
             and tstzrange(x.start_at, x.end_at) && tstzrange(s.start_at, s.end_at)) then
    raise exception 'patient_overlap';
  end if;

  q := public.quote_fee(p_doctor, p_patient, s.start_at, p_mode);
  if (q ->> 'fee') is null then raise exception 'fee_not_configured'; end if;

  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode,
                            consult_type, index_appointment_id, follow_up_override_id, fee_amount, is_free, status, hold_expires_at)
  values (public.make_ref_code(), p_patient, auth.uid(), d.id, d.hospital_id, d.department_id, s.id, s.start_at, s.end_at, p_mode,
          (q ->> 'consult_type')::consult_type, (q ->> 'index_appointment_id')::uuid, (q ->> 'override_id')::uuid,
          (q ->> 'fee')::int, (q ->> 'is_free')::boolean, 'pending_payment', now() + make_interval(mins => hold_min))
  returning * into a;

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

-- Home shortcut: free follow-ups by policy, plus doctor-specific admin overrides.
create or replace function public.my_free_follow_ups()
returns table (patient_id uuid, patient_name text, doctor_id uuid, doctor_name text, window_ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (x.patient_id, x.doctor_id) x.patient_id, x.patient_name, x.doctor_id, x.doctor_name, x.window_ends_at from (
    select a.patient_id, p.full_name, a.doctor_id, d.full_name, dec.window_ends_at, a.completed_at as sort_at
    from appointments a
    join patients p on p.id = a.patient_id
    join doctors d on d.id = a.doctor_id and d.active and d.verification_status = 'verified'
    cross join lateral public.determine_consult_type(a.patient_id, a.doctor_id, now()) dec
    where a.patient_id in (select public.my_patient_ids()) and a.status = 'completed' and not a.is_free
      and dec.is_free and dec.index_appointment_id = a.id
    union all
    select o.patient_id, p.full_name, o.doctor_id, d.full_name, o.valid_until, o.created_at
    from follow_up_overrides o
    join patients p on p.id = o.patient_id
    join doctors d on d.id = o.doctor_id and d.active and d.verification_status = 'verified'
    where o.patient_id in (select public.my_patient_ids()) and o.revoked_at is null and o.valid_until > now()
      and o.free_count > (select count(*) from appointments a where a.follow_up_override_id = o.id and a.status not in ('cancelled', 'rescheduled'))
  ) x (patient_id, patient_name, doctor_id, doctor_name, window_ends_at, sort_at)
  order by x.patient_id, x.doctor_id, x.sort_at desc;
$$;

-- ---------------------------------------------------------------- payments
-- Caller-side checks before an order is created (edge function, user JWT).
create or replace function public.prepare_payment(p_appt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; p payments; pr profiles; pt patients;
begin
  select * into a from appointments where id = p_appt and patient_id in (select public.my_patient_ids()) for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status = 'confirmed' then raise exception 'already_paid'; end if;
  if a.status <> 'pending_payment' or a.hold_expires_at < now() then raise exception 'hold_expired'; end if;
  if a.is_free or a.fee_amount = 0 then raise exception 'free_booking'; end if;
  if not public.check_rate_limit('pay:' || auth.uid(), 10, 600) then raise exception 'rate_limited'; end if;
  select * into p from payments where appointment_id = a.id and status = 'created';
  select * into pr from profiles where id = auth.uid();
  select * into pt from patients where id = a.patient_id;
  return jsonb_build_object('appointment_id', a.id, 'ref_code', a.ref_code, 'amount', a.fee_amount,
    'existing_order_id', p.provider_order_id, 'existing_provider', p.provider,
    'seconds_left', greatest(0, floor(extract(epoch from a.hold_expires_at - now())))::int,
    'prefill', jsonb_build_object('name', pt.full_name, 'contact', coalesce(pr.phone, ''), 'email', coalesce(pr.email, '')));
end $$;

create or replace function public.register_payment_order(p_appt uuid, p_provider text, p_order_id text, p_amount int)
returns payments language plpgsql security definer set search_path = public as $$
declare p payments;
begin
  insert into payments (appointment_id, provider, provider_order_id, amount, status)
  values (p_appt, p_provider, p_order_id, p_amount, 'created')
  on conflict (appointment_id) where status = 'created' do nothing
  returning * into p;
  if p.id is null then select * into p from payments where appointment_id = p_appt and status = 'created'; end if;
  return p;
end $$;

-- Idempotent capture (checkout verify and webhook may both arrive, in any order).
create or replace function public.capture_payment(p_order_id text, p_payment_id text, p_method text, p_amount int, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p payments; a appointments; s slots; res text; rf uuid;
begin
  select * into p from payments where provider_order_id = p_order_id for update;
  if p.id is null then raise exception 'payment_not_found'; end if;
  if p.status in ('captured', 'refunded', 'partially_refunded') then
    return jsonb_build_object('result', 'already_captured', 'appointment_id', p.appointment_id, 'payment_id', p.id, 'receipt_no', p.receipt_no,
                              'appointment_status', (select status from appointments where id = p.appointment_id));
  end if;
  if p_amount is distinct from p.amount then raise exception 'amount_mismatch'; end if;

  perform set_config('app.audit_reason', 'Payment captured via ' || p_via, true);
  update payments set status = 'captured', provider_payment_id = p_payment_id,
         method = case when p_method in ('upi', 'card', 'netbanking', 'wallet') then p_method end,
         captured_at = now(), verified_via = p_via, failure_reason = null
   where id = p.id returning * into p;

  select * into a from appointments where id = p.appointment_id for update;
  if a.status = 'pending_payment' then
    update appointments set status = 'confirmed', hold_expires_at = null where id = a.id;
    update slots set status = 'booked', held_until = null where id = a.slot_id;
    res := 'confirmed';
  elsif a.status = 'cancelled' and a.outcome = 'payment_expired' then
    -- the hold lapsed while the patient was paying: take the slot back if it's still free…
    select * into s from slots where id = a.slot_id for update;
    if s.status = 'open' and s.start_at > now()
       and not exists (select 1 from appointments x where x.slot_id = s.id and x.id <> a.id and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show'))
       and not exists (select 1 from appointments x where x.patient_id = a.patient_id and x.id <> a.id and x.status in ('pending_payment', 'confirmed', 'in_progress')
                       and tstzrange(x.start_at, x.end_at) && tstzrange(a.start_at, a.end_at)) then
      update appointments set status = 'confirmed', outcome = null, outcome_reason = null, cancelled_at = null, hold_expires_at = null where id = a.id;
      update slots set status = 'booked', held_until = null, appointment_id = a.id where id = s.id;
      res := 'confirmed_late';
    else
      -- …otherwise refund in full automatically (never keep money for a booking we can't honour)
      insert into refunds (payment_id, appointment_id, amount, reason, status)
      values (p.id, a.id, p.amount, 'Automatic full refund: slot was released before the payment completed', 'initiated')
      returning id into rf;
      res := 'refund_pending';
    end if;
  else
    res := 'confirmed';
  end if;

  if res in ('confirmed', 'confirmed_late') then
    insert into notifications (user_id, channel, template_key, variables, rendered_text, link)
    select a.booked_by_user_id, 'in_app', 'payment_received', jsonb_build_object('amount', p.amount, 'ref', a.ref_code),
           'Payment of Rs ' || p.amount || ' received for booking ' || a.ref_code || '.', '/p/book/review/' || a.id
    where exists (select 1 from notification_templates where key = 'payment_received');
  end if;
  return jsonb_build_object('result', res, 'appointment_id', a.id, 'payment_id', p.id, 'receipt_no', p.receipt_no, 'refund_id', rf,
                            'appointment_status', (select status from appointments where id = a.id));
end $$;

create or replace function public.fail_payment(p_order_id text, p_reason text)
returns void language sql security definer set search_path = public as $$
  update payments set status = 'failed', failure_reason = left(p_reason, 200)
   where provider_order_id = p_order_id and status = 'created';
$$;

-- ---------------------------------------------------------------- refunds
-- Refund policy. Patient cancellations use app_settings.cancellation_tiers (hours before start → %);
-- cancellations by the doctor, admin or system refund 100%; free consults refund nothing.
create or replace function public.refund_quote(p_appt uuid, p_cancelled_by text default 'patient', p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a appointments; p payments; paid int := 0; refunded int := 0; hrs numeric; tier jsonb; pct int := 0; rule text; amt int := 0;
begin
  select * into a from appointments where id = p_appt;
  if a.id is null or not public.can_see_appointment(a.id) and auth.uid() is not null then raise exception 'not_found'; end if;
  if p_cancelled_by not in ('patient', 'doctor', 'admin', 'system') then raise exception 'invalid_input'; end if;
  select * into p from payments where appointment_id = a.id and status in ('captured', 'partially_refunded', 'refunded') order by captured_at desc limit 1;
  if p.id is not null then
    paid := p.amount;
    select coalesce(sum(amount), 0) into refunded from refunds where payment_id = p.id and status <> 'failed';
  end if;
  hrs := extract(epoch from a.start_at - p_now) / 3600.0;
  if a.is_free or paid = 0 then
    rule := case when a.is_free then 'free_consult' else 'not_paid' end;
  elsif p_cancelled_by <> 'patient' then
    rule := 'doctor_or_admin_cancel'; pct := 100;
  else
    select t into tier from jsonb_array_elements(coalesce(setting('cancellation_tiers'), '[]')) t
     where hrs >= (t ->> 'min_hours_before')::numeric order by (t ->> 'min_hours_before')::numeric desc limit 1;
    if tier is null then rule := 'no_tier'; else rule := 'tier'; pct := (tier ->> 'percent')::int; end if;
  end if;
  amt := least(greatest(paid - refunded, 0), round(paid * pct / 100.0)::int);
  return jsonb_build_object('rule', rule, 'percent', pct, 'amount', amt, 'paid', paid, 'already_refunded', refunded,
                            'refundable', greatest(paid - refunded, 0), 'hours_before', round(hrs, 2), 'payment_id', p.id);
end $$;

-- Finance / admin: full or partial refund of a captured payment (reason mandatory, audited).
create or replace function public.request_refund(p_payment uuid, p_amount int, p_reason text)
returns refunds language plpgsql security definer set search_path = public as $$
declare p payments; done int; r refunds;
begin
  if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  select * into p from payments where id = p_payment for update;
  if p.id is null then raise exception 'not_found'; end if;
  if p.status not in ('captured', 'partially_refunded') then raise exception 'not_refundable'; end if;
  select coalesce(sum(amount), 0) into done from refunds where payment_id = p.id and status <> 'failed';
  if p_amount is null or p_amount <= 0 or p_amount > p.amount - done then raise exception 'invalid_amount'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  insert into refunds (payment_id, appointment_id, amount, reason, status, initiated_by)
  values (p.id, p.appointment_id, p_amount, left(trim(p_reason), 300), 'initiated', auth.uid())
  returning * into r;
  return r;
end $$;

-- Patient (own, confirmed, not started) or admin / coordinator cancels; refund per refund_quote().
create or replace function public.cancel_appointment(p_appt uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; staff boolean := public.staff_ok('admin', 'coordinator'); owner boolean; v_by text; q jsonb; rf uuid;
begin
  select * into a from appointments where id = p_appt for update;
  if a.id is null then raise exception 'not_found'; end if;
  owner := a.patient_id in (select public.my_patient_ids());
  if not (owner or staff) then raise exception 'not_found'; end if;
  if a.status <> 'confirmed' then raise exception 'not_cancellable'; end if;
  if not staff and a.start_at <= now() then raise exception 'too_late'; end if;
  if staff and length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  v_by := case when staff then 'admin' else 'patient' end;
  q := public.refund_quote(a.id, v_by);
  perform set_config('app.audit_reason', 'Cancelled by ' || v_by || coalesce(': ' || left(nullif(trim(p_reason), ''), 200), ''), true);
  update appointments set status = 'cancelled', outcome = case when staff then 'cancelled_by_admin' else 'cancelled_by_patient' end::appointment_outcome,
         outcome_reason = left(nullif(trim(p_reason), ''), 300), cancelled_at = now() where id = a.id;
  update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id;
  if (q ->> 'amount')::int > 0 then
    insert into refunds (payment_id, appointment_id, amount, reason, status, initiated_by)
    values ((q ->> 'payment_id')::uuid, a.id, (q ->> 'amount')::int,
            'Cancellation by ' || v_by || ' – ' || (q ->> 'percent') || '% (' || (q ->> 'rule') || ')', 'initiated', auth.uid())
    returning id into rf;
  end if;
  return q || jsonb_build_object('refund_id', rf, 'cancelled_by', v_by);
end $$;

-- Staff: put a failed refund back in the queue.
create or replace function public.retry_refund(p_refund uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform set_config('app.audit_reason', 'Refund retried', true);
  update refunds set status = 'initiated', failure_reason = null, claimed_at = null, provider_refund_id = null where id = p_refund and status = 'failed';
  if not found then raise exception 'not_retryable'; end if;
end $$;

-- Service: take a refund for execution. A claim older than 5 minutes is considered abandoned
-- (the worker then asks the provider whether the refund already exists before creating it).
create or replace function public.claim_refund(p_refund uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r refunds; p payments; stale boolean;
begin
  select * into r from refunds where id = p_refund for update;
  if r.id is null or r.status <> 'initiated' then return null; end if;
  if r.provider_refund_id is not null then return null; end if;          -- already sent; waiting for the webhook
  if r.claimed_at is not null and r.claimed_at > now() - interval '5 minutes' then return null; end if;
  stale := r.claimed_at is not null;
  update refunds set claimed_at = now() where id = r.id;
  select * into p from payments where id = r.payment_id;
  return jsonb_build_object('refund_id', r.id, 'amount', r.amount, 'provider', p.provider, 'provider_payment_id', p.provider_payment_id,
                            'ref_code', (select ref_code from appointments where id = r.appointment_id), 'retry', stale);
end $$;

create or replace function public.settle_refund(p_refund uuid, p_status refund_status, p_provider_refund_id text, p_failure text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r refunds; p payments; done int; a appointments;
begin
  select * into r from refunds where id = p_refund for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.status = 'processed' then return; end if;                       -- idempotent
  perform set_config('app.audit_reason', 'Refund ' || p_status, true);
  update refunds set status = p_status, provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id),
         processed_at = case when p_status = 'processed' then now() end, failure_reason = left(p_failure, 200), claimed_at = null
   where id = r.id;
  select * into p from payments where id = r.payment_id for update;
  select coalesce(sum(amount), 0) into done from refunds where payment_id = p.id and status = 'processed';
  update payments set status = case when done >= p.amount then 'refunded' when done > 0 then 'partially_refunded' else 'captured' end::payment_status
   where id = p.id and status in ('captured', 'partially_refunded', 'refunded');
  if p_status = 'processed' then
    select * into a from appointments where id = r.appointment_id;
    insert into notifications (user_id, channel, template_key, variables, rendered_text)
    select a.booked_by_user_id, 'in_app', 'refund_initiated', jsonb_build_object('amount', r.amount, 'ref', a.ref_code),
           'A refund of Rs ' || r.amount || ' for booking ' || a.ref_code || ' has been initiated.'
    where exists (select 1 from notification_templates where key = 'refund_initiated');
  end if;
end $$;

create or replace function public.settle_refund_by_provider_id(p_provider_refund_id text, p_status refund_status, p_failure text default null)
returns void language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  select id into rid from refunds where provider_refund_id = p_provider_refund_id;
  if rid is not null then perform public.settle_refund(rid, p_status, p_provider_refund_id, p_failure); end if;
end $$;

create or replace function public.pending_refunds()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from refunds where status = 'initiated' and provider_refund_id is null
     and (claimed_at is null or claimed_at < now() - interval '5 minutes') order by created_at limit 50;
$$;

create or replace function public.mark_settled(p_settlement_id text, p_until timestamptz)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update payments set settled = true, settlement_id = p_settlement_id
   where status in ('captured', 'partially_refunded', 'refunded') and not settled and captured_at <= p_until;
  get diagnostics n = row_count;
  return n;
end $$;

-- Receipt contents (no clinical details). Patient family or admin / finance.
create or replace function public.receipt_data(p_payment uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p payments; a appointments;
begin
  select * into p from payments where id = p_payment;
  if p.id is null or p.receipt_no is null then raise exception 'not_found'; end if;
  select * into a from appointments where id = p.appointment_id;
  if not (a.patient_id in (select public.my_patient_ids()) or public.staff_ok('admin', 'finance')) then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'receipt_no', p.receipt_no, 'ref_code', a.ref_code, 'amount', p.amount, 'currency', p.currency, 'method', p.method,
    'provider', p.provider, 'provider_payment_id', p.provider_payment_id, 'captured_at', p.captured_at, 'status', p.status,
    'patient_name', (select full_name from patients where id = a.patient_id),
    'doctor_name', (select full_name from doctors where id = a.doctor_id),
    'doctor_reg', (select registration_no from doctors where id = a.doctor_id),
    'department', (select name from departments where id = a.department_id),
    'hospital', (select jsonb_build_object('name', name, 'city', city, 'address', address, 'phone', phone) from hospitals where id = a.hospital_id),
    'mode', a.mode, 'consult_type', a.consult_type, 'start_at', a.start_at,
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('amount', r.amount, 'status', r.status, 'at', coalesce(r.processed_at, r.created_at)) order by r.created_at)
                         from refunds r where r.payment_id = p.id and r.status <> 'failed'), '[]'));
end $$;

-- ---------------------------------------------------------------- reconciliation
-- One row per money movement (captures and processed refunds) in an IST date range.
-- Booking reference only – no patient names or clinical data in exports.
create or replace function public.reconciliation_report(p_from date, p_to date)
returns table (kind text, at_ist timestamp, ref_code text, receipt_no text, provider text, order_id text, payment_id text, refund_id text,
               method text, amount int, payment_status text, refund_status text, settled boolean, settlement_id text, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'invalid_range'; end if;
  return query
    select 'payment'::text, (p.captured_at at time zone 'Asia/Kolkata'), a.ref_code, p.receipt_no, p.provider, p.provider_order_id, p.provider_payment_id, null::text,
           p.method, p.amount, p.status::text, null::text, p.settled, p.settlement_id, null::text
      from payments p join appointments a on a.id = p.appointment_id
     where p.captured_at is not null and (p.captured_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select 'refund', (coalesce(r.processed_at, r.created_at) at time zone 'Asia/Kolkata'), a.ref_code, p.receipt_no, p.provider, p.provider_order_id, p.provider_payment_id, r.provider_refund_id,
           p.method, -r.amount, p.status::text, r.status::text, p.settled, p.settlement_id, r.reason
      from refunds r join payments p on p.id = r.payment_id join appointments a on a.id = r.appointment_id
     where (coalesce(r.processed_at, r.created_at) at time zone 'Asia/Kolkata')::date between p_from and p_to
    order by 2;
end $$;

-- ---------------------------------------------------------------- admin configuration (reason required, audited)
create or replace function public.save_fee(p_scope text, p_doctor uuid, p_department uuid, p_mode consult_mode, p_type consult_type, p_amount int, p_reason text)
returns fee_config language plpgsql security definer set search_path = public as $$
declare f fee_config;
begin
  if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  if p_amount is null or p_amount < 0 or p_amount > 100000 then raise exception 'invalid_amount'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  select * into f from fee_config where scope = p_scope and coalesce(doctor_id, department_id) = coalesce(p_doctor, p_department) and mode = p_mode and consult_type = p_type;
  if f.id is null then
    insert into fee_config (scope, doctor_id, department_id, mode, consult_type, amount)
    values (p_scope, case when p_scope = 'doctor' then p_doctor end, case when p_scope = 'department' then p_department end, p_mode, p_type, p_amount)
    returning * into f;
  else
    update fee_config set amount = p_amount where id = f.id returning * into f;
  end if;
  return f;
end $$;

create or replace function public.delete_fee(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  if exists (select 1 from fee_config where id = p_id and scope = 'department') then raise exception 'department_fee_required'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  delete from fee_config where id = p_id;
end $$;

create or replace function public.update_follow_up_policy(p_window_days int, p_count int, p_match follow_up_match, p_reason text)
returns follow_up_policy language plpgsql security definer set search_path = public as $$
declare f follow_up_policy;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  if p_window_days not between 0 and 365 or p_count not between 0 and 10 then raise exception 'invalid_input'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  update follow_up_policy set free_window_days = p_window_days, free_follow_up_count = p_count, match_rule = p_match, updated_at = now() where id = 1 returning * into f;
  return f;
end $$;

create or replace function public.update_cancellation_tiers(p_tiers jsonb, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare t jsonb; seen int[] := '{}';
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  if jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) not between 1 and 6 then raise exception 'invalid_input'; end if;
  for t in select * from jsonb_array_elements(p_tiers) loop
    if (t ->> 'min_hours_before') is null or (t ->> 'percent') is null
       or (t ->> 'min_hours_before')::numeric < 0 or (t ->> 'min_hours_before')::numeric > 720
       or (t ->> 'percent')::int not between 0 and 100 then raise exception 'invalid_input'; end if;
    if (t ->> 'min_hours_before')::int = any(seen) then raise exception 'invalid_input'; end if;
    seen := seen || (t ->> 'min_hours_before')::int;
  end loop;
  if not (0 = any(seen)) then raise exception 'tier_zero_required'; end if;   -- every cancellation time must be covered
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  update app_settings set value = (select jsonb_agg(jsonb_build_object('min_hours_before', (x ->> 'min_hours_before')::numeric, 'percent', (x ->> 'percent')::int)
                                                    order by (x ->> 'min_hours_before')::numeric desc) from jsonb_array_elements(p_tiers) x),
         updated_at = now()
   where key = 'cancellation_tiers';
end $$;

create or replace function public.grant_follow_up_override(p_patient uuid, p_doctor uuid, p_count int, p_valid_until timestamptz, p_reason text)
returns follow_up_overrides language plpgsql security definer set search_path = public as $$
declare o follow_up_overrides;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  if p_valid_until <= now() or p_valid_until > now() + interval '180 days' then raise exception 'invalid_input'; end if;
  if not exists (select 1 from patients where id = p_patient and archived_at is null) then raise exception 'not_found'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  insert into follow_up_overrides (patient_id, doctor_id, free_count, valid_until, reason, created_by)
  values (p_patient, p_doctor, coalesce(p_count, 1), p_valid_until, left(trim(p_reason), 300), auth.uid())
  returning * into o;
  return o;
end $$;

create or replace function public.revoke_follow_up_override(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  update follow_up_overrides set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
end $$;

-- ---------------------------------------------------------------- grants
-- edge functions use the service role (Supabase grants this by default; explicit for plain Postgres)
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke execute on function public.resolve_consult_fee, public.register_payment_order, public.capture_payment, public.fail_payment,
  public.claim_refund, public.settle_refund, public.settle_refund_by_provider_id, public.pending_refunds, public.mark_settled
  from public, anon, authenticated;
grant execute on function public.register_payment_order, public.capture_payment, public.fail_payment, public.claim_refund,
  public.settle_refund, public.settle_refund_by_provider_id, public.pending_refunds, public.mark_settled, public.quote_fee to service_role;

revoke execute on function public.prepare_payment, public.refund_quote, public.request_refund, public.cancel_appointment, public.retry_refund,
  public.receipt_data, public.reconciliation_report, public.save_fee, public.delete_fee, public.update_follow_up_policy,
  public.update_cancellation_tiers, public.grant_follow_up_override, public.revoke_follow_up_override, public.my_free_follow_ups, public.booking_preview
  from public, anon;
grant execute on function public.prepare_payment, public.refund_quote, public.request_refund, public.cancel_appointment, public.retry_refund,
  public.receipt_data, public.reconciliation_report, public.save_fee, public.delete_fee, public.update_follow_up_policy,
  public.update_cancellation_tiers, public.grant_follow_up_override, public.revoke_follow_up_override, public.my_free_follow_ups, public.booking_preview
  to authenticated;

-- refund status only changes through settle_refund / retry_refund
drop policy if exists refunds_update_staff on refunds;
-- direct table writes for fees stay closed: changes go through save_fee / delete_fee (reason + audit)
drop policy if exists fee_write on fee_config;

-- refund worker every 5 minutes (retries abandoned / failed-to-send refunds) when pg_cron + pg_net exist
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'schedule payments-refund {"sweep":true} every 5 minutes via pg_cron + pg_net (needs the project URL and service key in Vault)';
  end if;
end $do$;
