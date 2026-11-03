-- =============================================================================
-- Phase 8: NotificationService – outbox, routing with opt-in checks, events, scheduled reminders.
--
--  * One outbox (`notifications`): one row per user × channel × event. The dispatcher edge function
--    (notifications-dispatch, every minute) sends queued rows through the WhatsApp / SMS / push adapters
--    and records provider ids, delivery receipts, retries and cost. In-app rows are the bell feed.
--  * Routing (confirmed by Sunrise 2026-10-26): every message goes on WhatsApp (only with the patient's
--    WhatsApp opt-in consent) AND SMS (unless the user switched SMS off), plus push on subscribed devices
--    and the in-app bell. A channel that can't be used is recorded as `skipped` with the reason.
--  * No clinical details: template variables are limited to a whitelist (name, doctor, date, time, ref,
--    link, amount, response, otp, minutes) and every link is a random, single-account token
--    (/l/<token>) that needs sign-in – never an id, never a diagnosis or medicine.
--  * Events: triggers on appointments, payments and refunds (confirmation, doctor's new booking, join
--    link when the doctor is in the room, cancellations, payment receipt, refunds); existing notify_user
--    calls (reschedule, doctor unavailable, prescription ready, …) route through the outbox too.
--  * Scheduled (run_scheduled_jobs, every minute): reminders 24 h / 1 h / 10 min (with join link),
--    feedback request 2 h after completion, follow-up reminders (2 days before the free window closes;
--    the day before the doctor's follow-up date). Every event has a de-duplication key.
--  * Quiet hours 21:00–08:00 IST for non-urgent templates (24 h reminder, follow-ups, feedback).
-- =============================================================================

-- ---------------------------------------------------------------- templates
alter table notification_templates
  add column category text not null default 'transactional' check (category in ('transactional', 'reminder', 'service', 'auth')),
  add column audience text not null default 'patient' check (audience in ('patient', 'doctor', 'staff')),
  add column channels notification_channel[] not null default '{whatsapp,sms,push,in_app}',
  add column sms_dlt_template_id text,
  add column sms_body_en text,
  add column sms_body_ml text,
  add column push_title_en text not null default 'Sunrise Care',
  add column push_title_ml text not null default 'സൺറൈസ് കെയർ',
  add column quiet_hours boolean not null default false,
  add column description text not null default '',
  add column updated_at timestamptz not null default now();
-- whitelist, not just a blacklist: nothing outside these names can ever be substituted into a message
alter table notification_templates add constraint templates_vars_whitelist
  check (variables <@ array['name', 'doctor', 'date', 'time', 'ref', 'link', 'amount', 'response', 'otp', 'minutes']::text[]);

-- ---------------------------------------------------------------- outbox
alter table notifications
  add column event_key text,
  add column appointment_id uuid references appointments (id) on delete set null,
  add column language text not null default 'en',
  add column send_after timestamptz not null default now(),
  add column provider text,
  add column sent_at timestamptz,
  add column delivered_at timestamptz,
  add column seen_at timestamptz,          -- WhatsApp "read" receipt (read_at stays the in-app read flag)
  add column failed_at timestamptz,
  add column cost_paise int not null default 0 check (cost_paise >= 0),
  add column clicked_at timestamptz;
create unique index notifications_event_uq on notifications (user_id, channel, event_key) where event_key is not null;
create index notifications_due_idx on notifications (send_after) where status = 'queued';
create index notifications_provider_msg_idx on notifications (provider, provider_message_id) where provider_message_id is not null;
create index notifications_outbox_idx on notifications (created_at desc, channel, status);

-- Links in messages: random token → path, valid for one account only.
create table notification_links (
  token text primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  path text not null check (path ~ '^/[a-z](/|$)'),
  created_at timestamptz not null default now(),
  clicked_at timestamptz
);
alter table notification_links enable row level security;
alter table notification_links force row level security;   -- no policies: RPC only

create table notification_prefs (
  user_id uuid primary key references profiles (id) on delete cascade,
  sms boolean not null default true,
  push boolean not null default true,
  reminders boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table notification_prefs enable row level security;
alter table notification_prefs force row level security;
create policy notification_prefs_own on notification_prefs for select using (user_id = auth.uid());

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures int not null default 0
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
create policy push_subscriptions_own on push_subscriptions for select using (user_id = auth.uid());

grant select on notification_prefs, push_subscriptions to authenticated;

-- the bell may only flip read_at (through mark_notifications_read), never status or text
drop policy if exists notifications_mark_read on notifications;

-- ---------------------------------------------------------------- helpers
create or replace function public.mask_phone(p text)
returns text language sql immutable as $$
  select case when p is null then null else '+91 ' || substr(right(regexp_replace(p, '\D', '', 'g'), 10), 1, 2) || '•••••' || right(p, 3) end;
$$;

create or replace function public.render_text(p_body text, p_vars jsonb)
returns text language plpgsql immutable as $$
declare k text; v text; out text := p_body;
begin
  for k, v in select * from jsonb_each_text(coalesce(p_vars, '{}')) loop
    out := replace(out, '{{' || k || '}}', coalesce(v, ''));
  end loop;
  return regexp_replace(out, '\{\{\w+\}\}', '', 'g');   -- never send an unfilled placeholder
end $$;

create or replace function public.whatsapp_opted_in(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select granted and withdrawn_at is null from consents
                    where user_id = p_user and consent_type = 'whatsapp_opt_in' order by granted_at desc limit 1), false);
$$;

/** Non-urgent messages that fall in quiet hours (default 21:00–08:00 IST) wait until the end of them. */
create or replace function public.quiet_hours_shift(p_at timestamptz, p_apply boolean)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare q jsonb := coalesce(setting('notification_quiet_hours'), '{"start":"21:00","end":"08:00"}'); s time := (q ->> 'start')::time; e time := (q ->> 'end')::time;
  local timestamp := p_at at time zone 'Asia/Kolkata';
begin
  if not p_apply then return p_at; end if;
  if local::time >= s then return ((local::date + 1) + e) at time zone 'Asia/Kolkata'; end if;
  if local::time < e then return (local::date + e) at time zone 'Asia/Kolkata'; end if;
  return p_at;
end $$;

/**
 * Queue one event for one user on every channel the template uses: WhatsApp (opt-in), SMS (unless
 * switched off), push (subscribed devices), in-app. `p_event_key` makes the event idempotent.
 */
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
      continue when pref.push is false or why is not null or not exists (select 1 from push_subscriptions where user_id = p_user);
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

-- The earlier phases' direct calls now go through the outbox (template text, link token, routing).
create or replace function public.notify_user(p_user uuid, p_template text, p_vars jsonb, p_text text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_notification(p_user, p_template, p_vars, p_link, null, null, now());
end $$;

-- ---------------------------------------------------------------- event triggers
create or replace function public.appt_vars(a appointments)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ref', a.ref_code, 'doctor', d.full_name, 'name', split_part(coalesce(nullif(pr.full_name, ''), 'there'), ' ', 1),
                            'date', to_char(a.start_at at time zone 'Asia/Kolkata', 'DD Mon YYYY'),
                            'time', to_char(a.start_at at time zone 'Asia/Kolkata', 'HH12:MI AM'))
    from doctors d, profiles pr where d.id = a.doctor_id and pr.id = a.booked_by_user_id;
$$;

create or replace function public.notify_appointment_events()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare v jsonb := public.appt_vars(new); doc uuid := (select profile_id from doctors where id = new.doctor_id);
begin
  -- confirmed (paid, free, or a late payment); a moved booking announces itself as "rescheduled"
  if new.status = 'confirmed' and new.rescheduled_from_id is null and (tg_op = 'INSERT' or old.status in ('pending_payment', 'cancelled')) then
    perform public.enqueue_notification(new.booked_by_user_id, 'booking_confirmed', v, '/p/appointments', 'booking_confirmed:' || new.id, new.id);
    perform public.enqueue_notification(doc, 'doctor_new_booking', v, '/d/appointments/' || new.id, 'doctor_new_booking:' || new.id, new.id);
  end if;
  if tg_op = 'UPDATE' then
    -- cancelled by the patient or by Sunrise (doctor-side cancellations notify through cancel_for_doctor_reason)
    if new.status = 'cancelled' and old.status = 'confirmed' and new.outcome in ('cancelled_by_patient', 'cancelled_by_admin') then
      perform public.enqueue_notification(new.booked_by_user_id, 'cancelled', v, '/p/appointments', 'cancelled:' || new.id, new.id);
      perform public.enqueue_notification(doc, 'doctor_booking_cancelled', v, '/d/appointments/' || new.id, 'doctor_booking_cancelled:' || new.id, new.id);
    end if;
    -- join link: the doctor is in the room and the patient isn't yet
    if old.doctor_joined_at is null and new.doctor_joined_at is not null and new.patient_joined_at is null and new.status = 'confirmed' then
      perform public.enqueue_notification(new.booked_by_user_id, 'doctor_joined', v, '/p/consult/' || new.id, 'doctor_joined:' || new.id, new.id);
    end if;
  end if;
  return null;
end $$;
create trigger appointments_notify after insert or update on appointments for each row execute function public.notify_appointment_events();

create or replace function public.notify_payment_events()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare a appointments;
begin
  if new.status = 'captured' and old.status is distinct from 'captured' then
    select * into a from appointments where id = new.appointment_id;
    perform public.enqueue_notification(a.booked_by_user_id, 'payment_received', jsonb_build_object('ref', a.ref_code, 'amount', new.amount),
                                        '/p/appointments', 'payment_received:' || new.id, a.id);
  end if;
  return null;
end $$;
create trigger payments_notify after update on payments for each row execute function public.notify_payment_events();

create or replace function public.notify_refund_events()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare a appointments;
begin
  select * into a from appointments where id = new.appointment_id;
  if tg_op = 'INSERT' then
    perform public.enqueue_notification(a.booked_by_user_id, 'refund_initiated', jsonb_build_object('ref', a.ref_code, 'amount', new.amount),
                                        '/p/appointments', 'refund_initiated:' || new.id, a.id);
  elsif new.status = 'processed' and old.status is distinct from 'processed' then
    perform public.enqueue_notification(a.booked_by_user_id, 'refund_processed', jsonb_build_object('ref', a.ref_code, 'amount', new.amount),
                                        '/p/appointments', 'refund_processed:' || new.id, a.id);
  end if;
  return null;
end $$;
create trigger refunds_notify after insert or update on refunds for each row execute function public.notify_refund_events();

-- ---------------------------------------------------------------- scheduled: reminders, feedback, follow-ups
create or replace function public.queue_scheduled_notifications()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r record; nr int := 0; nf int := 0; nu int := 0; win int := (select free_window_days from follow_up_policy where id = 1);
  fb int := coalesce((setting('feedback_delay_minutes'))::int, 120);
begin
  -- reminders: due now (30-minute catch-up), only for bookings that existed before the reminder time
  for r in select a as appt, x.kind from appointments a
             cross join (values ('reminder_24h', interval '24 hours'), ('reminder_1h', interval '1 hour'), ('reminder_10m', interval '10 minutes')) x(kind, off)
            where a.status = 'confirmed' and a.start_at > now() and a.start_at < now() + interval '25 hours'
              and a.start_at - x.off <= now() and a.start_at - x.off > now() - interval '30 minutes' and a.created_at <= a.start_at - x.off loop
    nr := nr + public.enqueue_notification((r.appt).booked_by_user_id, r.kind, public.appt_vars(r.appt) || jsonb_build_object('minutes', 10),
      case when r.kind = 'reminder_10m' then '/p/consult/' || (r.appt).id else '/p/appointments' end, r.kind || ':' || (r.appt).id, (r.appt).id);
  end loop;

  -- feedback: 2 h after completion, not yet rated (quiet hours move night-time ones to the morning)
  for r in select a as appt from appointments a
            where a.status = 'completed' and a.completed_at <= now() - make_interval(mins => fb) and a.completed_at > now() - interval '2 days'
              and not exists (select 1 from ratings x where x.appointment_id = a.id) loop
    nf := nf + public.enqueue_notification((r.appt).booked_by_user_id, 'feedback_request', public.appt_vars(r.appt), '/p/feedback/' || (r.appt).id, 'feedback_request:' || (r.appt).id, (r.appt).id);
  end loop;

  -- follow-up 1: two days before the free follow-up window closes, nothing booked with the doctor since
  for r in select a as appt, (a.completed_at + make_interval(days => win)) win_end from appointments a
            where a.status = 'completed' and not a.is_free and a.fee_amount > 0 and a.completed_at is not null
              and now() >= a.completed_at + make_interval(days => win) - interval '2 days' and now() < a.completed_at + make_interval(days => win)
              and not exists (select 1 from appointments x where x.id <> a.id and x.patient_id = a.patient_id and x.doctor_id = a.doctor_id and x.created_at > a.completed_at
                                and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed')) loop
    nu := nu + public.enqueue_notification((r.appt).booked_by_user_id, 'follow_up_due',
      public.appt_vars(r.appt) || jsonb_build_object('date', to_char(r.win_end at time zone 'Asia/Kolkata', 'DD Mon YYYY')),
      '/p/doctors/' || (r.appt).doctor_id, 'follow_up_due:' || (r.appt).id, (r.appt).id);
  end loop;

  -- follow-up 2: from 10:00 IST the day before the follow-up date in the signed notes, nothing booked since
  for r in select a as appt, c.follow_up_date fud from appointments a join consultations c on c.appointment_id = a.id
            where c.status = 'final' and c.follow_up_date is not null
              and now() >= ((c.follow_up_date - 1) + time '10:00') at time zone 'Asia/Kolkata' and now() < (c.follow_up_date + 1)::timestamp at time zone 'Asia/Kolkata'
              and not exists (select 1 from appointments x where x.id <> a.id and x.patient_id = a.patient_id and x.doctor_id = a.doctor_id and x.created_at > a.start_at
                                and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed')) loop
    nu := nu + public.enqueue_notification((r.appt).booked_by_user_id, 'follow_up_advised',
      public.appt_vars(r.appt) || jsonb_build_object('date', to_char(r.fud, 'DD Mon YYYY')),
      '/p/doctors/' || (r.appt).doctor_id, 'follow_up_advised:' || (r.appt).id, (r.appt).id);
  end loop;
  return jsonb_build_object('reminders', nr, 'feedback', nf, 'follow_ups', nu);
end $$;

create or replace function public.run_scheduled_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('holds', public.expire_holds(), 'reschedules', public.expire_reschedule_requests(),
                            'no_shows', public.sweep_no_shows(), 'auto_refunds', public.sweep_doctor_side_failures(),
                            'notifications', public.queue_scheduled_notifications());
end $$;

-- ---------------------------------------------------------------- dispatcher (service role)
/** Leases due rows (attempts + 1, 5-minute lease so a crashed dispatcher retries) with what sending needs. */
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
                                                           from push_subscriptions s where s.user_id = u.user_id) end)), '[]')
    into out
    from u join profiles pr on pr.id = u.user_id join notification_templates t on t.key = u.template_key;
  return out;
