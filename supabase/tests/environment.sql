-- =============================================================================
-- Deployment environment + staff MFA (phase 2). The database knows what it IS:
--   app.environment = 'demo'  → MFA is optional unless app_settings.staff_mfa_required = true
--   anything else / unset     → production: MFA is ALWAYS required, whatever app_settings says
-- The environment is set by an operator (ALTER DATABASE … SET app.environment = 'demo'), never by an app user.
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/environment.sql
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
-- the operator-level switch, per test step
create function pg_temp.env(e text) returns void language sql as $$ select set_config('app.environment', e, true) $$;
create function pg_temp.mfa_setting(v text) returns void language sql as $$
  insert into app_settings (key, value) values ('staff_mfa_required', v::jsonb) on conflict (key) do update set value = excluded.value
$$;

\set admin '00000001-0000-4000-8000-000000000001'

-- ---------------------------------------------------------------- which environment is this?
select pg_temp.env('demo');
select pg_temp.expect_value('env', 'demo database reports demo', $q$select app_env()$q$, 'demo');
select pg_temp.env('production');
select pg_temp.expect_value('env', 'production database reports production', $q$select app_env()$q$, 'production');
select pg_temp.env('');
select pg_temp.expect_value('env', 'unset (empty) means production', $q$select app_env()$q$, 'production');
select pg_temp.env('staging');
select pg_temp.expect_value('env', 'an unknown name means production, never demo', $q$select app_env()$q$, 'production');
select pg_temp.env('DEMO ');
select pg_temp.expect_value('env', 'only the exact word demo is demo', $q$select app_env()$q$, 'production');

-- ---------------------------------------------------------------- production: MFA cannot be switched off
select pg_temp.env('production');
select pg_temp.mfa_setting('false');                         -- the old loophole: an admin (or a bad seed) turns MFA off
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('production', 'setting=false does NOT disable MFA: password-only admin is refused', $q$select admin_dashboard()$q$, 'forbidden');
select pg_temp.expect_value('production', '… and reads no audit log', $q$select count(*)::text from audit_logs$q$, '0');
reset role;
delete from app_settings where key = 'staff_mfa_required';
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('production', 'setting missing: password-only admin is refused', $q$select admin_dashboard()$q$, 'forbidden');
reset role;
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_value('production', 'with the TOTP code (aal2) the console works', $q$select (admin_dashboard() is not null)::text$q$, 'true');
reset role;

-- ---------------------------------------------------------------- demo: explicit, and still testable
select pg_temp.env('demo');
select pg_temp.mfa_setting('false');
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_value('demo', 'demo + setting false: password-only staff may use the console', $q$select (admin_dashboard() is not null)::text$q$, 'true');
reset role;
delete from app_settings where key = 'staff_mfa_required';
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_value('demo', 'demo + setting missing: MFA optional', $q$select (admin_dashboard() is not null)::text$q$, 'true');
reset role;
select pg_temp.mfa_setting('true');
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('demo', 'demo + setting true: MFA can be switched ON for testing', $q$select admin_dashboard()$q$, 'forbidden');
reset role;
select pg_temp.mfa_setting('false');
insert into auth.mfa_factors (id, user_id, status) values (gen_random_uuid(), :'admin', 'verified');
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_error('demo', 'demo: a staff member who enrolled must still use the code', $q$select admin_dashboard()$q$, 'forbidden');
reset role;
delete from auth.mfa_factors where user_id = :'admin';

-- ---------------------------------------------------------------- auth_policy(): what the sign-in screen asks
select pg_temp.env('production');
select pg_temp.mfa_setting('false');
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_value('policy', 'production: environment + MFA required, regardless of the setting', $q$select (auth_policy() ->> 'environment') || '/' || (auth_policy() ->> 'staff_mfa_required')$q$, 'production/true');
reset role;
select pg_temp.env('demo');
select pg_temp.login(:'admin', 'aal1');
set local role authenticated;
select pg_temp.expect_value('policy', 'demo + setting false: not required', $q$select (auth_policy() ->> 'environment') || '/' || (auth_policy() ->> 'staff_mfa_required')$q$, 'demo/false');
reset role;
select pg_temp.mfa_setting('true');
set local role authenticated;
select pg_temp.expect_value('policy', 'demo + setting true: required', $q$select (auth_policy() ->> 'environment') || '/' || (auth_policy() ->> 'staff_mfa_required')$q$, 'demo/true');
reset role;
set local role anon;
select pg_temp.expect_error('policy', 'anonymous callers cannot read the policy', $q$select auth_policy()$q$, 'permission denied');
reset role;

-- ---------------------------------------------------------------- the environment helpers are internal
select pg_temp.login(:'admin', 'aal2');
set local role authenticated;
select pg_temp.expect_error('internals', 'signed-in users cannot call mfa_required() directly', $q$select mfa_required()$q$, 'permission denied');
reset role;

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
