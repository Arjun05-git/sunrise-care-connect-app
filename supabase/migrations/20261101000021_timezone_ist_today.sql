-- =============================================================================
-- Timezone (hardening phase 9): the product runs on Asia/Kolkata, so nothing may depend on the database SESSION zone
-- (hosted Supabase = UTC, local machines = whatever they are).
--
-- save_patient() validated the date of birth against current_date, which is the date in the SESSION zone. On hosted
-- Supabase (UTC), between 00:00 and 05:30 IST the UTC date is still "yesterday", so a baby registered with today's
-- (IST) birth date was refused as "in the future"; under a zone behind UTC the same check also let a too-old date through.
-- It now uses ist_today(), the IST calendar date. save_patient() is otherwise unchanged (taken from the live definition).
--
-- supabase/tests/timezone.sql keeps it that way: no function may use current_date / current_time / localtime /
-- localtimestamp or cast now() to a bare date, and the date-of-birth rules are checked under zones behind and ahead of IST.
-- =============================================================================

/** The calendar date in India right now, whatever the session time zone is. */
create or replace function public.ist_today()
returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- internal helper: called by the SECURITY DEFINER functions (which run as the owner), not by clients
revoke execute on function public.ist_today() from public, anon, authenticated;
grant execute on function public.ist_today() to service_role;

CREATE OR REPLACE FUNCTION public.save_patient(p_id uuid, p_full_name text, p_date_of_birth date, p_gender text, p_relation text DEFAULT NULL::text, p_blood_group text DEFAULT NULL::text, p_allergies text[] DEFAULT '{}'::text[], p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_address text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

declare primary_id uuid; new_id uuid;

begin

  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  if length(trim(coalesce(p_full_name, ''))) < 2 or length(p_full_name) > 80 then raise exception 'invalid_name'; end if;

  if p_date_of_birth is null or p_date_of_birth > public.ist_today() or p_date_of_birth < public.ist_today() - interval '120 years' then raise exception 'invalid_dob'; end if;

  if coalesce(p_phone, '') <> '' and p_phone !~ '^\+91[6-9][0-9]{9}$' then raise exception 'invalid_phone'; end if;

  if p_blood_group is not null and p_blood_group not in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') then raise exception 'invalid_blood_group'; end if;

  select id into primary_id from patients where owner_user_id = auth.uid() and is_primary and archived_at is null;



  if p_id is not null then

    if p_id not in (select public.my_patient_ids()) then raise exception 'forbidden' using errcode = '42501'; end if;

    update patients set full_name = trim(p_full_name), date_of_birth = p_date_of_birth, gender = p_gender, blood_group = p_blood_group,

           allergies = coalesce(p_allergies, '{}'), phone = coalesce(p_phone, ''), email = nullif(p_email, ''), address = coalesce(p_address, '')

     where id = p_id;

    if p_relation is not null and p_id <> primary_id then update dependents set relation = p_relation where patient_id = p_id; end if;

    if p_id = primary_id then update profiles set full_name = trim(p_full_name), email = coalesce(nullif(p_email, ''), email) where id = auth.uid(); end if;

    return p_id;

  end if;



  if primary_id is null then   -- first record = the account holder

    insert into patients (owner_user_id, full_name, date_of_birth, gender, phone, email, address, blood_group, allergies, is_primary)

    values (auth.uid(), trim(p_full_name), p_date_of_birth, p_gender,

            coalesce(nullif(p_phone, ''), (select phone from profiles where id = auth.uid()), ''), nullif(p_email, ''), coalesce(p_address, ''), p_blood_group, coalesce(p_allergies, '{}'), true)

    returning id into new_id;

    update profiles set full_name = trim(p_full_name) where id = auth.uid();

    return new_id;

  end if;



  if p_relation is null then raise exception 'relation_required'; end if;

  if (select count(*) from patients where owner_user_id = auth.uid() and archived_at is null) >= 10 then raise exception 'family_limit'; end if;

  insert into patients (owner_user_id, full_name, date_of_birth, gender, phone, email, address, blood_group, allergies, is_primary)

  values (auth.uid(), trim(p_full_name), p_date_of_birth, p_gender, coalesce(p_phone, ''), nullif(p_email, ''), coalesce(p_address, ''), p_blood_group, coalesce(p_allergies, '{}'), false)

  returning id into new_id;

  insert into dependents (owner_patient_id, patient_id, relation) values (primary_id, new_id, p_relation);

  return new_id;

end $function$;
