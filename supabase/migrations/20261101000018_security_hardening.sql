-- =============================================================================
-- Security hardening after the ASVS / MASVS review (docs/SECURITY.md).
--   1. Direct table writes closed where a SECURITY DEFINER RPC owns the rules (patients, profiles, consents,
--      consultations, notifications, documents). RLS alone allowed any column to be changed.
--   2. Documents: registration only through the documents-register edge function (server-side type check);
--      files of a started / finished consultation can't be detached or deleted; doctors and admins read only
--      registered files.
--   3. Function privileges: nothing callable by anon except public_content; internal helpers (write_audit,
--      setting) no longer callable by signed-in users; new functions are not executable by PUBLIC by default.
--   4. Staff MFA: staff_ok() needs aal2 unless app_settings.staff_mfa_required is false (missing = required).
--   5. The HIS doctor-master summary is admin-only.
-- =============================================================================

-- ---------------------------------------------------------------- 1. RPC-only tables
-- patients: save_patient / archive_patient / link_abha / unlink_abha. Directly, a patient could set his_mrn
-- (another person's hospital record) or mark an unverified ABHA as verified.
revoke insert, update, delete on patients from authenticated;
-- profiles: save_patient keeps the name; phone / email come from auth. Directly, a user could put someone
-- else's number on their profile (messages go there) or squat a number so its owner can't sign up.
revoke insert, update, delete on profiles from authenticated;
-- consents: set_consents only (grant / withdraw); directly, versions and dates could be rewritten.
revoke insert, update, delete on consents from authenticated;
-- notifications: mark_notifications_read / resolve_notification_link only.
revoke insert, update, delete on notifications from authenticated;
-- consultations: save_consult_notes / finalize_prescription only. The "for all" policy let a doctor write a
-- FINAL note for any patient, outside their appointments and without signing.
drop policy if exists consultations_doctor on consultations;
create policy consultations_doctor on consultations for select using (doctor_id = public.my_doctor_id());
revoke insert, update, delete on consultations from authenticated;

-- ---------------------------------------------------------------- 2. documents
-- insert: documents-register (service role) after checking the path, owner and the file's real type;
-- update: hold_slot / send_chat_message attach files to a consultation (definer); clients never update.
revoke insert, update on documents from authenticated;
drop policy if exists documents_insert on documents;
drop policy if exists documents_attach on documents;

drop policy if exists "docs read" on storage.objects;
create policy "docs read" on storage.objects for select using (
  bucket_id = 'medical-documents' and (
    public.storage_patient_id(name) in (select public.my_patient_ids())
    -- doctors and admins only see files that went through registration (type-checked), never raw uploads
    or ((public.doctor_sees_patient(public.storage_patient_id(name)) or public.staff_ok('admin'))
        and exists (select 1 from public.documents d where d.storage_path = storage.objects.name))
  )
);
drop policy if exists "docs delete" on storage.objects;
create policy "docs delete" on storage.objects for delete using (
  bucket_id = 'medical-documents'
  and public.storage_patient_id(name) in (select public.my_patient_ids())
  -- a file still registered to a consultation that has started or finished stays (clinical record)
  and not exists (select 1 from public.documents d join public.appointments a on a.id = d.appointment_id
                  where d.storage_path = storage.objects.name and a.status not in ('pending_payment', 'confirmed', 'cancelled'))
);

/** Service (documents-register): the row for a file the function has already type-checked. */
create or replace function public.register_document(p_id uuid, p_patient uuid, p_user uuid, p_tag text, p_file_name text,
                                                    p_mime text, p_size int, p_path text)
returns documents language plpgsql security definer set search_path = public as $$
declare d documents; ext text := case p_mime when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' end;
begin
  if ext is null then raise exception 'type_not_allowed'; end if;
  if p_size <= 0 or p_size > 10485760 then raise exception 'size'; end if;
  if p_path is distinct from format('patients/%s/%s.%s', p_patient, p_id, ext) then raise exception 'invalid_path'; end if;
  -- same rule the old insert policy had: the caller's own family, or a doctor treating the patient
  if not (p_patient in (select id from patients where owner_user_id = p_user and archived_at is null)
          or exists (select 1 from appointments a join doctors dr on dr.id = a.doctor_id
                     where a.patient_id = p_patient and dr.profile_id = p_user)) then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'medical-documents' and o.name = p_path) then raise exception 'file_missing'; end if;
  insert into documents (id, patient_id, uploaded_by, tag, file_name, mime_type, size_bytes, storage_path)
  values (p_id, p_patient, p_user, p_tag, left(coalesce(nullif(trim(p_file_name), ''), 'file.' || ext), 120), p_mime, p_size, p_path)
  returning * into d;
  return d;
end $$;

-- ---------------------------------------------------------------- 3. function privileges
-- Postgres grants EXECUTE to PUBLIC by default (and hosted Supabase also grants new functions to anon), so
-- earlier "revoke … from anon" lines did not stop anon: write_audit could be called by anyone, forging
-- audit entries. Keep exactly what signed-in users could call before, minus internal helpers; anon gets
-- only public_content.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth_ok
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth_ok and f.proname not in ('write_audit', 'setting', 'audit_actor_role') then
      execute format('grant execute on function %s to authenticated', f.sig);
    elsif f.proname in ('write_audit', 'setting', 'audit_actor_role') then
      execute format('revoke execute on function %s from authenticated', f.sig);
    end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
grant execute on function public.public_content(text) to anon, authenticated;
revoke execute on function public.register_document from public, anon, authenticated;
grant execute on function public.register_document to service_role;
-- functions added by later migrations must be granted explicitly
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

-- ---------------------------------------------------------------- 4. staff MFA
create or replace function public.staff_ok(variadic roles app_role[])
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = any(roles))
     and (
       coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
       or (
         -- local / demo stacks set staff_mfa_required = false; a missing setting means required
         not coalesce((public.setting('staff_mfa_required'))::boolean, true)
         and not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
       )
     );
$$;

-- ---------------------------------------------------------------- 5. settings visibility
drop policy if exists settings_read on app_settings;
create policy settings_read on app_settings for select to authenticated using (key <> 'his_doctor_sync' or public.staff_ok('admin'));
