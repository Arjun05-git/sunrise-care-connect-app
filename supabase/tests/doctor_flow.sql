-- =============================================================================
-- Doctor flows: availability + slot rebuild, same-day reschedule (accept / free reschedule / refund /
-- expiry), doctor cancellation fallback, automatic refund, outcomes and grace, patient-view audit.
-- Same harness as rls_matrix.sql; rolled back.  psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/doctor_flow.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
create temp table t_vars (k text primary key, v text);
grant all on t_results, t_vars to authenticated;
grant usage on sequence t_results_n_seq to authenticated;
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

\set rajan  '00000001-0000-4000-8000-0000000000c9'
\set anjali '00000001-0000-4000-8000-0000000000c8'
\set arun   '00000001-0000-4000-8000-000000000064'
\set meera  '00000001-0000-4000-8000-000000000065'
\set A      '00000004-0000-4000-8000-000000000001'

with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender) values (:'rajan', 'Doctor Flow Test', '1975-05-05', 'male') returning id)
insert into t_vars select 'pt', id::text from x;

-- day D: first IST day ≥ today+2 with at least 8 open slots for Dr Arun; slots s1..s8 in time order
insert into t_vars select 'D', d from (
  select (start_at at time zone 'Asia/Kolkata')::date::text d from slots
   where doctor_id = :'A' and status = 'open' and start_at > now() + interval '2 days'
   group by 1 having count(*) >= 8 order by 1 limit 1) x;
insert into t_vars select 's' || rn, id::text from (
  select id, row_number() over (order by start_at) rn from slots
   where doctor_id = :'A' and status = 'open' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D')) x where rn <= 8;
-- another day for "pick another time"
insert into t_vars select 'other', id::text from slots
 where doctor_id = :'A' and status = 'open' and (start_at at time zone 'Asia/Kolkata')::date > (select v::date from t_vars where k = 'D') order by start_at limit 1;

-- confirmed, paid booking on a given slot
create function pg_temp.book(p_slot uuid, p_fee int default 800) returns uuid language plpgsql as $$
declare s slots; d doctors; aid uuid;
begin
  select * into s from slots where id = p_slot;
  select * into d from doctors where id = s.doctor_id;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, is_free, status)
  values ('T-' || substr(md5(random()::text), 1, 8), pg_temp.v('pt'), '00000001-0000-4000-8000-0000000000c9', d.id, d.hospital_id, d.department_id, s.id, s.start_at, s.end_at, 'video', 'first', p_fee, p_fee = 0, 'confirmed')
  returning id into aid;
  update slots set status = 'booked', appointment_id = aid where id = s.id;
  insert into appointment_symptoms (appointment_id, description, severity) values (aid, 'Test symptoms', 4);
  if p_fee > 0 then
    insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at)
    values (aid, 'mock', 'order_' || aid, 'pay_' || aid, p_fee, 'captured', now());
  end if;
  return aid;
end $$;

-- ================================================================ AVAILABILITY
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('availability', 'overlapping weekly hours rejected',
  $q$select save_weekly_hours('[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"11:00","end":"13:00"}]')$q$, 'overlapping_hours');
select pg_temp.expect_error('availability', 'direct table writes are closed (RPC keeps slots consistent)',
  format($q$insert into doctor_availability (doctor_id, kind, weekday, start_time, end_time) values (%L, 'weekly', 1, '06:00', '07:00')$q$, :'A'), 'permission denied');
