-- =============================================================================
-- Deployment environment + mandatory staff MFA (hardening phase 2).
--
-- Until now "is MFA required?" was a row in app_settings, which an admin could edit (and which the demo seed
-- sets to false), so staff MFA was only as strong as the data in the table. The database now knows what it IS:
--
--   app.environment = 'demo'     explicit, set by an operator:  ALTER DATABASE <db> SET app.environment = 'demo';
--   anything else / not set      production
--
--   production : staff MFA (aal2) is ALWAYS required. app_settings.staff_mfa_required is ignored.
--   demo       : MFA is optional, unless app_settings.staff_mfa_required = true (so MFA can still be tried out)
--                or the staff member has enrolled a factor (then the code is mandatory, as before).
--
-- Only the exact word 'demo' selects demo. A typo, an empty value or a missing setting means production.
-- App users cannot change the environment: it is a database/role-level setting, not a table row.
-- =============================================================================

/** 'demo' only when app.environment is exactly 'demo'; everything else is production (fails closed). */
create or replace function public.app_env()
returns text language sql stable security definer set search_path = public as $$
  select case when coalesce(current_setting('app.environment', true), '') = 'demo' then 'demo' else 'production' end;
$$;

/** Is a second factor (aal2) mandatory for staff right now? Production: always. Demo: only if switched on. */
create or replace function public.mfa_required()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_env() <> 'demo' or coalesce((public.setting('staff_mfa_required'))::boolean, false);
$$;

create or replace function public.staff_ok(variadic roles app_role[])
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = any(roles))
     and (
       coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
       or (
         -- no second factor yet: only where MFA is not mandatory (demo), and never for someone who enrolled one
         not public.mfa_required()
         and not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
       )
     );
$$;

/** What the sign-in screen needs to know (signed-in users only): the environment and whether MFA is required. */
create or replace function public.auth_policy()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('environment', public.app_env(), 'staff_mfa_required', public.mfa_required());
$$;

-- privileges: internal helpers are callable by the database owner and the service role only
revoke execute on function public.app_env(), public.mfa_required(), public.auth_policy() from public, anon, authenticated;
grant execute on function public.app_env(), public.mfa_required() to service_role;
grant execute on function public.auth_policy() to authenticated, service_role;
