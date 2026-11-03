-- =============================================================================
-- Patient booking flow tests: consent, directory, consult-type decision, 10-minute slot hold,
-- competing holds, release, expiry, free follow-up confirmation. Same harness and rules as
-- rls_matrix.sql (persona impersonation, one transaction, rolled back).
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/booking_flow.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
grant all on t_results to authenticated, anon;
grant usage on sequence t_results_n_seq to authenticated, anon;
create temp table t_vars (k text primary key, v text);
grant all on t_vars to authenticated;

create function pg_temp.expect(persona text, name text, q text, expected text) returns void language plpgsql as $$
declare c bigint; op text := left(expected, 1); v bigint := substr(expected, 2)::bigint; ok boolean;
begin
  execute format('select count(*) from (%s) x', q) into c;
  ok := case op when '=' then c = v when '>' then c > v when '<' then c < v end;
  insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, expected, c::text, ok);
end $$;

create function pg_temp.expect_error(persona text, name text, q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
    insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, 'error: ' || needle, 'succeeded', false);
  exception when others then
    insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, 'error: ' || needle, left(sqlerrm, 60), sqlerrm ilike '%' || needle || '%');
  end;
end $$;

create function pg_temp.expect_value(persona text, name text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  execute q into v;
  insert into t_results (persona, check_name, expected, actual, ok) values (persona, name, expected, coalesce(v, 'null'), v is not distinct from expected);
end $$;

create function pg_temp.login(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal1')::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;

\set anjali     '00000001-0000-4000-8000-0000000000c8'
\set rajan      '00000001-0000-4000-8000-0000000000c9'
\set anjali_pt  '00000005-0000-4000-8000-000000000001'
\set rajan_pt   '00000005-0000-4000-8000-000000000002'
\set arun_doc   '00000004-0000-4000-8000-000000000001'
\set doc2       '00000004-0000-4000-8000-000000000002'

-- a bookable slot with Arun (Anjali has no paid consult with him → first consult, paid)
select id as paid_slot from slots where doctor_id = :'arun_doc' and status = 'open' and start_at > now() + interval '1 day' order by start_at limit 1 \gset
-- a slot with doctor 2, where Anjali completed a paid consult 5 days ago → free follow-up
select id as free_slot from slots where doctor_id = :'doc2' and status = 'open' and start_at > now() + interval '1 day' order by start_at limit 1 \gset
-- a slot with Arun beyond the 14-day window is not needed: window logic is checked via preview reason
select id as other_slot from slots where doctor_id = :'arun_doc' and status = 'open' and start_at > now() + interval '2 days' order by start_at limit 1 \gset

-- ================================================================ directory & preview (Anjali)
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect('directory', 'search_doctors lists the 9 verified doctors', 'select * from search_doctors()', '=9');
select pg_temp.expect('directory', 'filter by name', $q$select * from search_doctors(p_q => 'Arun')$q$, '=1');
select pg_temp.expect('directory', 'filter by language (Malayalam)', $q$select * from search_doctors(p_language => 'Malayalam')$q$, '>0');
select pg_temp.expect('directory', 'every listed doctor has a next slot and a fee', 'select * from search_doctors() where next_slot is null or fee_from is null', '=0');
select pg_temp.expect('directory', 'doctor_fees returns one row per mode', format('select * from doctor_fees(%L)', :'arun_doc'), '>0');
select pg_temp.expect_value('preview', 'no prior consult with Arun → first, paid',
  format($q$select (booking_preview(%L, %L, %L, 'video') ->> 'reason')$q$, :'arun_doc', :'anjali_pt', :'paid_slot'), 'no_prior_consult');
select pg_temp.expect_value('preview', 'paid consult 5 days ago, same doctor → free follow-up',
  format($q$select (booking_preview(%L, %L, %L, 'video') ->> 'is_free')$q$, :'doc2', :'anjali_pt', :'free_slot'), 'true');
select pg_temp.expect_value('preview', 'free follow-up fee is 0',
  format($q$select (booking_preview(%L, %L, %L, 'video') ->> 'fee')$q$, :'doc2', :'anjali_pt', :'free_slot'), '0');
select pg_temp.expect_value('preview', 'hold length comes from app_settings (10 min)',
  format($q$select (booking_preview(%L, %L, %L, 'video') ->> 'hold_minutes')$q$, :'arun_doc', :'anjali_pt', :'paid_slot'), '10');
select pg_temp.expect_error('preview', 'cannot preview for someone else''s patient',
  format($q$select booking_preview(%L, %L, %L, 'video')$q$, :'arun_doc', :'rajan_pt', :'paid_slot'), 'forbidden');
select pg_temp.expect('follow-up', 'home shortcut lists the free follow-up', 'select * from my_free_follow_ups()', '>0');

-- ================================================================ privileged functions are not callable
select pg_temp.expect_error('guard', 'patient cannot run expire_holds directly', 'select expire_holds()', 'permission denied');
select pg_temp.expect_error('guard', 'patient cannot generate slots', format('select generate_slots(%L, current_date, 1)', :'arun_doc'), 'permission denied');
select pg_temp.expect_error('guard', 'patient cannot insert an appointment directly',
  format($q$insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
            select 'SC-HACK01', %L, %L, doctor_id, (select hospital_id from doctors where id = doctor_id), (select department_id from doctors where id = doctor_id), id, start_at, end_at, 'video', 'first', 0, 'confirmed' from slots where id = %L$q$,
         :'anjali_pt', :'anjali', :'paid_slot'), 'row-level security');
select pg_temp.expect_error('guard', 'cannot hold a slot for someone else''s patient',
  format($q$select hold_slot(%L, %L, %L, 'video', '{}')$q$, :'arun_doc', :'rajan_pt', :'paid_slot'), 'forbidden');

-- ================================================================ consent gate
select set_consents(array['teleconsultation']::consent_type[], false);
select pg_temp.expect_error('consent', 'withdrawn teleconsultation consent blocks booking',
  format($q$select hold_slot(%L, %L, %L, 'video', '{}')$q$, :'arun_doc', :'anjali_pt', :'paid_slot'), 'consent_required');
select set_consents(array['teleconsultation']::consent_type[], true);
select pg_temp.expect('consent', 're-granting creates a new consent row (history kept)',
  $q$select 1 from consents where user_id = auth.uid() and consent_type = 'teleconsultation'$q$, '=2');

-- ================================================================ hold (paid)
insert into t_vars select 'paid_appt', (hold_slot(:'arun_doc', :'anjali_pt', :'paid_slot', 'video',
  '{"body_area":"Head","symptoms":["Headache","Fever"],"duration":"2-3 days","severity":6,"description":"x","vitals":{"temp_c":38.2}}')).id;
select pg_temp.expect('hold', 'appointment is pending_payment with a ~10-minute expiry',
  $q$select 1 from appointments where id = (select v::uuid from t_vars where k = 'paid_appt') and status = 'pending_payment'
      and hold_expires_at between now() + interval '9 min 59 s' and now() + interval '10 min 1 s'$q$, '=1');
select pg_temp.expect_value('hold', 'get_hold reports ~600 seconds left (server clock)',
  $q$select (get_hold((select v::uuid from t_vars where k = 'paid_appt')) ->> 'seconds_left')::int between 598 and 600$q$, 'true');
select pg_temp.expect('hold', 'symptoms saved with the hold',
  $q$select 1 from appointment_symptoms where appointment_id = (select v::uuid from t_vars where k = 'paid_appt') and severity = 6 and symptoms = '{Headache,Fever}'$q$, '=1');
select pg_temp.expect_error('hold', 'paid booking cannot be confirmed without payment',
  $q$select confirm_free_booking((select v::uuid from t_vars where k = 'paid_appt'))$q$, 'payment_required');
reset role;
select pg_temp.expect('hold', 'slot is marked held until the same expiry',
  format($q$select 1 from slots s join appointments a on a.id = s.appointment_id where s.id = %L and s.status = 'held' and s.held_until = a.hold_expires_at$q$, :'paid_slot'), '=1');

-- ================================================================ competing hold (Rajan, same slot)
select pg_temp.login(:'rajan');
set local role authenticated;
select pg_temp.expect_error('race', 'second patient trying the held slot gets slot_taken',
  format($q$select hold_slot(%L, %L, %L, 'video', '{}')$q$, :'arun_doc', :'rajan_pt', :'paid_slot'), 'slot_taken');
select pg_temp.expect_value('race', 'preview shows the held slot as not bookable',
  format($q$select (booking_preview(%L, %L, %L, 'video') ->> 'bookable')$q$, :'arun_doc', :'rajan_pt', :'paid_slot'), 'false');
select pg_temp.expect_value('race', 'release_hold on someone else''s hold is a no-op',
  $q$select 'no error' from (select release_hold((select v::uuid from t_vars where k = 'paid_appt'))) x$q$, 'no error');
reset role;
select pg_temp.expect_value('race', '…and the hold is still there',
  $q$select status::text from appointments where id = (select v::uuid from t_vars where k = 'paid_appt')$q$, 'pending_payment');

-- ================================================================ one hold per account: a new hold releases the previous one
select pg_temp.login(:'anjali');
set local role authenticated;
insert into t_vars select 'second_appt', (hold_slot(:'arun_doc', :'anjali_pt', :'other_slot', 'video', '{}')).id;
reset role;
select pg_temp.expect_value('one-hold', 'previous hold cancelled as payment_expired',
  $q$select outcome::text from appointments where id = (select v::uuid from t_vars where k = 'paid_appt')$q$, 'payment_expired');
select pg_temp.expect_value('one-hold', 'previous slot is open again',
  format('select status::text from slots where id = %L', :'paid_slot'), 'open');

-- ================================================================ explicit release
select pg_temp.login(:'anjali');
set local role authenticated;
select release_hold((select v::uuid from t_vars where k = 'second_appt'));
select release_hold((select v::uuid from t_vars where k = 'second_appt'));   -- idempotent
reset role;
select pg_temp.expect_value('release', 'release frees the slot (open, no hold, no appointment)',
  format('select status::text || coalesce(held_until::text, '''') || coalesce(appointment_id::text, '''') from slots where id = %L', :'other_slot'), 'open');
select pg_temp.expect_value('release', 'released appointment is cancelled',
  $q$select status::text from appointments where id = (select v::uuid from t_vars where k = 'second_appt')$q$, 'cancelled');

-- ================================================================ expiry (server side)
select pg_temp.login(:'rajan');
set local role authenticated;
insert into t_vars select 'rajan_appt', (hold_slot(:'arun_doc', :'rajan_pt', :'paid_slot', 'video', '{}')).id;   -- the freed slot is bookable again
reset role;
update appointments set hold_expires_at = now() - interval '1 second' where id = (select v::uuid from t_vars where k = 'rajan_appt');
select pg_temp.expect_value('expiry', 'expire_holds() releases lapsed holds', 'select expire_holds()::text', '1');
select pg_temp.expect_value('expiry', 'expired slot is open again', format('select status::text from slots where id = %L', :'paid_slot'), 'open');
select pg_temp.expect('audit', 'hold expiry is audited with a reason',
  $q$select 1 from audit_logs where action = 'appointments.update' and reason = 'Slot hold expired'$q$, '>0');
-- lapsed-but-not-yet-swept holds are bookable too (lazy expiry)
update slots set status = 'held', held_until = now() - interval '1 minute' where id = :'paid_slot';
select pg_temp.expect_value('expiry', 'a held slot whose hold lapsed counts as bookable', format('select slot_bookable(s)::text from slots s where id = %L', :'paid_slot'), 'true');
update slots set status = 'open', held_until = null where id = :'paid_slot';

-- ================================================================ confirmation of an expired hold
select pg_temp.login(:'anjali');
set local role authenticated;
insert into t_vars select 'free_appt', (hold_slot(:'doc2', :'anjali_pt', :'free_slot', 'video', '{}')).id;
reset role;
update appointments set hold_expires_at = now() - interval '1 second' where id = (select v::uuid from t_vars where k = 'free_appt');
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_error('expiry', 'confirming after the 10 minutes → hold_expired',
  $q$select confirm_free_booking((select v::uuid from t_vars where k = 'free_appt'))$q$, 'hold_expired');
reset role;
update appointments set hold_expires_at = now() + interval '5 min' where id = (select v::uuid from t_vars where k = 'free_appt');

-- ================================================================ free follow-up confirmation
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_value('free', 'free follow-up hold carries fee 0 and is_free',
  $q$select fee_amount || '/' || is_free || '/' || consult_type from appointments where id = (select v::uuid from t_vars where k = 'free_appt')$q$, '0/true/follow_up');
select pg_temp.expect_value('free', 'confirm_free_booking confirms it',
  $q$select (confirm_free_booking((select v::uuid from t_vars where k = 'free_appt'))).status::text$q$, 'confirmed');
select pg_temp.expect('free', 'the one free follow-up is now used', 'select * from my_free_follow_ups() where doctor_id = ''00000004-0000-4000-8000-000000000002''', '=0');
select pg_temp.expect('free', 'in-app confirmation without clinical details',
  $q$select 1 from notifications where user_id = auth.uid() and template_key = 'booking_confirmed' and rendered_text not ilike '%head%'$q$, '>0');
reset role;
select pg_temp.expect_value('free', 'slot is booked', format('select status::text from slots where id = %L', :'free_slot'), 'booked');


-- ================================================================ family members (Anjali)
select pg_temp.login(:'anjali');
set local role authenticated;
insert into t_vars select 'kid', save_patient(null, 'Test Child', current_date - 3000, 'female', 'child', 'O+', '{Peanuts}');
select pg_temp.expect('family', 'add family member → patient + dependent link', 'select 1 from patients p join dependents d on d.patient_id = p.id where p.full_name = ''Test Child''', '=1');
select pg_temp.expect('family', 'family now has 4 members', 'select 1 from patients', '=4');
select save_patient((select v::uuid from t_vars where k = 'kid'), 'Test Child Renamed', current_date - 3000, 'female', 'child');
select pg_temp.expect('family', 'edit family member', 'select 1 from patients where full_name = ''Test Child Renamed''', '=1');
select pg_temp.expect_error('family', 'relation required for a dependent', $q$select save_patient(null, 'No Relation', '2000-01-01', 'male')$q$, 'relation_required');
select pg_temp.expect_error('family', 'future date of birth rejected', $q$select save_patient(null, 'Future Kid', current_date + 1, 'male', 'child')$q$, 'invalid_dob');
select pg_temp.expect_error('family', 'cannot edit another family''s patient', format($q$select save_patient(%L, 'Hijack', '2000-01-01', 'male')$q$, :'rajan_pt'), 'forbidden');
select pg_temp.expect_error('family', 'cannot remove yourself', format('select archive_patient(%L)', :'anjali_pt'), 'cannot_archive_self');
select archive_patient((select v::uuid from t_vars where k = 'kid'));
select pg_temp.expect('family', 'removed member is archived (hidden, record kept)', 'select 1 from patients', '=3');
reset role;
select pg_temp.expect('family', '…but the row still exists', 'select 1 from patients where full_name = ''Test Child Renamed'' and archived_at is not null', '=1');
reset role;
set local role anon;
select pg_temp.expect_error('anon', 'anon cannot call booking RPCs', 'select * from search_doctors()', 'permission denied');
reset role;

-- ---------------------------------------------------------------- report
reset role;
\o
select persona, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
