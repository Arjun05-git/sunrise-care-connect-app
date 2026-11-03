-- =============================================================================
-- Integrations (rules confirmed by Sunrise on 2026-10-27):
--  * HIS, on events: patient master on the first confirmed booking and when identity details change;
--    consultation summary + prescription when a prescription is signed (each addendum too); billing entry
--    when a payment is captured and when a refund is paid out. Doctor master is PULLED nightly and matched
--    on the HIS doctor code (HIS is the source of truth for codes, never for registration verification).
--  * LeadSquared: only for people who gave the optional "marketing" consent; name, mobile, city and the
--    event type (signed up, booked, paid, completed, cancelled) – nothing clinical, no doctor / department.
--  * ABDM: ABHA verification + linking, optional, behind app_settings.abdm_enabled (off).
--  * Native push (Capacitor): Android (FCM) and iOS (APNs) device tokens next to Web Push.
-- The outbox stores references only; payloads are built at send time by integration_payload() (service).
-- =============================================================================

-- ---------------------------------------------------------------- flags
create or replace function public.integration_on(p_system text)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_system
    when 'abdm' then coalesce((setting('abdm_enabled'))::boolean, false)
    else coalesce((setting('integrations') ->> p_system)::boolean, false) end;
$$;

-- ---------------------------------------------------------------- consent: marketing (LeadSquared)
alter table content_versions drop constraint if exists content_versions_key_check;
alter table content_versions add constraint content_versions_key_check
  check (key in ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms', 'marketing', 'terms_of_use', 'privacy_notice', 'refund_policy'));
create or replace function public.marketing_opted_in(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select granted and withdrawn_at is null from consents
                    where user_id = p_user and consent_type = 'marketing' order by granted_at desc limit 1), false);
$$;
-- marketing is an optional consent: its texts mirror into app_settings too, a new version never forces re-consent
create or replace function public.admin_publish_content(p_key text, p_title_en text, p_title_ml text, p_body_en text, p_body_ml text, p_new_version boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); cur content_versions; ver text; rev int; consent boolean := p_key in ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms', 'marketing');
  lim int := case when p_key in ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms', 'marketing') then 1500 else 20000 end; affected int := 0;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_body_en, ''))) not between 10 and lim or length(trim(coalesce(p_body_ml, ''))) not between 10 and lim then raise exception 'invalid_body'; end if;
  select * into cur from content_versions where key = p_key order by split_part(version, '.', 1)::int desc, split_part(version, '.', 2)::int desc, revision desc limit 1;
  if cur.id is not null and trim(p_body_en) = cur.body_en and trim(p_body_ml) = cur.body_ml
     and coalesce(trim(p_title_en), '') = cur.title_en and coalesce(trim(p_title_ml), '') = cur.title_ml and not p_new_version then raise exception 'no_change'; end if;
  if cur.id is null then ver := '1.0'; rev := 1;
  elsif p_new_version then ver := (split_part(cur.version, '.', 1)::int + 1) || '.0'; rev := 1;
  else ver := cur.version; rev := cur.revision + 1; end if;
  perform set_config('app.audit_reason', why, true);
  insert into content_versions (key, version, revision, title_en, title_ml, body_en, body_ml, published_by, reason)
  values (p_key, ver, rev, coalesce(trim(p_title_en), ''), coalesce(trim(p_title_ml), ''), trim(p_body_en), trim(p_body_ml), auth.uid(), why);
  if consent then
    update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_key], jsonb_build_object('en', trim(p_body_en), 'ml', trim(p_body_ml))) where key = 'consent_texts';
    if p_new_version then
      update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_key], to_jsonb(ver)) where key = 'consent_versions';
      select count(distinct user_id) into affected from consents where consent_type = p_key::consent_type and granted and withdrawn_at is null;
    end if;
  end if;
  return jsonb_build_object('version', ver, 'revision', rev, 'reconsent', consent and p_new_version and p_key not in ('whatsapp_opt_in', 'marketing'), 'affected_users', affected);
end $$;


-- ---------------------------------------------------------------- native push tokens (Capacitor)
create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  token text not null unique check (length(token) between 20 and 4096),
  app_version text check (length(app_version) <= 40),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures int not null default 0
);
create index device_tokens_user on device_tokens (user_id);
alter table device_tokens enable row level security;
alter table device_tokens force row level security;
create policy device_tokens_own on device_tokens for select using (user_id = auth.uid());
grant select on device_tokens to authenticated;