end $$;

create or replace function public.mark_notification_sent(p_id uuid, p_provider text, p_message_id text, p_cost_paise int, p_delivered boolean default false)
returns void language sql security definer set search_path = public as $$
  update notifications set status = (case when p_delivered then 'delivered' else 'sent' end)::notification_status, provider = p_provider,
         provider_message_id = left(p_message_id, 200), cost_paise = greatest(coalesce(p_cost_paise, 0), 0), sent_at = now(),
         delivered_at = case when p_delivered then now() end, error = null
   where id = p_id;
$$;

/** Temporary errors retry with backoff (2, 4 min) up to 3 attempts; permanent ones fail at once. */
create or replace function public.mark_notification_failed(p_id uuid, p_provider text, p_error text, p_permanent boolean)
returns text language plpgsql security definer set search_path = public as $$
declare n notifications;
begin
  select * into n from notifications where id = p_id for update;
  if n.id is null then return 'not_found'; end if;
  if not p_permanent and n.attempts < 3 then
    update notifications set status = 'queued', provider = p_provider, error = left(p_error, 200), send_after = now() + make_interval(mins => (2 ^ n.attempts)::int) where id = p_id;
    return 'retry';
  end if;
  update notifications set status = 'failed', provider = p_provider, error = left(p_error, 200), failed_at = now() where id = p_id;
  return 'failed';