select pg_temp.expect_value('availability', 'leave on day D: clash count = seeded bookings that day',
  $q$select add_leave((select v::date from t_vars where k = 'D'), (select v::date from t_vars where k = 'D'), null, null, 'Conference')::text$q$, (select count(*) from appointments where doctor_id = :'A' and status = 'confirmed' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D'))::text);
reset role;
select pg_temp.expect_value('availability', '…open slots of day D are gone', format($q$select count(*)::text from slots where doctor_id = %L and status = 'open' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D')$q$, :'A'), '0');
select pg_temp.login(:'meera');
set local role authenticated;
select pg_temp.expect_error('availability', 'another doctor cannot remove the leave', $q$select remove_leave((select id from doctor_availability where kind = 'block' and reason = 'Conference'))$q$, 'forbidden');
select pg_temp.login(:'arun');
set local role authenticated;
select remove_leave((select id from doctor_availability where kind = 'block' and reason = 'Conference'));
reset role;
select pg_temp.expect_value('availability', 'removing leave restores the slots', format($q$select (count(*) >= 8)::text from slots where doctor_id = %L and status = 'open' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D')$q$, :'A'), 'true');
-- re-read slot ids (rebuild may have recreated them)
delete from t_vars where k ~ '^s\d$';
insert into t_vars select 's' || rn, id::text from (
  select id, row_number() over (order by start_at) rn from slots
   where doctor_id = :'A' and status = 'open' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D')) x where rn <= 8;
insert into t_vars values ('a1', pg_temp.book(pg_temp.v('s1'))::text);
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_value('availability', 'leave over our booked consult counts it too',
  $q$select add_leave((select v::date from t_vars where k = 'D'), (select v::date from t_vars where k = 'D'), null, null, 'Emergency surgery')::text$q$, (select count(*) from appointments where doctor_id = :'A' and status = 'confirmed' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D'))::text);
select pg_temp.expect_value('availability', 'clash list names the booking', $q$select count(*)::text from availability_clashes() where appointment_id = (select v::uuid from t_vars where k = 'a1')$q$, '1');
reset role;
select pg_temp.expect_value('availability', 'the booked slot itself is never deleted', $q$select status::text from slots where id = (select v::uuid from t_vars where k = 's1')$q$, 'booked');
select pg_temp.login(:'arun');
set local role authenticated;
select remove_leave((select id from doctor_availability where kind = 'block' and reason = 'Emergency surgery'));
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('availability', 'patients cannot change availability', $q$select save_weekly_hours('[]')$q$, 'forbidden');
reset role;
-- s1 is booked (a1); open slots now are numbered from s1 again in the insert above → rename them
delete from t_vars where k ~ '^s\d$' and k <> 's1';
insert into t_vars select 's' || (rn + 1), id::text from (
  select id, row_number() over (order by start_at) rn from slots
   where doctor_id = :'A' and status = 'open' and (start_at at time zone 'Asia/Kolkata')::date = (select v::date from t_vars where k = 'D')) x where rn <= 7;

-- ================================================================ RESCHEDULE: accept
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('reschedule', 'reason is required', $q$select propose_reschedule(pg_temp.v('a1'), pg_temp.v('s2'), '')$q$, 'reason_required');
select pg_temp.expect_error('reschedule', 'only the same day', $q$select propose_reschedule(pg_temp.v('a1'), pg_temp.v('other'), 'Ward round overran')$q$, 'same_day_only');
insert into t_vars select 'r1', (propose_reschedule(pg_temp.v('a1'), pg_temp.v('s2'), 'Ward round overran')).id::text;
select pg_temp.expect_error('reschedule', 'one pending proposal per booking', $q$select propose_reschedule(pg_temp.v('a1'), pg_temp.v('s3'), 'Another try')$q$, 'already_pending');
reset role;
select pg_temp.expect_value('reschedule', 'proposed slot is held until the response deadline',
  $q$select s.status || '/' || (s.held_until = r.respond_by) || '/' || (r.respond_by = least(a.start_at, s.start_at) - interval '15 minutes')
     from reschedule_requests r join slots s on s.id = r.proposed_slot_id join appointments a on a.id = r.appointment_id where r.id = pg_temp.v('r1')$q$, 'held/true/true');
select pg_temp.expect_value('reschedule', 'held proposal slot is not bookable by others', $q$select slot_bookable(s)::text from slots s where id = pg_temp.v('s2')$q$, 'false');
select pg_temp.expect_value('reschedule', 'patient is notified', $q$select count(distinct event_key)::text from notifications where template_key = 'reschedule_proposed' and variables ->> 'ref' = (select ref_code from appointments where id = pg_temp.v('a1'))$q$, '1');
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_error('reschedule', 'another family cannot answer', $q$select respond_reschedule(pg_temp.v('r1'), 'accept')$q$, 'not_found');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('reschedule', 'patient sees the proposal (RLS)', $q$select count(*)::text from reschedule_requests where id = pg_temp.v('r1')$q$, '1');
insert into t_vars select 'n1', (respond_reschedule(pg_temp.v('r1'), 'accept') ->> 'appointment_id');
reset role;
select pg_temp.expect_value('reschedule', 'accept → old booking rescheduled (ref -R), new one confirmed on the proposed slot',
  $q$select o.status || '/' || (o.ref_code = n.ref_code || '-R') || '/' || n.status || '/' || (n.slot_id = pg_temp.v('s2')) || '/' || (o.rescheduled_to_id = n.id)
     from appointments o, appointments n where o.id = pg_temp.v('a1') and n.id = pg_temp.v('n1')$q$, 'rescheduled/true/confirmed/true/true');
select pg_temp.expect_value('reschedule', 'payment and symptoms move with the booking',
  $q$select (select count(*) from payments where appointment_id = pg_temp.v('n1')) || '/' || (select description from appointment_symptoms where appointment_id = pg_temp.v('n1'))$q$, '1/Test symptoms');
select pg_temp.expect_value('reschedule', 'old slot reopened, new slot booked', $q$select (select status from slots where id = pg_temp.v('s1')) || '/' || (select status from slots where id = pg_temp.v('s2'))$q$, 'open/booked');
select pg_temp.expect_value('reschedule', 'request accepted, doctor notified', $q$select r.status || '/' || (select count(distinct event_key) from notifications where template_key = 'reschedule_response' and variables ->> 'response' = 'accepted') from reschedule_requests r where id = pg_temp.v('r1')$q$, 'accepted/1');

-- ================================================================ RESCHEDULE: decline → refund
insert into t_vars values ('a2', pg_temp.book(pg_temp.v('s3'))::text);
select pg_temp.login(:'arun');
set local role authenticated;
insert into t_vars select 'r2', (propose_reschedule(pg_temp.v('a2'), pg_temp.v('s4'), 'Clinic emergency')).id::text;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('reschedule', 'decline with refund → full refund queued', $q$select (r ->> 'status') || '/' || (r ->> 'refund_id' is not null) from (select respond_reschedule(pg_temp.v('r2'), 'refund') r) x$q$, 'refund_requested/true');
reset role;
select pg_temp.expect_value('reschedule', '…booking cancelled by doctor, both slots free',
  $q$select a.status || '/' || a.outcome || '/' || (select status from slots where id = pg_temp.v('s3')) || '/' || (select status from slots where id = pg_temp.v('s4')) || '/' || (select amount from refunds where appointment_id = a.id)
     from appointments a where id = pg_temp.v('a2')$q$, 'cancelled/cancelled_by_doctor/open/open/800');

-- ================================================================ RESCHEDULE: decline → free reschedule to another day
insert into t_vars values ('a3', pg_temp.book(pg_temp.v('s5'))::text);
select pg_temp.login(:'arun');
set local role authenticated;
insert into t_vars select 'r3', (propose_reschedule(pg_temp.v('a3'), pg_temp.v('s6'), 'OT running late')).id::text;
select pg_temp.login(:'rajan');
set local role authenticated;
insert into t_vars select 'n3', (respond_reschedule(pg_temp.v('r3'), 'reschedule', pg_temp.v('other')) ->> 'appointment_id');
reset role;
select pg_temp.expect_value('reschedule', 'decline with another time → booked there, free (same fee, no new payment)',
  $q$select r.status || '/' || (n.slot_id = pg_temp.v('other')) || '/' || n.status || '/' || (select count(*) from payments where appointment_id = n.id) || '/' || (select status from slots where id = pg_temp.v('s6'))
     from reschedule_requests r, appointments n where r.id = pg_temp.v('r3') and n.id = pg_temp.v('n3')$q$, 'alternate_booked/true/confirmed/1/open');

-- ================================================================ RESCHEDULE: no answer → expired → fallback
insert into t_vars values ('a4', pg_temp.book(pg_temp.v('s7'))::text);
select pg_temp.login(:'arun');
set local role authenticated;
insert into t_vars select 'r4', (propose_reschedule(pg_temp.v('a4'), pg_temp.v('s8'), 'Called to casualty')).id::text;
reset role;
update reschedule_requests set respond_by = now() - interval '1 second' where id = pg_temp.v('r4');
select pg_temp.expect_value('expiry', 'expire job handles the unanswered proposal', 'select expire_reschedule_requests()::text', '1');
select pg_temp.expect_value('expiry', 'proposal expired, booking cancelled by doctor, both slots open, patient told to choose',
  $q$select r.status || '/' || a.status || '/' || a.outcome || '/' || (select status from slots where id = pg_temp.v('s7')) || '/' || (select status from slots where id = pg_temp.v('s8'))
       || '/' || (select count(distinct event_key) from notifications where template_key = 'doctor_unavailable' and variables ->> 'ref' = a.ref_code)
     from reschedule_requests r join appointments a on a.id = r.appointment_id where r.id = pg_temp.v('r4')$q$, 'expired/cancelled/cancelled_by_doctor/open/open/1');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('expiry', 'cannot answer an expired proposal', $q$select respond_reschedule(pg_temp.v('r4'), 'accept')$q$, 'not_pending');
insert into t_vars select 'n4', (resolve_doctor_cancellation(pg_temp.v('a4'), 'reschedule', pg_temp.v('s8')) ->> 'appointment_id');
select pg_temp.expect_error('fallback', 'the fallback can be used once', $q$select resolve_doctor_cancellation(pg_temp.v('a4'), 'refund')$q$, 'not_eligible');
reset role;
select pg_temp.expect_value('fallback', 'free reschedule after expiry → confirmed on the chosen slot', $q$select status || '/' || (slot_id = pg_temp.v('s8')) from appointments where id = pg_temp.v('n4')$q$, 'confirmed/true');

-- ================================================================ DOCTOR CANCEL → refund; auto refund
insert into t_vars values ('a5', pg_temp.book(pg_temp.v('s7'))::text);
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('cancel', 'doctor must give a reason', $q$select doctor_cancel(pg_temp.v('a5'), '')$q$, 'reason_required');
select doctor_cancel(pg_temp.v('a5'), 'Unwell today');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_value('fallback', 'patient chooses refund after doctor cancellation', $q$select (resolve_doctor_cancellation(pg_temp.v('a5'), 'refund') ->> 'refund_id' is not null)::text$q$, 'true');
select pg_temp.expect_error('fallback', 'no second refund', $q$select resolve_doctor_cancellation(pg_temp.v('a5'), 'refund')$q$, 'already_refunded');
reset role;
insert into t_vars values ('a6', pg_temp.book(pg_temp.v('s3'))::text);
insert into t_vars values ('a7', pg_temp.book(pg_temp.v('s4'), 0)::text);
select pg_temp.login(:'arun');
set local role authenticated;
select doctor_cancel(pg_temp.v('a6'), 'Unwell today');
select doctor_cancel(pg_temp.v('a7'), 'Unwell today');
reset role;
select pg_temp.expect_value('auto-refund', 'nothing before 24 h', 'select sweep_doctor_side_failures()::text', '0');
update appointments set cancelled_at = now() - interval '25 hours' where id in (pg_temp.v('a6'), pg_temp.v('a7'));
select pg_temp.expect_value('auto-refund', 'after 24 h without a choice → automatic full refund (paid only)', 'select sweep_doctor_side_failures()::text', '1');
select pg_temp.expect_value('auto-refund', '…for the full amount', $q$select amount::text from refunds where appointment_id = pg_temp.v('a6')$q$, '800');
select pg_temp.expect_value('auto-refund', 'run_scheduled_jobs reports each job', $q$select (j ? 'holds' and j ? 'reschedules' and j ? 'auto_refunds')::text from (select run_scheduled_jobs() j) x$q$, 'true');

-- ================================================================ OUTCOMES (consults in 2020: started long ago)
insert into slots (doctor_id, start_at, end_at, status) values (:'A', '2020-03-02 10:00+05:30', '2020-03-02 10:15+05:30', 'booked'), (:'A', '2020-03-02 10:15+05:30', '2020-03-02 10:30+05:30', 'booked'), (:'A', '2020-03-02 10:30+05:30', '2020-03-02 10:45+05:30', 'booked');
insert into t_vars select 'o' || rn, pg_temp.book(id)::text from (select id, row_number() over (order by start_at) rn from slots where doctor_id = :'A' and start_at between '2020-03-02 00:00+05:30' and '2020-03-03 00:00+05:30') x;  -- explicit IST bounds: a bare date means midnight in the SESSION zone
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('outcome', 'too early before the join window', $q$select record_outcome(pg_temp.v('n3'), 'completed')$q$, 'too_early');
select pg_temp.expect_value('outcome', 'completed', $q$select record_outcome(pg_temp.v('o1'), 'completed') ->> 'status'$q$, 'completed');
select pg_temp.expect_error('outcome', 'outcome can be recorded once', $q$select record_outcome(pg_temp.v('o1'), 'patient_no_show')$q$, 'outcome_recorded');
select pg_temp.expect_value('outcome', 'patient no-show after grace (refund 0 % by default)', $q$select (r ->> 'status') || '/' || (r ->> 'refund_id' is null) from (select record_outcome(pg_temp.v('o2'), 'patient_no_show') r) x$q$, 'no_show/true');
select pg_temp.expect_error('outcome', 'technical failure needs a note', $q$select record_outcome(pg_temp.v('o3'), 'technical_failure', '')$q$, 'reason_required');
select pg_temp.expect_value('outcome', 'technical failure → cancelled, patient gets the fallback', $q$select record_outcome(pg_temp.v('o3'), 'technical_failure', 'Video kept dropping') ->> 'status'$q$, 'cancelled');
select pg_temp.login(:'meera');
set local role authenticated;
select pg_temp.expect_error('outcome', 'other doctors cannot record outcomes', $q$select record_outcome(pg_temp.v('n3'), 'completed')$q$, 'not_found');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('outcome', 'patients cannot record outcomes', $q$select record_outcome(pg_temp.v('n3'), 'completed')$q$, 'not_found');
select pg_temp.expect_value('fallback', 'technical failure → patient can take a free reschedule', $q$select (resolve_doctor_cancellation(pg_temp.v('o3'), 'reschedule', pg_temp.v('s3')) ->> 'appointment_id' is not null)::text$q$, 'true');
reset role;
-- grace: a consult that started 5 minutes ago (own slot, odd seconds → no overlap with the seed grid)
update app_settings set value = '50' where key = 'patient_no_show_refund_percent';
insert into slots (doctor_id, start_at, end_at, status) values (:'A', '2020-03-02 11:00+05:30', '2020-03-02 11:15+05:30', 'booked');
insert into t_vars select 'g1', pg_temp.book(id)::text from slots where doctor_id = :'A' and start_at = '2020-03-02 11:00+05:30';
update appointments set start_at = now() - interval '5 minutes', end_at = now() - interval '4 minutes' where id = pg_temp.v('g1');
select pg_temp.login(:'arun');
set local role authenticated;
select pg_temp.expect_error('outcome', 'patient no-show only after the 10-minute grace', $q$select record_outcome(pg_temp.v('g1'), 'patient_no_show')$q$, 'grace_not_over');
reset role;
update appointments set start_at = start_at - interval '20 minutes', end_at = end_at - interval '20 minutes' where id = pg_temp.v('g1');
select pg_temp.login(:'arun');
set local role authenticated;
insert into t_vars select 'g1r', record_outcome(pg_temp.v('g1'), 'patient_no_show') ->> 'refund_id';
reset role;
select pg_temp.expect_value('outcome', 'no-show refund follows the configured % (50 % of ₹800)', $q$select amount::text from refunds where id = pg_temp.v('g1r')$q$, '400');
select pg_temp.login(:'arun');
set local role authenticated;

-- ================================================================ PATIENT TIMELINE AUDIT
select audit_patient_view(pg_temp.v('pt'));
reset role;
select pg_temp.expect_value('audit', 'opening a patient timeline is audited', $q$select count(*)::text from audit_logs where action = 'patient.view_history' and entity_id = (select v from t_vars where k = 'pt') and actor_role = 'doctor'$q$, '1');
select pg_temp.login(:'meera');
set local role authenticated;
select pg_temp.expect_error('audit', 'a doctor who never saw the patient cannot open it', $q$select audit_patient_view(pg_temp.v('pt'))$q$, 'not_found');
reset role;
select pg_temp.expect_value('realtime', 'appointments, reschedule_requests, notifications, slots are published',
  $q$select count(*)::text from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('appointments', 'reschedule_requests', 'notifications', 'slots')$q$, '4');

-- ---------------------------------------------------------------- report
reset role;
\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
