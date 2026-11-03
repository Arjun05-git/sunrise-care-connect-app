-- =============================================================================
-- NotificationService rules: whitelisted variables (no clinical content), routing with opt-in checks
-- (WhatsApp consent, SMS / reminder switches, push subscriptions), secure single-account links, events
-- from bookings / payments / refunds / cancellations / join, scheduled reminders (24 h, 1 h, 10 min),
-- feedback and follow-up reminders, quiet hours, de-duplication, dispatcher state machine, admin
-- outbox / templates / costs. Rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/notifications_flow.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
create temp table t_vars (k text primary key, v text);
grant all on t_results, t_vars to authenticated, anon;
grant usage on sequence t_results_n_seq to authenticated, anon;
create function pg_temp.expect_value(area text, name text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v; exception when others then v := 'error: ' || sqlerrm; end;
  insert into t_results (persona, check_name, expected, actual, ok) values (area, name, expected, coalesce(v, 'null'), v is not distinct from expected);
end $$;
create function pg_temp.expect_error(area text, name text, q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
    insert into t_results (persona, check_name, expected, actual, ok) values (area, name, 'error: ' || needle, 'succeeded', false);
  exception when others then
    insert into t_results (persona, check_name, expected, actual, ok) values (area, name, 'error: ' || needle, left(sqlerrm, 60), sqlerrm ilike '%' || needle || '%');
  end;
end $$;
create function pg_temp.login(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;
create function pg_temp.v(key text) returns uuid language sql as $$ select v::uuid from t_vars where k = key $$;
/** "channel:status" for one event, sorted, e.g. in_app:delivered,sms:queued,whatsapp:skipped */
create function pg_temp.routes(p_user uuid, p_event text) returns text language sql as $$
  select string_agg(channel || ':' || status || coalesce('(' || error || ')', ''), ',' order by channel::text) from notifications where user_id = p_user and event_key = p_event $$;

\set pu      'bbbbbbbb-0000-4000-8000-000000000001'
\set docuser 'bbbbbbbb-0000-4000-8000-000000000002'
\set other   '00000001-0000-4000-8000-0000000000c9'
\set admin   '00000001-0000-4000-8000-000000000001'

insert into auth.users (instance_id, id, aud, role, phone, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'pu', 'authenticated', 'authenticated', '919800000011', '{"full_name":"Lakshmi Notify"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'docuser', 'authenticated', 'authenticated', '919800000012', '{"full_name":"Dr. Notify Test"}', now(), now());
delete from user_roles where user_id = :'docuser';
insert into user_roles (user_id, role) values (:'docuser', 'doctor');
with d as (insert into doctors (profile_id, full_name, hospital_id, department_id, verification_status, modes)
           select :'docuser', 'Dr. Notify Test', hospital_id, department_id, 'verified', '{video,audio}' from doctors limit 1 returning id)
insert into t_vars select 'doc', id::text from d;
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender, is_primary) values (:'pu', 'Lakshmi Notify', '1985-05-05', 'female', true) returning id)
insert into t_vars select 'pt', id::text from x;
insert into consents (user_id, consent_type, version, granted) values (:'pu', 'whatsapp_opt_in', '1.0', true);

-- booking starting at now() + p_offset minutes; created two days ago (so reminders are due)
create function pg_temp.book(p_offset int, p_key text, p_status appointment_status) returns uuid language plpgsql as $$
declare d doctors; sid uuid; aid uuid; st timestamptz := date_trunc('minute', now()) + make_interval(mins => p_offset);
begin
  select * into d from doctors where id = pg_temp.v('doc');
  insert into slots (doctor_id, start_at, end_at, status) values (d.id, st, st + interval '15 minutes', 'booked') returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, created_at, hold_expires_at)
  values ('NT-' || substr(md5(random()::text), 1, 6), pg_temp.v('pt'), 'bbbbbbbb-0000-4000-8000-000000000001', d.id, d.hospital_id, d.department_id, sid, st, st + interval '15 minutes',
          'video', 'first', 700, p_status, now() - interval '2 days', case when p_status = 'pending_payment' then now() + interval '10 minutes' end)
  returning id into aid;
  update slots set appointment_id = aid where id = sid;
  insert into t_vars values (p_key, aid::text);
  return aid;
end $$;

-- ================================================================ TEMPLATES
select pg_temp.expect_error('templates', 'clinical variables can never be added (whitelist)', $q$insert into notification_templates (key, provider_template_name, body_en, body_ml, variables) values ('x', 'x', 'x {{diagnosis}}', 'x', '{diagnosis}')$q$, 'check constraint');
select pg_temp.expect_value('templates', 'every placeholder in every body is a declared variable',
  $q$select count(*)::text from notification_templates t, regexp_matches(t.body_en || ' ' || t.body_ml || ' ' || coalesce(t.sms_body_en, '') || ' ' || coalesce(t.sms_body_ml, ''), '\{\{(\w+)\}\}', 'g') m where not m[1] = any(t.variables)$q$, '0');
select pg_temp.expect_value('templates', 'no clinical words in any template',
  $q$select count(*)::text from notification_templates where body_en ~* '(diagnos|medicin|tablet|symptom|disease|dose|drug|allerg|fever|pain|test result)'$q$, '0');
select pg_temp.expect_value('templates', 'the full event list is there and active',
  $q$select count(*)::text from notification_templates where active and key in ('booking_confirmed', 'payment_received', 'reminder_24h', 'reminder_1h', 'reminder_10m', 'doctor_joined',
     'reschedule_proposed', 'rescheduled', 'cancelled', 'refund_initiated', 'refund_processed', 'doctor_unavailable', 'consult_missed', 'prescription_ready', 'follow_up_due',
     'follow_up_advised', 'feedback_request', 'doctor_new_booking', 'doctor_booking_cancelled', 'reschedule_response')$q$, '20');

-- ================================================================ EVENT: booking confirmed (routing)
select pg_temp.book(600, 'b1', 'pending_payment');
update appointments set status = 'confirmed', hold_expires_at = null where id = pg_temp.v('b1');
select pg_temp.expect_value('routing', 'opted in: WhatsApp + SMS queued, in-app delivered, no push without a device',
  $q$select pg_temp.routes('bbbbbbbb-0000-4000-8000-000000000001', 'booking_confirmed:' || pg_temp.v('b1'))$q$, 'in_app:delivered,sms:queued,whatsapp:queued');
select pg_temp.expect_value('routing', 'the doctor is told too (SMS + in-app; no WhatsApp for staff)',
  $q$select pg_temp.routes('bbbbbbbb-0000-4000-8000-000000000002', 'doctor_new_booking:' || pg_temp.v('b1'))$q$, 'in_app:delivered,sms:queued');
select pg_temp.expect_value('content', 'message: name, doctor, date, time, ref and a /l/ link – no ids',
  $q$select (rendered_text ~ '^Hi Lakshmi, your Sunrise teleconsultation with Dr\. Notify Test is confirmed for \d\d \w{3} \d{4} at \d\d:\d\d [AP]M IST\. Ref NT-\w{6}\. Details: http://localhost:5173/l/[0-9a-f]{32}$')
          || '/' || (position(pg_temp.v('b1')::text in rendered_text) = 0) || '/' || (to_masked like '+91 98•••••011')
     from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b1') and channel = 'sms'$q$, 'true/true/true');
select pg_temp.expect_value('content', 'one link token shared by all channels of the event',
  $q$select count(distinct link)::text from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b1') and user_id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$, '1');
select pg_temp.expect_value('dedupe', 'the same event is never sent twice',
  $q$select enqueue_notification('bbbbbbbb-0000-4000-8000-000000000001', 'booking_confirmed', '{}', '/p/appointments', 'booking_confirmed:' || pg_temp.v('b1'))::text$q$, '0');
select pg_temp.expect_value('content', 'variables outside the template are dropped (even if a caller passes them)',
  $q$select (variables ? 'diagnosis')::text from notifications where id = (select id from notifications where user_id = 'bbbbbbbb-0000-4000-8000-000000000001' and template_key = 'cancelled' limit 1)
     union all select 'false' limit 1$q$, 'false');
select enqueue_notification('bbbbbbbb-0000-4000-8000-000000000001', 'cancelled', '{"ref":"NT-X","diagnosis":"Asthma","date":"1 Jan"}', '/p/appointments', 'cancelled:test');
select pg_temp.expect_value('content', 'a clinical value passed by mistake never reaches the message',
  $q$select bool_and(not (variables ? 'diagnosis') and rendered_text not ilike '%asthma%')::text from notifications where event_key = 'cancelled:test'$q$, 'true');

-- ================================================================ OPT-IN CHECKS
update consents set withdrawn_at = now() where user_id = :'pu' and consent_type = 'whatsapp_opt_in';
select pg_temp.login(:'pu');
set local role authenticated;
select set_notification_prefs(false, true, true);
select register_push_subscription('https://push.example.com/send/abc', repeat('B', 87), repeat('a', 22), 'Chrome');
reset role;
select pg_temp.book(700, 'b2', 'confirmed');
select pg_temp.expect_value('opt-in', 'WhatsApp consent withdrawn + SMS switched off → both skipped with the reason; push to the device',
  $q$select pg_temp.routes('bbbbbbbb-0000-4000-8000-000000000001', 'booking_confirmed:' || pg_temp.v('b2'))$q$, 'in_app:delivered,push:queued,sms:skipped(opted_out),whatsapp:skipped(no_opt_in)');
select pg_temp.login(:'pu');
set local role authenticated;
select set_notification_prefs(true, true, false);   -- SMS back on, reminders off
reset role;
insert into consents (user_id, consent_type, version, granted) values (:'pu', 'whatsapp_opt_in', '1.0', true);

-- ================================================================ SCHEDULED: reminders, feedback, follow-ups
select pg_temp.book(1440 - 5, 'r24', 'confirmed');   -- in ~24 h
select pg_temp.book(55, 'r1', 'confirmed');          -- in 55 min
select pg_temp.book(8, 'r10', 'confirmed');          -- in 8 min
select pg_temp.book(-300, 'done', 'completed');
update appointments set completed_at = now() - interval '3 hours' where id = pg_temp.v('done');
select pg_temp.book(-500, 'rated', 'completed');
update appointments set completed_at = now() - interval '3 hours' where id = pg_temp.v('rated');
insert into ratings (appointment_id, doctor_id, patient_id, stars) select id, doctor_id, patient_id, 5 from appointments where id = pg_temp.v('rated');
-- follow-ups for a family member with no later bookings (a later booking rightly stops the reminder)
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender) values ('bbbbbbbb-0000-4000-8000-000000000001', 'Meera Notify', '2015-03-03', 'female') returning id)
update t_vars set v = (select id::text from x) where k = 'pt';
select pg_temp.book(-13 * 1440, 'fu', 'completed');
update appointments set completed_at = start_at + interval '15 minutes' where id = pg_temp.v('fu');
select pg_temp.book(-2 * 1440, 'adv', 'completed');
update appointments set completed_at = start_at + interval '15 minutes' where id = pg_temp.v('adv');
insert into consultations (appointment_id, doctor_id, patient_id, follow_up_date, status)
select id, doctor_id, patient_id, (now() at time zone 'Asia/Kolkata')::date, 'final' from appointments where id = pg_temp.v('adv');
update appointments set created_at = now() - interval '15 days' where id in (pg_temp.v('fu'), pg_temp.v('adv'));
update t_vars set v = (select patient_id::text from appointments where id = pg_temp.v('b1')) where k = 'pt';
insert into t_vars select 'q', queue_scheduled_notifications()::text;
select pg_temp.expect_value('reminders', 'reminders opted out → WhatsApp / SMS skipped (push not attempted), the in-app reminder stays',
  $q$select string_agg(channel || ':' || status, ',' order by channel::text) from notifications where event_key = 'reminder_1h:' || pg_temp.v('r1')$q$, 'in_app:delivered,sms:skipped,whatsapp:skipped');
select pg_temp.expect_value('reminders', '24 h, 1 h and 10 min reminders each queued once, nothing else for those bookings',
  $q$select string_agg(template_key, ',' order by template_key) from (select distinct template_key from notifications
       where appointment_id in (pg_temp.v('r24'), pg_temp.v('r1'), pg_temp.v('r10')) and template_key like 'reminder%') x$q$, 'reminder_10m,reminder_1h,reminder_24h');
select pg_temp.expect_value('reminders', 'the 10-minute reminder carries the join link',
  $q$select l.path = '/p/consult/' || pg_temp.v('r10') from notifications n join notification_links l on '/l/' || l.token = n.link where n.event_key = 'reminder_10m:' || pg_temp.v('r10') limit 1$q$, 'true');
select pg_temp.expect_value('reminders', 'running the job again queues nothing new', $q$select queue_scheduled_notifications()::text$q$, '{"feedback": 0, "reminders": 0, "follow_ups": 0}');
select pg_temp.expect_value('feedback', 'feedback request 2 h after completion, not when already rated',
  $q$select (select count(distinct event_key) from notifications where event_key = 'feedback_request:' || pg_temp.v('done')) || '/' || (select count(*) from notifications where event_key = 'feedback_request:' || pg_temp.v('rated'))$q$, '1/0');
select pg_temp.expect_value('follow-up', 'free window closing in 2 days → follow_up_due with the closing date',
  $q$select (variables ->> 'date') = to_char((select completed_at + interval '14 days' from appointments where id = pg_temp.v('fu')) at time zone 'Asia/Kolkata', 'DD Mon YYYY') from notifications where event_key = 'follow_up_due:' || pg_temp.v('fu') limit 1$q$, 'true');
select pg_temp.expect_value('follow-up', 'doctor''s follow-up date → follow_up_advised', $q$select count(distinct event_key)::text from notifications where event_key = 'follow_up_advised:' || pg_temp.v('adv')$q$, '1');
select pg_temp.expect_value('quiet hours', 'non-urgent: 23:30 IST waits for 08:00 next day',
  $q$select (quiet_hours_shift('2026-11-02 23:30+05:30', true) at time zone 'Asia/Kolkata')::text$q$, '2026-11-03 08:00:00');
select pg_temp.expect_value('quiet hours', 'non-urgent: 06:10 IST waits for 08:00 the same day',
  $q$select (quiet_hours_shift('2026-11-02 06:10+05:30', true) at time zone 'Asia/Kolkata')::text$q$, '2026-11-02 08:00:00');
select pg_temp.expect_value('quiet hours', 'daytime unchanged; urgent templates never wait',
  $q$select (quiet_hours_shift('2026-11-02 14:00+05:30', true) = '2026-11-02 14:00+05:30') || '/' || (quiet_hours_shift('2026-11-02 23:30+05:30', false) = '2026-11-02 23:30+05:30')$q$, 'true/true');
select pg_temp.expect_value('quiet hours', 'flags: 24 h reminder, follow-ups, feedback wait; 1 h / 10 min / join / payments never',
  $q$select string_agg(key, ',' order by key) from notification_templates where quiet_hours$q$, 'feedback_request,follow_up_advised,follow_up_due,reminder_24h');

-- ================================================================ EVENTS: payment, refund, cancellation, join
insert into payments (appointment_id, provider, provider_order_id, amount, status) select id, 'mock', 'order_nt_' || id, 700, 'created' from appointments where id = pg_temp.v('b1');
update payments set status = 'captured', captured_at = now(), provider_payment_id = 'pay_nt_1' where appointment_id = pg_temp.v('b1');
select pg_temp.expect_value('events', 'payment captured → receipt message with the amount',
  $q$select variables ->> 'amount' from notifications where template_key = 'payment_received' and appointment_id = pg_temp.v('b1') and channel = 'in_app'$q$, '700');
insert into refunds (payment_id, appointment_id, amount, reason, status) select id, appointment_id, 700, 'test', 'initiated' from payments where appointment_id = pg_temp.v('b1');
update refunds set status = 'processed', processed_at = now() where appointment_id = pg_temp.v('b1');
select pg_temp.expect_value('events', 'refund initiated and refund processed are two messages',
  $q$select string_agg(distinct template_key, ',' order by template_key) from notifications where appointment_id = pg_temp.v('b1') and template_key like 'refund%'$q$, 'refund_initiated,refund_processed');
update appointments set status = 'cancelled', outcome = 'cancelled_by_patient', cancelled_at = now() where id = pg_temp.v('b2');
select pg_temp.expect_value('events', 'patient cancellation → patient and doctor told',
  $q$select string_agg(distinct template_key, ',' order by template_key) from notifications where appointment_id = pg_temp.v('b2') and template_key like '%cancelled'$q$, 'cancelled,doctor_booking_cancelled');
update appointments set doctor_joined_at = now() where id = pg_temp.v('r10');
select pg_temp.expect_value('events', 'doctor in the room, patient not yet → join link', $q$select count(distinct event_key)::text from notifications where event_key = 'doctor_joined:' || pg_temp.v('r10')$q$, '1');
update appointments set status = 'confirmed' where id = pg_temp.v('b2');
select pg_temp.expect_value('events', 'no confirmation for a status change that is not a booking', $q$select count(distinct event_key)::text from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b2')$q$, '1');

-- ================================================================ SECURE LINKS + BELL
select pg_temp.login(:'pu');
set local role authenticated;
insert into t_vars select 'tok', substr(link, 4) from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b1') and channel = 'in_app';
select pg_temp.expect_value('links', 'owner opens the link → the page it points to', $q$select resolve_notification_link((select v from t_vars where k = 'tok'))$q$, '/p/appointments');
select pg_temp.expect_value('links', 'unread in-app messages for the bell', $q$select (count(*) > 0)::text from notifications where channel = 'in_app' and read_at is null$q$, 'true');
select mark_notifications_read();
select pg_temp.expect_value('links', 'mark all read', $q$select count(*)::text from notifications where channel = 'in_app' and read_at is null$q$, '0');
select pg_temp.expect_error('links', 'users cannot rewrite their outbox rows', $q$update notifications set status = 'read', rendered_text = 'x'$q$, 'permission denied');
select pg_temp.expect_error('links', 'clients cannot queue messages', $q$select enqueue_notification(auth.uid(), 'cancelled', '{}', '/p', 'x')$q$, 'permission denied');
select pg_temp.expect_error('links', 'clients cannot run the dispatcher', $q$select claim_notifications(10)$q$, 'permission denied');
reset role;
select pg_temp.expect_value('links', 'clicked is recorded', $q$select (clicked_at is not null)::text from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b1') and channel = 'sms'$q$, 'true');
select pg_temp.login(:'other');
set local role authenticated;
select pg_temp.expect_error('links', 'another account cannot open the link', $q$select resolve_notification_link((select v from t_vars where k = 'tok'))$q$, 'not_found');
select pg_temp.expect_value('links', 'and sees none of these messages', $q$select count(*)::text from notifications where user_id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$, '0');
reset role;

-- ================================================================ DISPATCHER (service)
update notifications set send_after = now() - interval '1 minute' where status = 'queued';
insert into t_vars select 'claim', claim_notifications(500)::text;
select pg_temp.expect_value('dispatch', 'claim returns due rows with phone / template info; leases them',
  $q$select (jsonb_array_length(c) > 0) || '/' || (select bool_and(e ? 'phone' and e ? 'whatsapp_template' and e ? 'sms_dlt_template_id') from jsonb_array_elements(c) e)
          || '/' || (select count(*) from notifications where status = 'queued' and send_after <= now())
     from (select v::jsonb c from t_vars where k = 'claim') x$q$, 'true/true/0');
insert into t_vars select 'sms1', id::text from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b1') and channel = 'sms';
insert into t_vars select 'wa1', id::text from notifications where event_key = 'booking_confirmed:' || pg_temp.v('b1') and channel = 'whatsapp';
select mark_notification_sent(pg_temp.v('wa1'), 'whatsapp_cloud', 'wamid.TEST1', 13);
select record_delivery_status('whatsapp_cloud', 'wamid.TEST1', 'read');
select record_delivery_status('whatsapp_cloud', 'wamid.TEST1', 'delivered');
select pg_temp.expect_value('dispatch', 'receipts only move forward (sent → read stays read)', $q$select status || '/' || cost_paise || '/' || (seen_at is not null) from notifications where id = pg_temp.v('wa1')$q$, 'read/13/true');
select pg_temp.expect_value('dispatch', 'temporary error → retried with backoff', $q$select mark_notification_failed(pg_temp.v('sms1'), 'msg91', 'timeout', false) || '/' || status from notifications where id = pg_temp.v('sms1')$q$, 'retry/queued');
update notifications set attempts = 3 where id = pg_temp.v('sms1');
select pg_temp.expect_value('dispatch', 'after 3 attempts → failed', $q$select mark_notification_failed(pg_temp.v('sms1'), 'msg91', 'timeout', false)$q$, 'failed');
select pg_temp.expect_value('dispatch', '… and stays failed', $q$select status || '/' || (failed_at is not null) from notifications where id = pg_temp.v('sms1')$q$, 'failed/true');

-- ================================================================ ADMIN
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_value('admin', 'outbox stats: per-channel counts and cost',
  $q$select (s -> 'by_channel' @> '[{"channel":"whatsapp"}]') || '/' || ((s ->> 'cost_paise')::int >= 13) from (select outbox_stats(now() - interval '1 day', now() + interval '1 day') s) x$q$, 'true/true');
select retry_notification(pg_temp.v('sms1'));
select pg_temp.expect_value('admin', 'retry a failed message', $q$select status || '/' || attempts from notifications where id = pg_temp.v('sms1')$q$, 'queued/0');
select pg_temp.expect_error('admin', 'template edit: unknown placeholder refused', $q$select save_notification_template('cancelled', '{"body_en":"Booking {{ref}} for {{diagnosis}} was cancelled {{link}}"}', 'Wording update')$q$, 'unknown_placeholder');
select pg_temp.expect_error('admin', 'template edit needs a reason', $q$select save_notification_template('cancelled', '{"active":false}', '')$q$, 'reason_required');
select save_notification_template('cancelled', '{"body_en":"Your booking {{ref}} on {{date}} is cancelled. See {{link}}","channels":["sms","in_app"]}', 'Shorter wording');
select pg_temp.expect_value('admin', 'template edited (audited)', $q$select body_en || '|' || array_to_string(channels, ',') from notification_templates where key = 'cancelled'$q$, 'Your booking {{ref}} on {{date}} is cancelled. See {{link}}|sms,in_app');
select set_notification_costs('{"whatsapp": 12, "sms": 22, "push": 0}', 'New rate card');
select pg_temp.expect_value('admin', 'cost rates saved', $q$select value::text from app_settings where key = 'notification_costs'$q$, '{"sms": 22, "push": 0, "whatsapp": 12}');
reset role;
select pg_temp.login(:'pu');
set local role authenticated;
select pg_temp.expect_error('admin', 'patients cannot see outbox stats', $q$select outbox_stats(now() - interval '1 day', now())$q$, 'forbidden');
select pg_temp.expect_error('admin', 'nor edit templates', $q$select save_notification_template('cancelled', '{"active":false}', 'trying it')$q$, 'forbidden');

-- ================================================================ FEEDBACK
select submit_rating(pg_temp.v('done'), 4, 'Clear advice');
select pg_temp.expect_error('feedback', 'one rating per consultation', $q$select submit_rating(pg_temp.v('done'), 5, '')$q$, 'already_rated');
select pg_temp.expect_error('feedback', 'only completed consultations', $q$select submit_rating(pg_temp.v('r1'), 5, '')$q$, 'not_completed');
reset role;
select pg_temp.expect_value('feedback', 'doctor rating updated', $q$select rating_avg || '/' || rating_count from doctors where id = pg_temp.v('doc')$q$, '4.5/2');

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