end $$;

/** Delivery receipts (provider webhooks): only ever move forward (sent → delivered → read). */
create or replace function public.record_delivery_status(p_provider text, p_message_id text, p_status text, p_error text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_status = 'failed' then
    update notifications set status = 'failed', failed_at = now(), error = left(coalesce(p_error, 'provider_failed'), 200)
     where provider = p_provider and provider_message_id = p_message_id and status in ('sent', 'queued');
  elsif p_status = 'delivered' then
    update notifications set status = 'delivered', delivered_at = coalesce(delivered_at, now())
     where provider = p_provider and provider_message_id = p_message_id and status = 'sent';
  elsif p_status = 'read' then
    update notifications set status = 'read', seen_at = now(), delivered_at = coalesce(delivered_at, now())
     where provider = p_provider and provider_message_id = p_message_id and status in ('sent', 'delivered');
  else
    return 0;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.push_subscription_result(p_endpoint text, p_ok boolean, p_gone boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_gone then delete from push_subscriptions where endpoint = p_endpoint;
  elsif p_ok then update push_subscriptions set last_success_at = now(), failures = 0 where endpoint = p_endpoint;
  else update push_subscriptions set failures = failures + 1 where endpoint = p_endpoint;
  end if;
end $$;

-- ---------------------------------------------------------------- users: preferences, push, links, bell
create or replace function public.set_notification_prefs(p_sms boolean, p_push boolean, p_reminders boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  perform set_config('app.audit_reason', 'Notification preferences changed', true);
  insert into notification_prefs (user_id, sms, push, reminders) values (auth.uid(), p_sms, p_push, p_reminders)
  on conflict (user_id) do update set sms = excluded.sms, push = excluded.push, reminders = excluded.reminders, updated_at = now();
end $$;

create or replace function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000 or length(coalesce(p_p256dh, '')) not between 80 and 100
     or length(coalesce(p_auth, '')) not between 16 and 30 then raise exception 'invalid_input'; end if;
  if (select count(*) from push_subscriptions where user_id = auth.uid()) >= 10 then
    delete from push_subscriptions where id = (select id from push_subscriptions where user_id = auth.uid() order by created_at limit 1);
  end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_user_agent, ''), 200))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

