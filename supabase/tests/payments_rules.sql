-- =============================================================================
-- Fee calculation, follow-up policy engine, refund rules, capture idempotency, reconciliation.
-- Deterministic: synthetic consults in 2020 / 2030 for a test patient (no overlap with the seed),
-- refund_quote() takes an explicit "now". Same harness as rls_matrix.sql; everything is rolled back.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/payments_rules.sql
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
  begin
    execute q into v;
  exception when others then v := 'error: ' || sqlerrm;
  end;
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

-- test patient (owned by Rajan) + doctors: A = Arun (Cardiology), B = Vivek (Cardiology), C = Meera (General Medicine)
\set rajan   '00000001-0000-4000-8000-0000000000c9'
\set admin   '00000001-0000-4000-8000-000000000001'
\set finance '00000001-0000-4000-8000-000000000002'
\set coord   '00000001-0000-4000-8000-000000000003'
\set A '00000004-0000-4000-8000-000000000001'
\set B '00000004-0000-4000-8000-00000000000a'
\set C '00000004-0000-4000-8000-000000000002'
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender) values (:'rajan', 'Rules Test', '1980-01-01', 'male') returning id)
insert into t_vars select 'pt', id::text from x;
with x as (insert into patients (owner_user_id, full_name, date_of_birth, gender) values (:'rajan', 'Rules Test Two', '1982-01-01', 'female') returning id)
insert into t_vars select 'pt2', id::text from x;

-- synthetic consult: own slot, given status / free / fee; returns the appointment id
create function pg_temp.mk(p_patient uuid, p_doc uuid, p_start timestamptz, p_status appointment_status, p_free boolean, p_fee int,
                           p_index uuid default null, p_override uuid default null) returns uuid language plpgsql as $$
declare sid uuid; aid uuid; d doctors;
begin
  select * into d from doctors where id = p_doc;
  insert into slots (doctor_id, start_at, end_at, status) values (p_doc, p_start, p_start + interval '15 min',
    case when p_status = 'cancelled' then 'open' when p_status = 'pending_payment' then 'held' else 'booked' end::slot_status) returning id into sid;
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type,
                            index_appointment_id, follow_up_override_id, fee_amount, is_free, status, completed_at, hold_expires_at)
  values ('T-' || substr(md5(random()::text), 1, 8), p_patient, '00000001-0000-4000-8000-0000000000c9', p_doc, d.hospital_id, d.department_id, sid,
          p_start, p_start + interval '15 min', 'video', case when p_index is null and p_override is null then 'first' else 'follow_up' end::consult_type,
          p_index, p_override, p_fee, p_free, p_status, case when p_status = 'completed' then p_start + interval '15 min' end,
          case when p_status = 'pending_payment' then now() + interval '10 min' end)
  returning id into aid;
  if p_status <> 'cancelled' then update slots set appointment_id = aid where id = sid; end if;
  return aid;
end $$;
create function pg_temp.dec(p_patient uuid, p_doc uuid, p_start timestamptz) returns text language sql as $$
  select consult_type || '/' || is_free || '/' || reason from determine_consult_type(p_patient, p_doc, p_start)
$$;