create or replace function public.register_device_token(p_platform text, p_token text, p_app_version text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_platform not in ('android', 'ios') or length(coalesce(p_token, '')) not between 20 and 4096 then raise exception 'invalid_input'; end if;
  if (select count(*) from device_tokens where user_id = auth.uid()) >= 10 then
    delete from device_tokens where id = (select id from device_tokens where user_id = auth.uid() order by created_at limit 1);
  end if;
  insert into device_tokens (user_id, platform, token, app_version) values (auth.uid(), p_platform, p_token, left(p_app_version, 40))
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, app_version = excluded.app_version, failures = 0;
end $$;
create or replace function public.remove_device_token(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from device_tokens where token = p_token and user_id = auth.uid();
$$;
create or replace function public.device_token_result(p_token text, p_ok boolean, p_gone boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_gone then delete from device_tokens where token = p_token;
  elsif p_ok then update device_tokens set last_success_at = now(), failures = 0 where token = p_token;
  else update device_tokens set failures = failures + 1 where token = p_token;
  end if;
end $$;

-- push goes to web subscriptions AND native devices (otherwise as in 20261101000014)
create or replace function public.enqueue_notification(p_user uuid, p_template text, p_vars jsonb, p_path text, p_event_key text,
                                                      p_appt uuid default null, p_send_after timestamptz default now())
returns int language plpgsql security definer set search_path = public, extensions as $$
declare t notification_templates; pr profiles; pref notification_prefs; lang text; vars jsonb; tok text; at timestamptz; ch notification_channel;
  n int := 0; why text; body text; ek text := coalesce(p_event_key, p_template || ':' || gen_random_uuid());
begin
  if current_setting('app.suppress_notifications', true) = 'on' then return 0; end if;   -- seed / bulk imports
  select * into t from notification_templates where key = p_template and active;
  select * into pr from profiles where id = p_user;
  if t.key is null or pr.id is null then return 0; end if;
  if exists (select 1 from notifications where user_id = p_user and event_key = ek) then return 0; end if;
  select * into pref from notification_prefs where user_id = p_user;
  lang := coalesce(pr.preferred_language, 'en');
  vars := (select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each(coalesce(p_vars, '{}')) e(k, v) where k = any(t.variables) and k <> 'link');
  if p_path is not null then
    tok := encode(gen_random_bytes(16), 'hex');
    insert into notification_links (token, user_id, path) values (tok, p_user, p_path);
    vars := vars || jsonb_build_object('link', rtrim(coalesce(setting('public_url') #>> '{}', ''), '/') || '/l/' || tok);
  end if;
  at := public.quiet_hours_shift(coalesce(p_send_after, now()), t.quiet_hours);

  foreach ch in array t.channels loop
    why := null;
    if t.category = 'reminder' and pref.reminders is false and ch <> 'in_app' then why := 'opted_out'; end if;
    if ch = 'whatsapp' then
      if pr.phone is null then why := 'no_phone'; elsif not public.whatsapp_opted_in(p_user) then why := 'no_opt_in'; end if;
    elsif ch = 'sms' then
      if pr.phone is null then why := 'no_phone'; elsif pref.sms is false then why := 'opted_out'; end if;
    elsif ch = 'push' then
      -- only where a device subscribed; nothing recorded for everyone else
      continue when pref.push is false or why is not null or (not exists (select 1 from push_subscriptions where user_id = p_user) and not exists (select 1 from device_tokens where user_id = p_user));
    end if;
    body := case when lang = 'ml' then t.body_ml else t.body_en end;
    if ch = 'sms' then body := coalesce(case when lang = 'ml' then t.sms_body_ml else t.sms_body_en end, body); end if;
    insert into notifications (user_id, channel, template_key, variables, rendered_text, link, to_masked, status, error, event_key, appointment_id,
                               language, send_after, delivered_at, provider)
    values (p_user, ch, t.key, vars, public.render_text(body, vars), case when tok is not null then '/l/' || tok end,
            case when ch in ('whatsapp', 'sms') then public.mask_phone(pr.phone) end,
            (case when why is not null then 'skipped' when ch = 'in_app' and at <= now() then 'delivered' else 'queued' end)::notification_status,
            why, ek, p_appt, lang, at, case when ch = 'in_app' and at <= now() and why is null then now() end, case when ch = 'in_app' then 'app' end)
    on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.claim_notifications(p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare out jsonb;
begin
  with c as (
    select n.id from notifications n
     where n.status = 'queued' and n.send_after <= now() order by n.send_after limit least(greatest(p_limit, 1), 500) for update skip locked),
  u as (
    update notifications n set attempts = n.attempts + 1, send_after = now() + interval '5 minutes' from c where n.id = c.id returning n.*)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'channel', u.channel, 'template_key', u.template_key, 'variables', u.variables, 'text', u.rendered_text, 'language', u.language,
      'attempts', u.attempts, 'phone', pr.phone, 'category', t.category, 'whatsapp_template', t.provider_template_name, 'sms_dlt_template_id', t.sms_dlt_template_id,
      'push_title', case when u.language = 'ml' then t.push_title_ml else t.push_title_en end, 'link', u.variables ->> 'link',
      'subscriptions', case when u.channel = 'push' then (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]')
                                                           from push_subscriptions s where s.user_id = u.user_id) end,
      'devices', case when u.channel = 'push' then (select coalesce(jsonb_agg(jsonb_build_object('platform', d.platform, 'token', d.token)), '[]')
                                                     from device_tokens d where d.user_id = u.user_id) end)), '[]')
    into out
    from u join profiles pr on pr.id = u.user_id join notification_templates t on t.key = u.template_key;
  return out;
end $$;


-- ---------------------------------------------------------------- patients: HIS + ABHA identity
alter table patients
  add column his_synced_at timestamptz,
  add column abha_address text check (abha_address ~ '^[a-z0-9._]{3,32}@(abdm|sbx)$'),
  add column abha_verified_at timestamptz,
  add column abha_linked_by uuid references profiles(id);
alter table patients add constraint patients_abha_number_format check (abha_number is null or abha_number ~ '^\d{2}-\d{4}-\d{4}-\d{4}$');
create unique index patients_abha_number_uq on patients (abha_number) where abha_number is not null and archived_at is null;

-- ---------------------------------------------------------------- outbox
create table integration_events (
  id uuid primary key default gen_random_uuid(),
  system text not null check (system in ('his', 'leadsquared', 'abdm')),
  kind text not null check (kind in ('patient_upsert', 'consultation_summary', 'prescription', 'billing_payment', 'billing_refund', 'lead_event')),
  entity_id uuid not null,
  user_id uuid references profiles(id) on delete set null,        -- lead events: the person (consent is re-checked when sending)
  event text check (event in ('signed_up', 'booked', 'paid', 'completed', 'cancelled')),
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text check (length(last_error) <= 200),
  external_ref text check (length(external_ref) <= 200),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index integration_events_due on integration_events (next_attempt_at) where status = 'queued';
create index integration_events_entity on integration_events (entity_id);
alter table integration_events enable row level security;
alter table integration_events force row level security;
create policy integration_events_admin on integration_events for select using (public.staff_ok('admin'));
grant select on integration_events to authenticated;

create or replace function public.enqueue_integration(p_system text, p_kind text, p_entity uuid, p_key text, p_user uuid default null, p_event text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.suppress_notifications', true) = 'on' then return false; end if;   -- seed / bulk imports
  if not public.integration_on(p_system) then return false; end if;
  if p_system = 'leadsquared' and not public.marketing_opted_in(p_user) then return false; end if;
  insert into integration_events (system, kind, entity_id, user_id, event, idempotency_key) values (p_system, p_kind, p_entity, p_user, p_event, p_key)
  on conflict (idempotency_key) do nothing;
  return found;
end $$;

-- identity fields HIS cares about (incl. a linked/unlinked ABHA); a change re-sends the patient master (once per distinct value)
create or replace function public.patient_identity_hash(p patients)
returns text language sql immutable as $$
  select md5(concat_ws('|', p.full_name, p.date_of_birth, p.gender, p.phone, p.email, p.address, coalesce(p.abha_number, '-')));
$$;

-- ---------------------------------------------------------------- event triggers
create or replace function public.integration_appointment_events()
returns trigger language plpgsql security definer set search_path = public as $$
declare pt patients;
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status in ('pending_payment', 'cancelled')) and new.rescheduled_from_id is null then
    select * into pt from patients where id = new.patient_id;
    perform public.enqueue_integration('his', 'patient_upsert', pt.id, 'his:patient:' || pt.id || ':' || public.patient_identity_hash(pt));
    perform public.enqueue_integration('leadsquared', 'lead_event', new.id, 'lsq:booked:' || new.id, new.booked_by_user_id, 'booked');
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'completed' then
      perform public.enqueue_integration('leadsquared', 'lead_event', new.id, 'lsq:completed:' || new.id, new.booked_by_user_id, 'completed');
    elsif new.status = 'cancelled' and old.status = 'confirmed' then
      perform public.enqueue_integration('leadsquared', 'lead_event', new.id, 'lsq:cancelled:' || new.id, new.booked_by_user_id, 'cancelled');
    end if;
  end if;
  return null;
end $$;
create trigger appointments_integrations after insert or update on appointments for each row execute function public.integration_appointment_events();

create or replace function public.integration_patient_events()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.is_primary then
      perform public.enqueue_integration('leadsquared', 'lead_event', new.id, 'lsq:signed_up:' || new.id, new.owner_user_id, 'signed_up');
    end if;
  elsif public.patient_identity_hash(new) <> public.patient_identity_hash(old)
        and exists (select 1 from appointments a where a.patient_id = new.id and a.status in ('confirmed', 'in_progress', 'completed', 'no_show')) then
    perform public.enqueue_integration('his', 'patient_upsert', new.id, 'his:patient:' || new.id || ':' || public.patient_identity_hash(new));
  end if;
  return null;
end $$;
create trigger patients_integrations after insert or update on patients for each row execute function public.integration_patient_events();

create or replace function public.integration_rx_events()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'final' and old.status = 'draft' then
    perform public.enqueue_integration('his', 'consultation_summary', new.id, 'his:summary:' || new.id);
    perform public.enqueue_integration('his', 'prescription', new.id, 'his:rx:' || new.id);
  end if;
  return null;
end $$;
create trigger prescriptions_integrations after update on prescriptions for each row execute function public.integration_rx_events();

create or replace function public.integration_money_events()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  if tg_table_name = 'payments' then
    if new.status = 'captured' and old.status is distinct from 'captured' then
      perform public.enqueue_integration('his', 'billing_payment', new.id, 'his:pay:' || new.id);
      select booked_by_user_id into owner from appointments where id = new.appointment_id;
      perform public.enqueue_integration('leadsquared', 'lead_event', new.id, 'lsq:paid:' || new.id, owner, 'paid');
    end if;
  elsif new.status = 'processed' and old.status is distinct from 'processed' then
    perform public.enqueue_integration('his', 'billing_refund', new.id, 'his:refund:' || new.id);
  end if;
  return null;
end $$;
create trigger payments_integrations after update on payments for each row execute function public.integration_money_events();
create trigger refunds_integrations after update on refunds for each row execute function public.integration_money_events();

-- ---------------------------------------------------------------- dispatcher (service role)
/** Lease due events (5 minutes) – the dispatcher builds each payload with integration_payload(). */
create or replace function public.claim_integration_events(p_limit int default 50)
returns setof integration_events language sql security definer set search_path = public as $$
  update integration_events e set status = 'sending', attempts = e.attempts + 1, next_attempt_at = now() + interval '5 minutes'
   where e.id in (select id from integration_events where (status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and next_attempt_at <= now())
                   order by next_attempt_at limit least(greatest(p_limit, 1), 200) for update skip locked)
  returning e.*;
$$;

/**
 * The minimum each system needs, built at send time. Returns {skip: reason} when the event must not be sent
 * (consent withdrawn, integration switched off) and {wait: reason} when it depends on another event (MRN).
 */
create or replace function public.integration_payload(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e integration_events; pt patients; a appointments; rx prescriptions; pay payments; rf refunds; c consultations; pr profiles;
  mrn text; doc doctors; h hospitals;
begin
  select * into e from integration_events where id = p_id;
  if e.id is null then return jsonb_build_object('skip', 'not_found'); end if;
  if not public.integration_on(e.system) then return jsonb_build_object('skip', 'integration_off'); end if;

  if e.kind = 'lead_event' then
    if not public.marketing_opted_in(e.user_id) then return jsonb_build_object('skip', 'no_consent'); end if;
    select * into pr from profiles where id = e.user_id;
    select x.* into h from hospitals x join appointments y on y.hospital_id = x.id
     where y.id = coalesce((select appointment_id from payments where id = e.entity_id), e.entity_id);
    return jsonb_build_object('event', e.event, 'occurred_at', e.created_at, 'idempotency_key', e.idempotency_key,
      'lead', jsonb_build_object('name', pr.full_name, 'mobile', pr.phone, 'city', h.city, 'source', 'Sunrise Care Connect'));
  end if;

  if e.kind = 'patient_upsert' then
    select * into pt from patients where id = e.entity_id;
    return jsonb_build_object('patient_ref', pt.id, 'mrn', pt.his_mrn, 'name', pt.full_name, 'date_of_birth', pt.date_of_birth, 'gender', pt.gender,
      'mobile', coalesce(nullif(pt.phone, ''), (select phone from profiles where id = pt.owner_user_id)), 'email', pt.email, 'address', pt.address,
      'abha_number', pt.abha_number, 'idempotency_key', e.idempotency_key);
  end if;

  if e.kind in ('consultation_summary', 'prescription') then
    select * into rx from prescriptions where id = e.entity_id;
    select * into a from appointments where id = rx.appointment_id;
  elsif e.kind = 'billing_payment' then
    select * into pay from payments where id = e.entity_id;
    select * into a from appointments where id = pay.appointment_id;
  elsif e.kind = 'billing_refund' then
    select * into rf from refunds where id = e.entity_id;
    select * into pay from payments where id = rf.payment_id;
    select * into a from appointments where id = rf.appointment_id;
  end if;
  select his_mrn into mrn from patients where id = a.patient_id;
  if mrn is null then
    -- the patient master has to land first (the dispatcher calls ensure_patient_upsert)
    return jsonb_build_object('wait', 'waiting_for_mrn', 'patient_id', a.patient_id);
  end if;
  select * into doc from doctors where id = a.doctor_id;
  select * into h from hospitals where id = a.hospital_id;

  if e.kind = 'consultation_summary' then
    select * into c from consultations where appointment_id = a.id;
    return jsonb_build_object('mrn', mrn, 'encounter_ref', a.ref_code, 'hospital_code', h.his_code, 'doctor_code', doc.his_doctor_code,
      'start_at', a.start_at, 'mode', a.mode, 'consult_type', a.consult_type, 'version', rx.version,
      'chief_complaint', c.chief_complaint, 'history', c.history, 'examination', c.examination, 'diagnoses', coalesce(rx.diagnoses, c.diagnoses),
      'advice', rx.advice, 'investigations', rx.investigations, 'follow_up_date', rx.follow_up_date, 'idempotency_key', e.idempotency_key);
  elsif e.kind = 'prescription' then
    return jsonb_build_object('mrn', mrn, 'encounter_ref', a.ref_code, 'hospital_code', h.his_code, 'doctor_code', doc.his_doctor_code,
      'rx_no', rx.rx_no, 'version', rx.version, 'replaces_rx_no', (select rx_no from prescriptions where id = rx.parent_prescription_id),
      'verification_code', rx.verification_code, 'signed_at', rx.finalized_at, 'pdf_path', rx.pdf_path,
      'items', coalesce((select jsonb_agg(jsonb_build_object('drug_code', i.drug_id, 'name', i.drug_name, 'strength', i.strength, 'form', i.form, 'dose', i.dose,
                 'frequency', i.frequency, 'duration', i.duration, 'route', i.route, 'instructions', i.instructions) order by i.position)
                 from prescription_items i where i.prescription_id = rx.id), '[]'),
      'idempotency_key', e.idempotency_key);
  elsif e.kind = 'billing_payment' then
    return jsonb_build_object('mrn', mrn, 'encounter_ref', a.ref_code, 'hospital_code', h.his_code, 'doctor_code', doc.his_doctor_code,
      'service_code', 'TELE-' || upper(a.mode::text) || '-' || upper(a.consult_type::text), 'receipt_no', pay.receipt_no, 'amount', pay.amount,
      'currency', 'INR', 'method', pay.method, 'gateway_payment_id', pay.provider_payment_id, 'paid_at', pay.captured_at, 'idempotency_key', e.idempotency_key);
  elsif e.kind = 'billing_refund' then
    return jsonb_build_object('mrn', mrn, 'encounter_ref', a.ref_code, 'hospital_code', h.his_code, 'receipt_no', pay.receipt_no,
      'refund_ref', rf.id, 'amount', rf.amount, 'currency', 'INR', 'gateway_refund_id', rf.provider_refund_id, 'refunded_at', rf.processed_at,
      'idempotency_key', e.idempotency_key);
  end if;
  return jsonb_build_object('skip', 'unknown_kind');
end $$;

create or replace function public.complete_integration_event(p_id uuid, p_external_ref text, p_result jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare e integration_events;
begin
  update integration_events set status = 'sent', sent_at = now(), external_ref = left(p_external_ref, 200), last_error = null
   where id = p_id returning * into e;
  if e.kind = 'patient_upsert' and nullif(p_result ->> 'mrn', '') is not null then
    perform set_config('app.audit_reason', 'HIS patient master synced', true);
    update patients set his_mrn = coalesce(his_mrn, left(p_result ->> 'mrn', 40)), his_synced_at = now() where id = e.entity_id;
  end if;
end $$;

/** Service: make sure the patient master is (re)queued when a clinical / billing event is waiting for the MRN. */
create or replace function public.ensure_patient_upsert(p_patient uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare pt patients;
begin
  select * into pt from patients where id = p_patient;
  if pt.id is null or pt.his_mrn is not null then return false; end if;
  if exists (select 1 from integration_events where kind = 'patient_upsert' and entity_id = pt.id and status in ('queued', 'sending')) then return false; end if;
  return public.enqueue_integration('his', 'patient_upsert', pt.id, 'his:patient:' || pt.id || ':' || public.patient_identity_hash(pt) || ':' || extract(epoch from now())::bigint);
end $$;

/** Temporary failures back off (1, 5, 15, 60, 180 min) up to 6 attempts; permanent ones fail at once; skip = never send. */
create or replace function public.fail_integration_event(p_id uuid, p_error text, p_mode text)
returns text language plpgsql security definer set search_path = public as $$
declare e integration_events; backoff int[] := array[1, 5, 15, 60, 180]; st text;
begin
  select * into e from integration_events where id = p_id for update;
  st := case when p_mode = 'skip' then 'skipped' when p_mode = 'permanent' or e.attempts >= 6 then 'failed' else 'queued' end;
  update integration_events set status = st, last_error = left(p_error, 200),
         attempts = case when p_mode = 'wait' then greatest(attempts - 1, 0) else attempts end,
         next_attempt_at = now() + make_interval(mins => case when p_mode = 'wait' then 2 else backoff[greatest(least(e.attempts, 5), 1)] end)
   where id = p_id;
  return st;
end $$;

/** Nightly HIS doctor master: fill / confirm HIS doctor codes. Never creates doctors or touches verification. */
create or replace function public.his_apply_doctor_master(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; d doctors; matched int := 0; linked int := 0; unmatched jsonb := '[]'; conflicts jsonb := '[]'; res jsonb;
begin
  perform set_config('app.audit_reason', 'HIS doctor master sync', true);
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    select * into d from doctors where his_doctor_code = r ->> 'his_doctor_code';
    if d.id is not null then
      matched := matched + 1;
      if upper(coalesce(r ->> 'registration_no', d.registration_no)) <> d.registration_no then
        conflicts := conflicts || jsonb_build_object('his_doctor_code', r ->> 'his_doctor_code', 'issue', 'registration_differs');
      end if;
      continue;
    end if;
    select * into d from doctors where registration_no = upper(r ->> 'registration_no') and his_doctor_code is null;
    if d.id is not null then
      update doctors set his_doctor_code = r ->> 'his_doctor_code' where id = d.id;
      linked := linked + 1;
    else
      unmatched := unmatched || to_jsonb(r ->> 'his_doctor_code');
    end if;
  end loop;
  res := jsonb_build_object('at', now(), 'rows', jsonb_array_length(coalesce(p_rows, '[]')), 'matched', matched, 'linked', linked,
                            'unmatched', unmatched, 'conflicts', conflicts);
  insert into app_settings (key, value) values ('his_doctor_sync', res) on conflict (key) do update set value = excluded.value;
  return res;
end $$;

-- ---------------------------------------------------------------- ABDM (ABHA) – behind abdm_enabled
/** Service (abha function, after the OTP verified with ABDM): link the ABHA to one of the caller's patients. */
create or replace function public.link_abha(p_patient uuid, p_number text, p_address text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.integration_on('abdm') then raise exception 'abdm_disabled'; end if;
  if not exists (select 1 from patients where id = p_patient and owner_user_id = p_actor and archived_at is null) then raise exception 'not_found'; end if;
  if exists (select 1 from patients where abha_number = p_number and id <> p_patient and archived_at is null) then raise exception 'abha_in_use'; end if;
  perform set_config('app.audit_reason', 'ABHA verified and linked', true);
  update patients set abha_number = p_number, abha_address = p_address, abha_verified_at = now(), abha_linked_by = p_actor where id = p_patient;
end $$;

create or replace function public.unlink_abha(p_patient uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from patients where id = p_patient and id in (select public.my_patient_ids())) then raise exception 'not_found'; end if;
  perform set_config('app.audit_reason', 'ABHA unlinked by the patient', true);
  update patients set abha_number = null, abha_address = null, abha_verified_at = null, abha_linked_by = null where id = p_patient;
end $$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_integration_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'flags', jsonb_build_object('his', public.integration_on('his'), 'leadsquared', public.integration_on('leadsquared'), 'abdm', public.integration_on('abdm')),
    'by_system', coalesce((select jsonb_object_agg(system, x) from (
        select system, jsonb_build_object('queued', count(*) filter (where status in ('queued', 'sending')), 'sent', count(*) filter (where status = 'sent'),
               'failed', count(*) filter (where status = 'failed'), 'skipped', count(*) filter (where status = 'skipped'),
               'last_sent_at', max(sent_at)) x
          from integration_events where created_at > now() - interval '30 days' group by system) s), '{}'),
    'doctor_sync', setting('his_doctor_sync'));
end $$;

create or replace function public.admin_integration_events(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    with f as (select * from integration_events
                where (p ->> 'system' is null or system = p ->> 'system') and (p ->> 'status' is null or status = p ->> 'status')
                  and (p ->> 'kind' is null or kind = p ->> 'kind'))
    select jsonb_build_object('total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at desc) from
              (select * from f order by created_at desc limit least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 200)
                offset greatest(coalesce((p ->> 'offset')::int, 0), 0)) x), '[]')));
end $$;

create or replace function public.admin_retry_integration(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform set_config('app.audit_reason', 'Integration event retried', true);
  update integration_events set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null where id = p_id and status = 'failed';
  if not found then raise exception 'not_retryable'; end if;
end $$;

create or replace function public.admin_set_integrations(p_his boolean, p_leadsquared boolean, p_abdm boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason);
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform set_config('app.audit_reason', why, true);
  insert into app_settings (key, value) values ('integrations', jsonb_build_object('his', p_his, 'leadsquared', p_leadsquared))
  on conflict (key) do update set value = excluded.value;
  insert into app_settings (key, value) values ('abdm_enabled', to_jsonb(p_abdm)) on conflict (key) do update set value = excluded.value;
end $$;

-- audit the new tables
do $$
declare r record;
begin
  for r in select * from (values ('device_tokens', '{token}'::text[]), ('integration_events', '{}'::text[])) t(tbl, redact) loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', r.tbl);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row_change(%2$s)',
                   r.tbl, (select coalesce(string_agg(quote_literal(c), ','), '') from unnest(r.redact) c));
  end loop;
end $$;
-- the outbox churns (attempts, leases): audit only manual retries, which set a reason
drop trigger if exists audit_integration_events on integration_events;

-- ---------------------------------------------------------------- grants
revoke execute on function public.integration_on, public.marketing_opted_in, public.enqueue_integration, public.patient_identity_hash,
  public.claim_integration_events, public.integration_payload, public.complete_integration_event, public.fail_integration_event,
  public.his_apply_doctor_master, public.link_abha, public.device_token_result, public.ensure_patient_upsert from public, anon, authenticated;
grant execute on function public.claim_integration_events, public.integration_payload, public.complete_integration_event, public.fail_integration_event,
  public.his_apply_doctor_master, public.link_abha, public.device_token_result, public.ensure_patient_upsert to service_role;
revoke execute on function public.register_device_token, public.remove_device_token, public.unlink_abha, public.admin_integration_stats,
  public.admin_integration_events, public.admin_retry_integration, public.admin_set_integrations from public, anon;
grant execute on function public.register_device_token, public.remove_device_token, public.unlink_abha, public.admin_integration_stats,
  public.admin_integration_events, public.admin_retry_integration, public.admin_set_integrations to authenticated;