/** /l/<token>: only for the account the message was sent to. Marks the message as clicked. */
create or replace function public.resolve_notification_link(p_token text)
returns text language plpgsql security definer set search_path = public as $$
declare l notification_links;
begin
  select * into l from notification_links where token = p_token;
  if l.token is null or l.user_id is distinct from auth.uid() then raise exception 'not_found'; end if;
  update notification_links set clicked_at = coalesce(clicked_at, now()) where token = l.token;
  update notifications set clicked_at = coalesce(clicked_at, now()) where link = '/l/' || l.token;
  return l.path;
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update notifications set read_at = now()
   where user_id = auth.uid() and channel = 'in_app' and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

/** Feedback after a completed consultation (the feedback-request link opens this). */
create or replace function public.submit_rating(p_appt uuid, p_stars int, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
declare a appointments;
begin
  select * into a from appointments where id = p_appt;
  if a.id is null or a.patient_id not in (select public.my_patient_ids()) then raise exception 'not_found'; end if;
  if a.status <> 'completed' then raise exception 'not_completed'; end if;
  if p_stars not between 1 and 5 then raise exception 'invalid_input'; end if;
  if exists (select 1 from ratings where appointment_id = a.id) then raise exception 'already_rated'; end if;
  insert into ratings (appointment_id, doctor_id, patient_id, stars, comment) values (a.id, a.doctor_id, a.patient_id, p_stars, left(trim(coalesce(p_comment, '')), 500));
end $$;

-- the doctor's average follows every rating, however it was written
create or replace function public.ratings_aggregate()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update doctors d set rating_count = x.n, rating_avg = coalesce(round(x.a, 1), 0)
    from (select count(*) n, avg(stars)::numeric a from ratings where doctor_id = new.doctor_id) x where d.id = new.doctor_id;
  return null;
end $$;
create trigger ratings_aggregate after insert on ratings for each row execute function public.ratings_aggregate();

-- ---------------------------------------------------------------- admin
create or replace function public.outbox_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_ok('admin', 'coordinator', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'by_channel', coalesce((select jsonb_agg(x order by x ->> 'channel') from (
        select jsonb_build_object('channel', channel, 'total', count(*),
          'queued', count(*) filter (where status = 'queued'), 'sent', count(*) filter (where status = 'sent'),
          'delivered', count(*) filter (where status = 'delivered'), 'read', count(*) filter (where status = 'read'),
          'failed', count(*) filter (where status = 'failed'), 'skipped', count(*) filter (where status = 'skipped'),
          'clicked', count(*) filter (where clicked_at is not null), 'cost_paise', coalesce(sum(cost_paise), 0)) x
          from notifications where created_at >= p_from and created_at < p_to group by channel) s), '[]'),
    'by_template', coalesce((select jsonb_agg(x order by (x ->> 'cost_paise')::int desc) from (
        select jsonb_build_object('template_key', template_key, 'total', count(*) filter (where status <> 'skipped'),
          'failed', count(*) filter (where status = 'failed'), 'cost_paise', coalesce(sum(cost_paise), 0)) x
          from notifications where created_at >= p_from and created_at < p_to group by template_key) s), '[]'),
    'cost_paise', (select coalesce(sum(cost_paise), 0) from notifications where created_at >= p_from and created_at < p_to),
    'month_cost_paise', (select coalesce(sum(cost_paise), 0) from notifications where created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'));
end $$;

create or replace function public.retry_notification(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform set_config('app.audit_reason', 'Outbox: retry', true);
  update notifications set status = 'queued', attempts = 0, send_after = now(), error = null, failed_at = null where id = p_id and status = 'failed';
  if not found then raise exception 'not_retryable'; end if;
end $$;

/** Template edits: every {{placeholder}} must be one of the template's (whitelisted) variables. */
create or replace function public.save_notification_template(p_key text, p_patch jsonb, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare t notification_templates; f text; ph text; ch text;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  select * into t from notification_templates where key = p_key for update;
  if t.key is null then raise exception 'not_found'; end if;
  foreach f in array array['body_en', 'body_ml', 'sms_body_en', 'sms_body_ml'] loop
    continue when not (p_patch ? f) or p_patch ->> f is null;
    if length(p_patch ->> f) > 1000 or (f like 'body%' and length(trim(p_patch ->> f)) < 10) then raise exception 'invalid_body'; end if;
    for ph in select m[1] from regexp_matches(p_patch ->> f, '\{\{\s*(\w+)\s*\}\}', 'g') m loop
      if not ph = any(t.variables) then raise exception 'unknown_placeholder' using detail = ph; end if;
    end loop;
  end loop;
  if p_patch ? 'channels' then
    for ch in select jsonb_array_elements_text(p_patch -> 'channels') loop
      if ch not in ('whatsapp', 'sms', 'push', 'in_app') then raise exception 'invalid_input'; end if;
    end loop;
  end if;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  update notification_templates set
    body_en = coalesce(p_patch ->> 'body_en', body_en), body_ml = coalesce(p_patch ->> 'body_ml', body_ml),
    sms_body_en = case when p_patch ? 'sms_body_en' then nullif(trim(p_patch ->> 'sms_body_en'), '') else sms_body_en end,
    sms_body_ml = case when p_patch ? 'sms_body_ml' then nullif(trim(p_patch ->> 'sms_body_ml'), '') else sms_body_ml end,
    provider_template_name = coalesce(nullif(trim(p_patch ->> 'provider_template_name'), ''), provider_template_name),
    sms_dlt_template_id = case when p_patch ? 'sms_dlt_template_id' then nullif(trim(p_patch ->> 'sms_dlt_template_id'), '') else sms_dlt_template_id end,
    channels = case when p_patch ? 'channels' then array(select jsonb_array_elements_text(p_patch -> 'channels'))::notification_channel[] else channels end,
    active = coalesce((p_patch ->> 'active')::boolean, active), quiet_hours = coalesce((p_patch ->> 'quiet_hours')::boolean, quiet_hours),
    updated_at = now()
   where key = p_key;
end $$;

create or replace function public.set_notification_costs(p_costs jsonb, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  foreach k in array array['whatsapp', 'sms', 'push'] loop
    if not (p_costs ? k) or jsonb_typeof(p_costs -> k) <> 'number' or (p_costs ->> k)::numeric < 0 or (p_costs ->> k)::numeric > 1000 then raise exception 'invalid_input'; end if;
  end loop;
  perform set_config('app.audit_reason', left(trim(p_reason), 200), true);
  insert into app_settings (key, value) values ('notification_costs', jsonb_build_object('whatsapp', (p_costs ->> 'whatsapp')::int, 'sms', (p_costs ->> 'sms')::int, 'push', (p_costs ->> 'push')::int))
  on conflict (key) do update set value = excluded.value;
end $$;

-- staff read the templates already (templates_read); the outbox select policy (notifications_outbox) stays

-- ---------------------------------------------------------------- earlier direct in-app inserts → events
-- confirm_free_booking, capture_payment and settle_refund used to write an in-app row themselves; the
-- appointment / payment / refund triggers above now raise those events on every channel. Bodies are
-- otherwise unchanged from 20261101000006 / 20261101000007.
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
  return a;
end $$;

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

  return jsonb_build_object('result', res, 'appointment_id', a.id, 'payment_id', p.id, 'receipt_no', p.receipt_no, 'refund_id', rf,
                            'appointment_status', (select status from appointments where id = a.id));
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
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.ratings_aggregate, public.mask_phone, public.render_text, public.whatsapp_opted_in, public.quiet_hours_shift, public.enqueue_notification,
  public.appt_vars, public.notify_appointment_events, public.notify_payment_events, public.notify_refund_events, public.queue_scheduled_notifications,
  public.claim_notifications, public.mark_notification_sent, public.mark_notification_failed, public.record_delivery_status, public.push_subscription_result
  from public, anon, authenticated;
grant execute on function public.claim_notifications, public.mark_notification_sent, public.mark_notification_failed, public.record_delivery_status,
  public.push_subscription_result to service_role;
revoke execute on function public.set_notification_prefs, public.register_push_subscription, public.remove_push_subscription, public.resolve_notification_link,
  public.mark_notifications_read, public.submit_rating, public.outbox_stats, public.retry_notification, public.save_notification_template, public.set_notification_costs
  from public, anon;
grant execute on function public.set_notification_prefs, public.register_push_subscription, public.remove_push_subscription, public.resolve_notification_link,
  public.mark_notifications_read, public.submit_rating, public.outbox_stats, public.retry_notification, public.save_notification_template, public.set_notification_costs
  to authenticated;
