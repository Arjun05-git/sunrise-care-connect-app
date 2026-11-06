-- =============================================================================
-- Timezone (phase 9): the product runs on Asia/Kolkata. Nothing in the database may depend on the SESSION time zone
-- (hosted Supabase = UTC, a developer's machine = whatever it is):
--   1. no function uses a session-zone builtin (current_date, current_time, localtime, localtimestamp, now()::date …)
--   2. ist_today() is the IST calendar date under every session zone
--   3. date-of-birth checks agree with the IST date under zones behind AND ahead of IST
-- Run it, and the other suites, under several zones:  PGTZ=America/Los_Angeles psql … -f supabase/tests/timezone.sql
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/timezone.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
grant all on t_results to authenticated, anon, service_role;
grant usage on sequence t_results_n_seq to authenticated, anon, service_role;
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
create function pg_temp.login(uid text, aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid, true);
$$;

\set anjali '00000001-0000-4000-8000-0000000000c8'
\set pt     '00000005-0000-4000-8000-000000000001'

-- zones: behind IST by up to 17.5 h, UTC (hosted default), IST itself, and 8.5 h ahead
create temp table zones (z text);
insert into zones values ('UTC'), ('America/Los_Angeles'), ('Pacific/Pago_Pago'), ('Etc/GMT+12'), ('Asia/Kolkata'), ('Pacific/Kiritimati');
grant select on zones to authenticated;

-- ---------------------------------------------------------------- 1. no function depends on the session zone
select pg_temp.expect_value('lint', 'no function uses current_date / current_time / localtime / localtimestamp',
  $q$select coalesce(string_agg(p.oid::regprocedure::text, ', '), 'none') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* '\m(current_date|current_time|localtime|localtimestamp)\M'$q$, 'none');
select pg_temp.expect_value('lint', 'no function casts now() to a bare date / time / timestamp',
  $q$select coalesce(string_agg(p.oid::regprocedure::text, ', '), 'none') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* 'now\(\)\s*::\s*(date|time|timestamp)\M'$q$, 'none');

-- ---------------------------------------------------------------- 2. ist_today() is the IST date under every zone
select pg_temp.expect_value('ist_today', 'ist_today() is the IST calendar date when the session zone is ' || z,
  format($q$select (set_config('timezone', %L, true) is not null and ist_today() = (now() at time zone 'Asia/Kolkata')::date)::text$q$, z), 'true')
from zones;

-- ---------------------------------------------------------------- 3. date-of-birth validation agrees with the IST date
select pg_temp.login(:'anjali');
set local role authenticated;
select pg_temp.expect_value('dob', 'a birth date of today (IST) is accepted when the session zone is ' || z,
  format($q$select (set_config('timezone', %L, true) is not null and save_patient(%L, 'Anjali Menon', (now() at time zone 'Asia/Kolkata')::date, 'female') = %L)::text$q$, z, :'pt', :'pt'), 'true')
from zones;
select pg_temp.expect_error('dob', 'a birth date of tomorrow (IST) is refused when the session zone is ' || z,
  format($q$select set_config('timezone', %L, true), save_patient(%L, 'Anjali Menon', (now() at time zone 'Asia/Kolkata')::date + 1, 'female')$q$, z, :'pt'), 'invalid_dob')
from zones;
select pg_temp.expect_value('dob', '120 years ago to the day is still accepted (session zone Pacific/Pago_Pago)',
  format($q$select (set_config('timezone', 'Pacific/Pago_Pago', true) is not null and save_patient(%L, 'Anjali Menon', ((now() at time zone 'Asia/Kolkata')::date - interval '120 years')::date, 'female') = %L)::text$q$, :'pt', :'pt'), 'true');
select pg_temp.expect_error('dob', 'one day older than 120 years is refused (session zone Pacific/Pago_Pago)',
  format($q$select set_config('timezone', 'Pacific/Pago_Pago', true), save_patient(%L, 'Anjali Menon', ((now() at time zone 'Asia/Kolkata')::date - interval '120 years' - interval '1 day')::date, 'female')$q$, :'pt'), 'invalid_dob');
reset role;

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
