-- =============================================================================
-- A PRODUCTION-SHAPED database: migrations + supabase/seed/reference.sql only, app.environment NOT set.
-- Proves the reference seed brings master data and safe defaults, and nothing about people or credentials.
--     psql "$PROD_SHAPED_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/seed_reference_only.sql
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off
\o /dev/null
begin;

create temp table t_results (n serial, persona text, check_name text, expected text, actual text, ok boolean);
create function pg_temp.expect_value(area text, name text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v; exception when others then v := 'error: ' || sqlerrm; end;
  insert into t_results (persona, check_name, expected, actual, ok) values (area, name, expected, coalesce(v, 'null'), v is not distinct from expected);
end $$;

-- ---------------------------------------------------------------- the database is production
select pg_temp.expect_value('env', 'an unconfigured database is production', $q$select app_env()$q$, 'production');
select pg_temp.expect_value('env', 'staff MFA is mandatory', $q$select mfa_required()::text$q$, 'true');

-- ---------------------------------------------------------------- no people, no credentials
select pg_temp.expect_value('people', 'no login accounts', $q$select count(*)::text from auth.users$q$, '0');
select pg_temp.expect_value('people', 'no profiles', $q$select count(*)::text from profiles$q$, '0');
select pg_temp.expect_value('people', 'no role assignments (nobody is admin)', $q$select count(*)::text from user_roles$q$, '0');
select pg_temp.expect_value('people', 'no doctors, patients or doctor PINs', $q$select (select count(*) from doctors) || '/' || (select count(*) from patients) || '/' || (select count(*) from doctor_secrets)$q$, '0/0/0');
select pg_temp.expect_value('people', 'no appointments, slots, payments', $q$select (select count(*) from appointments) || '/' || (select count(*) from slots) || '/' || (select count(*) from payments)$q$, '0/0/0');
select pg_temp.expect_value('people', 'no hospitals or departments (the hospital sets those up)', $q$select (select count(*) from hospitals) || '/' || (select count(*) from departments)$q$, '0/0');

-- ---------------------------------------------------------------- master data is there
select pg_temp.expect_value('master', 'medicines and rules', $q$select (select count(*) > 100 from drug_master) || '/' || (select count(*) > 0 from drug_rules)$q$, 'true/true');
select pg_temp.expect_value('master', 'ICD-10 codes', $q$select (count(*) > 200)::text from icd10_master$q$, 'true');
select pg_temp.expect_value('master', 'note templates are system-wide', $q$select (count(*) > 0)::text || '/' || (count(*) filter (where doctor_id is not null)) from note_templates$q$, 'true/0');
select pg_temp.expect_value('master', 'notification templates', $q$select (count(*) > 10)::text from notification_templates$q$, 'true');
select pg_temp.expect_value('master', 'consent and legal texts', $q$select (count(*) > 0)::text from content_versions$q$, 'true');
select pg_temp.expect_value('master', 'follow-up policy row', $q$select count(*)::text from follow_up_policy$q$, '1');

-- ---------------------------------------------------------------- settings: safe defaults only
select pg_temp.expect_value('settings', 'no demo overrides (public_url, step-up off, MFA off)', $q$select count(*)::text from app_settings where key in ('public_url', 'require_doctor_step_up', 'staff_mfa_required')$q$, '0');
select pg_temp.expect_value('settings', 'HIS / LeadSquared integrations start off', $q$select (value ->> 'his') || '/' || (value ->> 'leadsquared') from app_settings where key = 'integrations'$q$, 'false/false');
select pg_temp.expect_value('settings', 'recording stays off', $q$select value::text from app_settings where key = 'recording_enabled'$q$, 'false');
select pg_temp.expect_value('settings', 'ABHA stays off', $q$select value::text from app_settings where key = 'abdm_enabled'$q$, 'false');

\o
select persona as area, check_name as "check", expected, actual, case when ok then '✓ PASS' else '✗ FAIL' end as result from t_results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_results \gset
\echo
\echo :passed passed, :failed failed
select case when :failed > 0 then 1/0 end as "fail_if_any";
rollback;