-- ================================================================ FOLLOW-UP ENGINE (policy: 14 days, 1 free, same doctor)
update follow_up_policy set free_window_days = 14, free_follow_up_count = 1, match_rule = 'same_doctor';
select pg_temp.expect_value('follow-up', 'no history → first, paid', format($q$select pg_temp.dec(%L, %L, '2020-01-05 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'first/false/no_prior_consult');
-- index consult with A: 1 Jan 2020 10:00–10:15 IST, completed, paid ₹800
insert into t_vars values ('i1', pg_temp.mk(pg_temp.v('pt'), :'A', '2020-01-01 10:00+05:30', 'completed', false, 800)::text);
select pg_temp.expect_value('follow-up', 'same doctor within window → free follow-up', format($q$select pg_temp.dec(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'follow_up/true/free_follow_up');
select pg_temp.expect_value('follow-up', 'index = the paid completed consult', format($q$select index_appointment_id::text = %L from determine_consult_type(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('i1'), pg_temp.v('pt'), :'A'), 'true');
select pg_temp.expect_value('follow-up', 'window boundary: exactly 14 days after the consult ended → free', format($q$select pg_temp.dec(%L, %L, '2020-01-15 10:15+05:30')$q$, pg_temp.v('pt'), :'A'), 'follow_up/true/free_follow_up');
select pg_temp.expect_value('follow-up', '14 days + 1 minute → first consult (window expired)', format($q$select pg_temp.dec(%L, %L, '2020-01-15 10:16+05:30')$q$, pg_temp.v('pt'), :'A'), 'first/false/window_expired');
select pg_temp.expect_value('follow-up', 'consult before the index ended is not a follow-up', format($q$select pg_temp.dec(%L, %L, '2020-01-01 10:10+05:30')$q$, pg_temp.v('pt'), :'A'), 'first/false/no_prior_consult');
select pg_temp.expect_value('follow-up', 'same_doctor rule: other cardiologist → first', format($q$select pg_temp.dec(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('pt'), :'B'), 'first/false/no_prior_consult');
update follow_up_policy set match_rule = 'same_department';
select pg_temp.expect_value('follow-up', 'same_department rule: other cardiologist → free', format($q$select pg_temp.dec(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('pt'), :'B'), 'follow_up/true/free_follow_up');
select pg_temp.expect_value('follow-up', 'same_department rule: other department → first', format($q$select pg_temp.dec(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('pt'), :'C'), 'first/false/no_prior_consult');
update follow_up_policy set match_rule = 'any';
select pg_temp.expect_value('follow-up', 'any rule: any doctor → free', format($q$select pg_temp.dec(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('pt'), :'C'), 'follow_up/true/free_follow_up');
update follow_up_policy set match_rule = 'same_doctor';
update follow_up_policy set free_window_days = 30;
select pg_temp.expect_value('follow-up', 'window is configurable (30 days → day 20 free)', format($q$select pg_temp.dec(%L, %L, '2020-01-21 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'follow_up/true/free_follow_up');
update follow_up_policy set free_window_days = 14;

-- use the free follow-up
insert into t_vars values ('f1', pg_temp.mk(pg_temp.v('pt'), :'A', '2020-01-05 10:00+05:30', 'confirmed', true, 0, pg_temp.v('i1'))::text);
select pg_temp.expect_value('follow-up', 'count 1 used → next follow-up is paid', format($q$select pg_temp.dec(%L, %L, '2020-01-08 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'follow_up/false/follow_up_free_exhausted');
select pg_temp.expect_value('fees', 'paid follow-up uses the follow-up fee (dept video ₹500)', format($q$select quote_fee(%L, %L, '2020-01-08 10:00+05:30', 'video') ->> 'fee'$q$, :'A', pg_temp.v('pt')), '500');
update follow_up_policy set free_follow_up_count = 2;
select pg_temp.expect_value('follow-up', 'count 2 → one left after one used', format($q$select free_remaining || '/' || is_free from determine_consult_type(%L, %L, '2020-01-08 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), '1/true');
update follow_up_policy set free_follow_up_count = 0;
select pg_temp.expect_value('follow-up', 'count 0 → follow-ups are always paid', format($q$select pg_temp.dec(%L, %L, '2020-01-04 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'follow_up/false/follow_up_free_exhausted');
update follow_up_policy set free_follow_up_count = 1;
update appointments set status = 'cancelled' where id = pg_temp.v('f1');
select pg_temp.expect_value('follow-up', 'cancelled free follow-up does not use up the allowance', format($q$select pg_temp.dec(%L, %L, '2020-01-08 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'follow_up/true/free_follow_up');
-- a completed FREE follow-up never becomes the index (window still runs from the paid consult)
insert into t_vars values ('f2', pg_temp.mk(pg_temp.v('pt'), :'A', '2020-01-06 10:00+05:30', 'completed', true, 0, pg_temp.v('i1'))::text);
select pg_temp.expect_value('follow-up', 'free follow-up is never an index consult', format($q$select index_appointment_id::text = %L from determine_consult_type(%L, %L, '2020-01-10 10:00+05:30')$q$, pg_temp.v('i1'), pg_temp.v('pt'), :'A'), 'true');
select pg_temp.expect_value('follow-up', '…and day 16 is outside the window of the paid consult', format($q$select pg_temp.dec(%L, %L, '2020-01-17 10:00+05:30')$q$, pg_temp.v('pt'), :'A'), 'first/false/window_expired');
-- no-show / cancelled paid consults are not index consults
select pg_temp.mk(pg_temp.v('pt2'), :'A', '2020-02-01 10:00+05:30', 'no_show', false, 800);
select pg_temp.mk(pg_temp.v('pt2'), :'A', '2020-02-02 10:00+05:30', 'cancelled', false, 800);
select pg_temp.expect_value('follow-up', 'no-show or cancelled consult is not an index', format($q$select pg_temp.dec(%L, %L, '2020-02-05 10:00+05:30')$q$, pg_temp.v('pt2'), :'A'), 'first/false/no_prior_consult');

-- ================================================================ ADMIN OVERRIDE
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_error('override', 'reason is mandatory', format($q$select grant_follow_up_override(%L, %L, 1, now() + interval '30 days', 'ok')$q$, pg_temp.v('pt2'), :'C'), 'reason_required');
insert into t_vars values ('o1', (grant_follow_up_override(pg_temp.v('pt2'), :'C', 1, now() + interval '30 days', 'Report review after lab delay')).id::text);
reset role;
select pg_temp.expect_value('override', 'override makes a consult with that doctor free', format($q$select pg_temp.dec(%L, %L, now() + interval '2 days')$q$, pg_temp.v('pt2'), :'C'), 'follow_up/true/admin_override');
select pg_temp.expect_value('override', 'quote shows the waived fee as a discount', format($q$select (q ->> 'fee') || '/' || (q ->> 'discount') from (select quote_fee(%L, %L, now() + interval '2 days', 'video') q) x$q$, :'C', pg_temp.v('pt2')), '0/' || (select resolve_fee(:'C', 'video', 'follow_up')));
select pg_temp.expect_value('override', 'doctor-specific override does not apply to another doctor', format($q$select pg_temp.dec(%L, %L, now() + interval '2 days')$q$, pg_temp.v('pt2'), :'A'), 'first/false/no_prior_consult');
select pg_temp.expect_value('override', 'expired override is ignored', format($q$select pg_temp.dec(%L, %L, now() + interval '40 days')$q$, pg_temp.v('pt2'), :'C'), 'first/false/no_prior_consult');
select pg_temp.mk(pg_temp.v('pt2'), :'C', date_trunc('hour', now()) + interval '20 days 7 minutes', 'confirmed', true, 0, null, pg_temp.v('o1'));
select pg_temp.expect_value('override', 'override is consumed once used', format($q$select pg_temp.dec(%L, %L, now() + interval '21 days')$q$, pg_temp.v('pt2'), :'C'), 'first/false/no_prior_consult');
select pg_temp.login(:'admin');
set local role authenticated;
insert into t_vars values ('o2', (grant_follow_up_override(pg_temp.v('pt2'), null, 1, now() + interval '30 days', 'Goodwill after doctor delay')).id::text);
reset role;
select pg_temp.expect_value('override', '"any doctor" override applies to every doctor', format($q$select pg_temp.dec(%L, %L, now() + interval '2 days')$q$, pg_temp.v('pt2'), :'A'), 'follow_up/true/admin_override');
select pg_temp.login(:'admin');
set local role authenticated;
select revoke_follow_up_override(pg_temp.v('o2'), 'Granted by mistake');
reset role;
select pg_temp.expect_value('override', 'revoked override is ignored', format($q$select pg_temp.dec(%L, %L, now() + interval '2 days')$q$, pg_temp.v('pt2'), :'A'), 'first/false/no_prior_consult');
select pg_temp.expect_value('override', 'grant and revoke are audited with the reason', $q$select count(*)::text from audit_logs where entity = 'follow_up_overrides' and reason in ('Goodwill after doctor delay', 'Granted by mistake')$q$, '2');
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_error('override', 'finance cannot grant overrides', format($q$select grant_follow_up_override(%L, null, 1, now() + interval '3 days', 'Trying to help')$q$, pg_temp.v('pt2')), 'forbidden');
reset role;

-- ================================================================ FEES
select pg_temp.expect_value('fees', 'doctor-specific fee wins over department (Arun video ₹800)', format($q$select quote_fee(%L, %L, '2030-03-01 10:00+05:30', 'video') ->> 'fee'$q$, :'A', pg_temp.v('pt2')), '800');
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_error('fees', 'fee change needs a reason', format($q$select save_fee('doctor', %L, null, 'video', 'first', 999, '')$q$, :'A'), 'reason_required');
select pg_temp.expect_error('fees', 'negative fee rejected', format($q$select save_fee('doctor', %L, null, 'video', 'first', -5, 'Typo fix')$q$, :'A'), 'invalid_amount');
select save_fee('doctor', :'A', null, 'video', 'first', 999, 'Senior consultant rate');
reset role;
select pg_temp.expect_value('fees', 'saved doctor fee is used by the quote', format($q$select quote_fee(%L, %L, '2030-03-01 10:00+05:30', 'video') ->> 'fee'$q$, :'A', pg_temp.v('pt2')), '999');
select pg_temp.login(:'finance');
set local role authenticated;
select delete_fee((select id from fee_config where scope = 'doctor' and doctor_id = :'A' and mode = 'video' and consult_type = 'first'), 'Back to department rate');
select pg_temp.expect_error('fees', 'department default cannot be deleted', $q$select delete_fee((select id from fee_config where scope = 'department' limit 1), 'Cleanup please')$q$, 'department_fee_required');
reset role;
select pg_temp.expect_value('fees', 'without a doctor fee the department fee applies (₹800 dept video)', format($q$select quote_fee(%L, %L, '2030-03-01 10:00+05:30', 'video') ->> 'fee'$q$, :'A', pg_temp.v('pt2')), '800');
select pg_temp.expect_value('fees', 'fee changes are audited with the reason', $q$select count(*)::text from audit_logs where entity = 'fee_config' and reason in ('Senior consultant rate', 'Back to department rate')$q$, '2');
select pg_temp.expect_value('fees', 'a booked appointment keeps its frozen fee after a fee change', format($q$select fee_amount::text from appointments where id = %L$q$, pg_temp.v('i1')), '800');

-- ================================================================ CAPTURE
insert into t_vars values ('h1', pg_temp.mk(pg_temp.v('pt'), :'C', '2030-01-10 10:00+05:30', 'pending_payment', false, 600)::text);
select register_payment_order(pg_temp.v('h1'), 'mock', 'order_t1', 600);
select pg_temp.expect_value('capture', 'a second order request reuses the open order', $q$select provider_order_id from register_payment_order((select v::uuid from t_vars where k = 'h1'), 'mock', 'order_t1b', 600)$q$, 'order_t1');
select pg_temp.expect_error('capture', 'amount mismatch is rejected', $q$select capture_payment('order_t1', 'pay_x', 'upi', 1, 'checkout')$q$, 'amount_mismatch');
select pg_temp.expect_value('capture', 'capture confirms the booking', $q$select capture_payment('order_t1', 'pay_t1', 'upi', 600, 'checkout') ->> 'result'$q$, 'confirmed');
select pg_temp.expect_value('capture', 'second capture (webhook) is a no-op', $q$select capture_payment('order_t1', 'pay_t1', 'upi', 600, 'webhook') ->> 'result'$q$, 'already_captured');
select pg_temp.expect_value('capture', 'appointment confirmed, slot booked, receipt numbered',
  format($q$select a.status || '/' || s.status || '/' || (p.receipt_no ~ '^SCR-\d{4}-\d{6}$') from appointments a join slots s on s.id = a.slot_id join payments p on p.appointment_id = a.id where a.id = %L$q$, pg_temp.v('h1')), 'confirmed/booked/true');
select pg_temp.expect_value('capture', 'exactly one payment notification', format($q$select count(distinct event_key)::text from notifications where template_key = 'payment_received' and variables ->> 'ref' = (select ref_code from appointments where id = %L)$q$, pg_temp.v('h1')), '1');
-- hold lapsed during payment, slot still free → taken back
insert into t_vars values ('h2', pg_temp.mk(pg_temp.v('pt'), :'C', '2030-01-11 10:00+05:30', 'pending_payment', false, 600)::text);
select register_payment_order(pg_temp.v('h2'), 'mock', 'order_t2', 600);
update appointments set hold_expires_at = now() - interval '1 second' where id = pg_temp.v('h2');
select expire_holds();
select pg_temp.expect_value('capture', 'late payment, slot still free → booking reinstated', $q$select capture_payment('order_t2', 'pay_t2', 'card', 600, 'webhook') ->> 'result'$q$, 'confirmed_late');
-- hold lapsed and someone else took the slot → automatic full refund
insert into t_vars values ('h3', pg_temp.mk(pg_temp.v('pt'), :'C', '2030-01-12 10:00+05:30', 'pending_payment', false, 600)::text);
select register_payment_order(pg_temp.v('h3'), 'mock', 'order_t3', 600);
update appointments set hold_expires_at = now() - interval '1 second' where id = pg_temp.v('h3');
select expire_holds();
insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
  select 'T-TAKEN', pg_temp.v('pt2'), :'rajan', doctor_id, hospital_id, department_id, slot_id, start_at, end_at, 'video', 'first', 600, 'confirmed' from appointments where id = pg_temp.v('h3');
select pg_temp.expect_value('capture', 'late payment, slot taken → automatic full refund', $q$select capture_payment('order_t3', 'pay_t3', 'upi', 600, 'webhook') ->> 'result'$q$, 'refund_pending');
select pg_temp.expect_value('capture', '…refund of the full amount is queued', format($q$select amount || '/' || status from refunds where appointment_id = %L$q$, pg_temp.v('h3')), '600/initiated');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('capture', 'clients cannot call capture_payment', $q$select capture_payment('order_t1', 'p', 'upi', 600, 'checkout')$q$, 'permission denied');
select pg_temp.expect_error('capture', 'clients cannot call settle_refund', $q$select settle_refund(gen_random_uuid(), 'processed', 'x')$q$, 'permission denied');
select pg_temp.expect_error('capture', 'free bookings cannot be paid', format($q$select prepare_payment(%L)$q$, pg_temp.v('f2')), 'hold_expired');
reset role;

-- ================================================================ REFUND POLICY (tiers: ≥2 h → 100 %, else 0 %)
-- paid ₹600 consult h1 starts 2030-01-10 10:00 IST
select pg_temp.expect_value('refund-rule', 'patient cancels 3 h before → 100 %', format($q$select (q ->> 'percent') || '/' || (q ->> 'amount') from (select refund_quote(%L, 'patient', '2030-01-10 07:00+05:30') q) x$q$, pg_temp.v('h1')), '100/600');
select pg_temp.expect_value('refund-rule', 'exactly 2 h before → 100 % (boundary inclusive)', format($q$select refund_quote(%L, 'patient', '2030-01-10 08:00+05:30') ->> 'amount'$q$, pg_temp.v('h1')), '600');
select pg_temp.expect_value('refund-rule', '1 h 59 min before → 0 %', format($q$select (q ->> 'rule') || '/' || (q ->> 'amount') from (select refund_quote(%L, 'patient', '2030-01-10 08:01+05:30') q) x$q$, pg_temp.v('h1')), 'tier/0');
select pg_temp.expect_value('refund-rule', 'after the start → no refund', format($q$select (q ->> 'rule') || '/' || (q ->> 'amount') from (select refund_quote(%L, 'patient', '2030-01-10 10:10+05:30') q) x$q$, pg_temp.v('h1')), 'no_tier/0');
select pg_temp.expect_value('refund-rule', 'doctor cancels (even late) → 100 %', format($q$select refund_quote(%L, 'doctor', '2030-01-10 09:59+05:30') ->> 'amount'$q$, pg_temp.v('h1')), '600');
select pg_temp.expect_value('refund-rule', 'free consult → nothing to refund', format($q$select (q ->> 'rule') || '/' || (q ->> 'amount') from (select refund_quote(%L, 'admin') q) x$q$, pg_temp.v('f2')), 'free_consult/0');
select pg_temp.login(:'admin');
set local role authenticated;
select pg_temp.expect_error('refund-rule', 'tiers must cover cancellations right up to the start', $q$select update_cancellation_tiers('[{"min_hours_before": 24, "percent": 100}]', 'New policy 2030')$q$, 'tier_zero_required');
select pg_temp.expect_error('refund-rule', 'percent must be 0–100', $q$select update_cancellation_tiers('[{"min_hours_before": 0, "percent": 120}]', 'New policy 2030')$q$, 'invalid_input');
select update_cancellation_tiers('[{"min_hours_before": 0, "percent": 0}, {"min_hours_before": 24, "percent": 100}, {"min_hours_before": 6, "percent": 50}]', 'Three-tier policy approved');
reset role;
select pg_temp.expect_value('refund-rule', 'tiers configurable: 10 h before → 50 % of ₹600', format($q$select refund_quote(%L, 'patient', '2030-01-09 24:00+05:30') ->> 'amount'$q$, pg_temp.v('h1')), '300');
select pg_temp.expect_value('refund-rule', '…30 h before → 100 %', format($q$select refund_quote(%L, 'patient', '2030-01-09 04:00+05:30') ->> 'amount'$q$, pg_temp.v('h1')), '600');
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_error('refund-rule', 'finance cannot change the refund policy', $q$select update_cancellation_tiers('[{"min_hours_before": 0, "percent": 100}]', 'Be generous')$q$, 'forbidden');

-- ================================================================ PARTIAL / FULL REFUNDS (finance)
select pg_temp.expect_error('refund', 'reason is mandatory', format($q$select request_refund((select id from payments where appointment_id = %L), 100, '')$q$, pg_temp.v('h1')), 'reason_required');
insert into t_vars values ('r1', (request_refund((select id from payments where appointment_id = pg_temp.v('h1')), 200, 'Partial: audio-only consult')).id::text);
select pg_temp.expect_error('refund', 'cannot refund more than what is left (₹400)', format($q$select request_refund((select id from payments where appointment_id = %L), 401, 'Too much refund')$q$, pg_temp.v('h1')), 'invalid_amount');
select pg_temp.expect_error('refund', 'zero amount rejected', format($q$select request_refund((select id from payments where appointment_id = %L), 0, 'Zero refund')$q$, pg_temp.v('h1')), 'invalid_amount');
reset role;
select settle_refund(pg_temp.v('r1'), 'processed', 'rfnd_t1');
select pg_temp.expect_value('refund', 'partial refund processed → payment partially_refunded', format($q$select status::text from payments where appointment_id = %L$q$, pg_temp.v('h1')), 'partially_refunded');
select settle_refund(pg_temp.v('r1'), 'processed', 'rfnd_t1');
select pg_temp.expect_value('refund', 'settling twice is idempotent (one notification)', format($q$select count(distinct event_key)::text from notifications where template_key = 'refund_initiated' and variables ->> 'ref' = (select ref_code from appointments where id = %L)$q$, pg_temp.v('h1')), '1');
select pg_temp.expect_value('refund', 'admin cancel after a partial refund only refunds the rest', format($q$select refund_quote(%L, 'admin') ->> 'amount'$q$, pg_temp.v('h1')), '400');
select pg_temp.login(:'finance');
set local role authenticated;
insert into t_vars values ('r2', (request_refund((select id from payments where appointment_id = pg_temp.v('h1')), 400, 'Remaining amount: doctor unavailable')).id::text);
reset role;
select settle_refund(pg_temp.v('r2'), 'failed', null, 'bank declined');
select pg_temp.expect_value('refund', 'failed refund does not count as refunded', format($q$select status::text from payments where appointment_id = %L$q$, pg_temp.v('h1')), 'partially_refunded');
select pg_temp.login(:'finance');
set local role authenticated;
select retry_refund(pg_temp.v('r2'));
reset role;
select pg_temp.expect_value('refund', 'retry puts a failed refund back in the queue', format($q$select status::text from refunds where id = %L$q$, pg_temp.v('r2')), 'initiated');
select pg_temp.expect_value('refund', 'claim_refund hands it to exactly one worker', format($q$select (claim_refund(%L) is not null)::text || '/' || (claim_refund(%L) is null)::text$q$, pg_temp.v('r2'), pg_temp.v('r2')), 'true/true');
select settle_refund(pg_temp.v('r2'), 'processed', 'rfnd_t2');
select pg_temp.expect_value('refund', 'refunded in full → payment refunded', format($q$select status::text from payments where appointment_id = %L$q$, pg_temp.v('h1')), 'refunded');
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_error('refund', 'nothing left to refund', format($q$select request_refund((select id from payments where appointment_id = %L), 1, 'One more rupee')$q$, pg_temp.v('h1')), 'not_refundable');
reset role;
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('refund', 'patients cannot issue refunds', format($q$select request_refund((select id from payments where appointment_id = %L), 10, 'Give me money')$q$, pg_temp.v('h2')), 'forbidden');

-- ================================================================ CANCELLATION (patient / staff)
select pg_temp.expect_value('cancel', 'patient cancels a paid consult days ahead → 100 % refund queued',
  format($q$select (c ->> 'cancelled_by') || '/' || (c ->> 'amount') || '/' || (c ->> 'refund_id' is not null) from (select cancel_appointment(%L, 'Feeling better') c) x$q$, pg_temp.v('h2')), 'patient/600/true');
reset role;
select pg_temp.expect_value('cancel', 'slot reopened, outcome recorded', format($q$select a.outcome || '/' || s.status from appointments a join slots s on s.id = a.slot_id where a.id = %L$q$, pg_temp.v('h2')), 'cancelled_by_patient/open');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('cancel', 'cannot cancel twice', format($q$select cancel_appointment(%L, 'again')$q$, pg_temp.v('h2')), 'not_cancellable');
select pg_temp.login('00000001-0000-4000-8000-0000000000c8');   -- Anjali: not her booking
set local role authenticated;
select pg_temp.expect_error('cancel', 'cannot cancel someone else''s booking', format($q$select cancel_appointment(%L, 'x')$q$, pg_temp.v('h1')), 'not_found');
reset role;
insert into t_vars values ('h4', pg_temp.mk(pg_temp.v('pt'), :'C', '2030-01-13 10:00+05:30', 'pending_payment', false, 600)::text);
select register_payment_order(pg_temp.v('h4'), 'mock', 'order_t4', 600);
select capture_payment('order_t4', 'pay_t4', 'netbanking', 600, 'checkout');
select pg_temp.login(:'coord');
set local role authenticated;
select pg_temp.expect_error('cancel', 'staff must give a reason', format($q$select cancel_appointment(%L, '')$q$, pg_temp.v('h4')), 'reason_required');
select pg_temp.expect_value('cancel', 'coordinator cancels → 100 % refund (admin rule)', format($q$select (c ->> 'rule') || '/' || (c ->> 'amount') from (select cancel_appointment(%L, 'Doctor on emergency duty') c) x$q$, pg_temp.v('h4')), 'doctor_or_admin_cancel/600');
reset role;

-- ================================================================ RECONCILIATION
select settle_refund((select id from refunds where appointment_id = pg_temp.v('h2')), 'processed', 'rfnd_t3');
select pg_temp.login(:'finance');
set local role authenticated;
select pg_temp.expect_value('recon', 'captures and refunds of the day, net amount',
  $q$select count(*) filter (where kind = 'payment') || '/' || count(*) filter (where kind = 'refund') || '/' || (sum(amount) filter (where ref_code like 'T-%' and refund_status is distinct from 'initiated'))
     from reconciliation_report((now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date) where ref_code like 'T-%'$q$, '4/5/1200');
select pg_temp.expect_value('recon', 'export has no patient names', $q$select count(*)::text from reconciliation_report(current_date - 1, current_date + 1) r where r::text ilike '%Rules Test%'$q$, '0');
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('recon', 'patients cannot export', $q$select * from reconciliation_report(current_date, current_date)$q$, 'forbidden');
select pg_temp.expect_value('receipt', 'patient can read own receipt data', format($q$select receipt_data((select id from payments where appointment_id = %L)) ->> 'amount'$q$, pg_temp.v('h4')), '600');
select pg_temp.login('00000001-0000-4000-8000-0000000000c8');
set local role authenticated;
select pg_temp.expect_error('receipt', 'other families cannot read the receipt', format($q$select receipt_data((select id from payments where appointment_id = %L))$q$, pg_temp.v('h4')), 'not_found');
reset role;

-- ---------------------------------------------------------------- report
reset role;
\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
