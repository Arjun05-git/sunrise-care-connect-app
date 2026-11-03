-- =============================================================================
-- Admin console (rules confirmed by Sunrise on 2026-10-27):
--  * Doctor onboarding: admin / coordinator create the profile, upload the registration certificate and
--    create the doctor's phone login, then submit. Draft → pending → verified | rejected.
--    TWO-PERSON RULE: only an admin who neither created nor submitted the doctor can verify.
--    Registration details are locked while verified. Suspension (admin) cancels every future booking
--    through the doctor-unavailable path (patient chooses free reschedule or full refund); reinstating
--    sends the doctor back for verification by a second person.
--  * Appointment monitor: cancel (refund full / per patient policy / none – coordinators full only),
--    move to another slot (same doctor, or another doctor in the same department; the booked fee is
--    kept), record a missing outcome, extend the join window. Reason required, audited.
--  * Consent & terms content: versioned; a wording fix keeps the version (revision + 1), a new version
--    makes patients accept required consents again.
--  * Users & roles: admins only, with a reason; nobody changes their own roles; the last admin stays.
--  * Support tickets with a conversation (internal staff notes never reach the user).
--  * Dashboard, audit log search and reports (no patient identity in report rows).
-- =============================================================================

-- ---------------------------------------------------------------- doctors: onboarding & verification
alter table doctors drop constraint if exists doctors_verification_status_check;
alter table doctors add constraint doctors_verification_status_check
  check (verification_status in ('draft', 'pending', 'verified', 'rejected', 'suspended'));
-- a doctor being onboarded has no login yet (submission requires one)
alter table doctors alter column profile_id drop not null;
alter table doctors
  add column onboarded_by uuid references profiles(id),
  add column submitted_by uuid references profiles(id),
  add column submitted_at timestamptz,
  add column verified_by uuid references profiles(id),
  add column verified_at timestamptz,
  add column verification_note text check (length(verification_note) <= 500),
  add column rejection_reason text check (length(rejection_reason) <= 500),
  add column suspended_by uuid references profiles(id),
  add column suspended_at timestamptz,
  add column suspension_reason text check (length(suspension_reason) <= 500);

create table doctor_credentials (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  kind text not null check (kind in ('registration_certificate', 'degree', 'id_proof', 'other')),
  storage_path text not null unique,
  file_name text not null check (length(file_name) <= 200),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes int not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid references profiles(id),
  uploaded_at timestamptz not null default now()
);
create index doctor_credentials_doctor on doctor_credentials (doctor_id);
alter table doctor_credentials enable row level security;
alter table doctor_credentials force row level security;
create policy credentials_staff on doctor_credentials for select using (public.staff_ok('admin', 'coordinator'));

-- direct edits would bypass the verification workflow: everything goes through the RPCs below
drop policy if exists doctors_admin on doctors;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('doctor-credentials', 'doctor-credentials', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
-- doctor-credentials/<doctor_id>/<uuid>.<ext>
create policy "credentials read" on storage.objects for select using (bucket_id = 'doctor-credentials' and public.staff_ok('admin', 'coordinator'));
create policy "credentials upload" on storage.objects for insert with check (
  bucket_id = 'doctor-credentials' and public.staff_ok('admin', 'coordinator')
  and exists (select 1 from doctors d where d.id::text = split_part(name, '/', 1)));

-- ---------------------------------------------------------------- roles: no direct writes (guards live in the RPC)
drop policy if exists user_roles_admin_all on user_roles;
create policy user_roles_select_admin on user_roles for select using (public.staff_ok('admin'));

-- ---------------------------------------------------------------- masters
alter table icd10_master add column if not exists active boolean not null default true;

-- ---------------------------------------------------------------- consent & legal content (versioned)
create table content_versions (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms', 'terms_of_use', 'privacy_notice', 'refund_policy')),
  version text not null check (version ~ '^\d+\.\d+$'),
  revision int not null check (revision >= 1),
  title_en text not null default '' check (length(title_en) <= 120),
  title_ml text not null default '' check (length(title_ml) <= 120),
  body_en text not null check (length(body_en) between 10 and 20000),
  body_ml text not null check (length(body_ml) between 10 and 20000),
  published_by uuid references profiles(id),
  published_at timestamptz not null default now(),
  reason text check (length(reason) <= 200),
  unique (key, version, revision)
);
alter table content_versions enable row level security;
alter table content_versions force row level security;
create policy content_read on content_versions for select to anon, authenticated using (true);   -- published text is public
grant select on content_versions to anon;

-- ---------------------------------------------------------------- support tickets: conversation
alter table support_tickets
  add column ref_code text generated always as ('T-' || upper(substr(replace(id::text, '-', ''), 1, 8))) stored,
  add column first_response_at timestamptz,
  add column resolved_at timestamptz;
create table ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  author_user_id uuid references profiles(id),
  author_kind text not null check (author_kind in ('user', 'staff')),
  body text not null check (length(body) between 1 and 4000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index ticket_messages_ticket on ticket_messages (ticket_id, created_at);
alter table ticket_messages enable row level security;
alter table ticket_messages force row level security;
create policy ticket_messages_own on ticket_messages for select using (
  not internal and exists (select 1 from support_tickets t where t.id = ticket_id and t.user_id = auth.uid()));
create policy ticket_messages_staff on ticket_messages for select using (public.staff_ok('admin', 'coordinator'));
-- tickets change only through the RPCs (status, assignee, replies)
drop policy if exists tickets_update on support_tickets;
drop policy if exists tickets_create on support_tickets;

-- audit the new tables (message bodies may hold personal details → redacted in the log)
do $$
declare r record;
begin
  for r in select * from (values ('doctor_credentials', '{file_name}'::text[]), ('content_versions', '{}'::text[]),
                                 ('ticket_messages', '{body}'::text[]), ('icd10_master', '{}'::text[])) t(tbl, redact) loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', r.tbl);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row_change(%2$s)',
                   r.tbl, (select coalesce(string_agg(quote_literal(c), ','), '') from unnest(r.redact) c));
  end loop;
end $$;

-- ================================================================ helpers
create or replace function public.need_reason(p_reason text)
returns text language plpgsql immutable as $$
begin
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  return left(trim(p_reason), 200);
end $$;

/** For edge functions acting as the caller: is the caller staff in one of these roles (MFA rules included)? */
create or replace function public.am_staff(p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_ok(variadic p_roles::app_role[]);
$$;

create or replace function public.ist_day_start(d date)
returns timestamptz language sql immutable as $$ select (d::timestamp) at time zone 'Asia/Kolkata' $$;

/** Why a booking needs a coordinator's attention (empty = fine). */
create or replace function public.appt_attention(a appointments)
returns text[] language sql stable security definer set search_path = public as $$
  select array_remove(array[
    case when a.status = 'confirmed' and now() > a.start_at + make_interval(mins => coalesce((setting('doctor_grace_minutes'))::int, 10))
              and a.doctor_joined_at is null then 'doctor_not_joined' end,
    case when a.status = 'confirmed' and now() > a.start_at + make_interval(mins => coalesce((setting('patient_grace_minutes'))::int, 10))
              and a.patient_joined_at is null and a.doctor_joined_at is not null then 'patient_not_joined' end,
    case when a.status in ('confirmed', 'in_progress') and now() > a.end_at + interval '30 minutes' then 'outcome_missing' end,
    case when a.status = 'cancelled' and a.outcome in ('cancelled_by_doctor', 'technical_failure', 'doctor_no_show', 'both_no_show')
              and a.rescheduled_to_id is null and not exists (select 1 from refunds f where f.appointment_id = a.id and f.status <> 'failed')
              and exists (select 1 from payments p where p.appointment_id = a.id and p.status = 'captured') then 'awaiting_patient_choice' end,
    case when exists (select 1 from refunds f where f.appointment_id = a.id and f.status = 'failed') then 'refund_failed' end,
    case when exists (select 1 from reschedule_requests r where r.appointment_id = a.id and r.status = 'pending') then 'reschedule_pending' end
  ], null);
$$;

-- ================================================================ doctors
create or replace function public.admin_save_doctor(p_id uuid, p jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare d doctors; why text := public.need_reason(p_reason); nid uuid; v_modes consult_mode[]; v_langs text[];
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p ->> 'full_name', ''))) not between 3 and 120 then raise exception 'invalid_name'; end if;
  if coalesce(p ->> 'phone', '') !~ '^\+91[6-9][0-9]{9}$' then raise exception 'invalid_phone'; end if;
  if length(trim(coalesce(p ->> 'registration_no', ''))) not between 3 and 40 then raise exception 'invalid_registration'; end if;
  if length(trim(coalesce(p ->> 'registration_council', ''))) not between 3 and 120 then raise exception 'invalid_registration'; end if;
  if length(trim(coalesce(p ->> 'qualification', ''))) not between 2 and 200 then raise exception 'invalid_qualification'; end if;
  if not exists (select 1 from hospitals where id = (p ->> 'hospital_id')::uuid and active) then raise exception 'invalid_hospital'; end if;
  if not exists (select 1 from departments where id = (p ->> 'department_id')::uuid and active) then raise exception 'invalid_department'; end if;
  select array_agg(distinct m::consult_mode) into v_modes from jsonb_array_elements_text(coalesce(p -> 'modes', '[]')) m;
  if v_modes is null then raise exception 'invalid_modes'; end if;
  select coalesce(array_agg(distinct left(trim(l), 30)), '{}') into v_langs from jsonb_array_elements_text(coalesce(p -> 'languages', '[]')) l where trim(l) <> '';
  if coalesce((p ->> 'experience_years')::int, 0) not between 0 and 70 then raise exception 'invalid_input'; end if;
  if coalesce((p ->> 'slot_minutes')::int, 15) not between 5 and 60 then raise exception 'invalid_input'; end if;
  if length(coalesce(p ->> 'bio', '')) > 1000 then raise exception 'invalid_input'; end if;
  perform set_config('app.audit_reason', why, true);

  if p_id is null then
    insert into doctors (full_name, phone, qualification, registration_no, registration_council, experience_years, languages, hospital_id, department_id,
                         bio, modes, slot_minutes, his_doctor_code, verification_status, active, onboarded_by)
    values (trim(p ->> 'full_name'), p ->> 'phone', trim(p ->> 'qualification'), upper(trim(p ->> 'registration_no')), trim(p ->> 'registration_council'),
            coalesce((p ->> 'experience_years')::int, 0), v_langs, (p ->> 'hospital_id')::uuid, (p ->> 'department_id')::uuid,
            trim(coalesce(p ->> 'bio', '')), v_modes, coalesce((p ->> 'slot_minutes')::int, 15), nullif(trim(coalesce(p ->> 'his_doctor_code', '')), ''),
            'draft', true, auth.uid())
    returning id into nid;
    return nid;
  end if;

  select * into d from doctors where id = p_id for update;
  if d.id is null then raise exception 'not_found'; end if;
  -- the registration that was checked can't change under a verified doctor (suspend → reinstate → verify again)
  if d.verification_status in ('verified', 'pending')
     and (upper(trim(p ->> 'registration_no')) <> d.registration_no or trim(p ->> 'registration_council') <> d.registration_council) then
    raise exception 'registration_locked';
  end if;
  if d.profile_id is not null and p ->> 'phone' <> d.phone then raise exception 'phone_locked'; end if;   -- it is the doctor's login
  update doctors set full_name = trim(p ->> 'full_name'), phone = p ->> 'phone', qualification = trim(p ->> 'qualification'),
         registration_no = upper(trim(p ->> 'registration_no')), registration_council = trim(p ->> 'registration_council'),
         experience_years = coalesce((p ->> 'experience_years')::int, 0), languages = v_langs,
         hospital_id = (p ->> 'hospital_id')::uuid, department_id = (p ->> 'department_id')::uuid,
         bio = trim(coalesce(p ->> 'bio', '')), modes = v_modes, slot_minutes = coalesce((p ->> 'slot_minutes')::int, 15),
         his_doctor_code = nullif(trim(coalesce(p ->> 'his_doctor_code', '')), '')
   where id = d.id;
  return d.id;
end $$;

/** After the client uploaded the file to doctor-credentials/<doctor_id>/<uuid>.<ext>. */
create or replace function public.admin_add_doctor_credential(p_doctor uuid, p_kind text, p_path text, p_file_name text, p_mime text, p_size int)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from doctors where id = p_doctor) then raise exception 'not_found'; end if;
  if split_part(p_path, '/', 1) <> p_doctor::text or p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|png)$' then raise exception 'invalid_path'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'doctor-credentials' and name = p_path) then raise exception 'file_missing'; end if;
  perform set_config('app.audit_reason', 'Credential uploaded: ' || p_kind, true);
  insert into doctor_credentials (doctor_id, kind, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (p_doctor, p_kind, p_path, left(regexp_replace(coalesce(p_file_name, 'file'), '[^\w.\- ]', '_', 'g'), 200), p_mime, p_size, auth.uid())
  returning id into cid;
  return cid;
end $$;

create or replace function public.admin_submit_doctor(p_doctor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d doctors;
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into d from doctors where id = p_doctor for update;
  if d.id is null then raise exception 'not_found'; end if;
  if d.verification_status not in ('draft', 'rejected') then raise exception 'invalid_state'; end if;
  if d.profile_id is null then raise exception 'login_missing'; end if;
  if not exists (select 1 from doctor_credentials where doctor_id = d.id and kind = 'registration_certificate') then raise exception 'certificate_missing'; end if;
  perform set_config('app.audit_reason', 'Submitted for registration verification', true);
  update doctors set verification_status = 'pending', submitted_by = auth.uid(), submitted_at = now(), rejection_reason = null where id = d.id;
end $$;

create or replace function public.admin_verify_doctor(p_doctor uuid, p_decision text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare d doctors;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'note_required'; end if;
  select * into d from doctors where id = p_doctor for update;
  if d.id is null then raise exception 'not_found'; end if;
  if d.verification_status <> 'pending' then raise exception 'invalid_state'; end if;
  if auth.uid() in (d.onboarded_by, d.submitted_by) then raise exception 'two_person_rule'; end if;
  perform set_config('app.audit_reason', 'Registration ' || p_decision || ': ' || left(trim(p_note), 180), true);
  if p_decision = 'verified' then
    update doctors set verification_status = 'verified', verified_by = auth.uid(), verified_at = now(), verification_note = left(trim(p_note), 500),
           rejection_reason = null, suspended_by = null, suspended_at = null, suspension_reason = null, active = true
     where id = d.id;
    perform public.rebuild_slots(d.id);
  elsif p_decision = 'rejected' then
    update doctors set verification_status = 'rejected', rejection_reason = left(trim(p_note), 500), verified_by = null, verified_at = null where id = d.id;
  else
    raise exception 'invalid_input';
  end if;
end $$;

/** Suspend: no new bookings; every future booking is cancelled for a doctor-side reason (patient chooses). */
create or replace function public.admin_suspend_doctor(p_doctor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d doctors; why text := public.need_reason(p_reason); a appointments; n int := 0; h int := 0;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into d from doctors where id = p_doctor for update;
  if d.id is null then raise exception 'not_found'; end if;
  if d.verification_status not in ('verified', 'pending') then raise exception 'invalid_state'; end if;
  perform set_config('app.audit_reason', 'Doctor suspended: ' || why, true);
  update doctors set verification_status = 'suspended', suspended_by = auth.uid(), suspended_at = now(), suspension_reason = why where id = d.id;
  update reschedule_requests r set status = 'expired', response_note = 'doctor suspended', responded_at = now()
    from appointments x where x.id = r.appointment_id and x.doctor_id = d.id and r.status = 'pending';
  for a in select * from appointments where doctor_id = d.id and status = 'confirmed' and start_at > now() loop
    perform public.cancel_for_doctor_reason(a.id, 'cancelled_by_doctor', 'Doctor unavailable');
    n := n + 1;
  end loop;
  -- unpaid holds simply lapse (a late payment is refunded by capture_payment)
  for a in select * from appointments where doctor_id = d.id and status = 'pending_payment' loop
    update appointments set status = 'cancelled', outcome = 'cancelled_by_doctor', outcome_reason = 'Doctor unavailable', cancelled_at = now() where id = a.id;
    update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id;
    h := h + 1;
  end loop;
  update slots set status = 'blocked' where doctor_id = d.id and start_at > now() and status = 'open' and appointment_id is null;
  return jsonb_build_object('cancelled', n, 'holds_released', h);
end $$;

/** Reinstate → back to pending: a second admin must verify the registration again. */
create or replace function public.admin_reinstate_doctor(p_doctor uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare d doctors; why text := public.need_reason(p_reason);
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into d from doctors where id = p_doctor for update;
  if d.id is null then raise exception 'not_found'; end if;
  if d.verification_status <> 'suspended' then raise exception 'invalid_state'; end if;
  perform set_config('app.audit_reason', 'Reinstatement requested: ' || why, true);
  update doctors set verification_status = 'pending', submitted_by = auth.uid(), submitted_at = now(), verified_by = null, verified_at = null where id = d.id;
end $$;

/** Service (admin-users function): attach a fresh phone login to a doctor record. */
create or replace function public.link_doctor_login(p_doctor uuid, p_user uuid, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d doctors;
begin
  select * into d from doctors where id = p_doctor for update;
  if d.id is null then raise exception 'not_found'; end if;
  if d.profile_id is not null then raise exception 'login_exists'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'not_found'; end if;
  if exists (select 1 from user_roles where user_id = p_user and role <> 'patient')
     or exists (select 1 from patients where owner_user_id = p_user)
     or exists (select 1 from doctors where profile_id = p_user) then raise exception 'phone_in_use'; end if;
  delete from user_roles where user_id = p_user and role = 'patient';
  insert into user_roles (user_id, role) values (p_user, 'doctor');
  update profiles set full_name = d.full_name where id = p_user and full_name = '';
  update doctors set profile_id = p_user where id = d.id;
  insert into audit_logs (actor_user_id, actor_role, action, entity, entity_id, before, after, reason)
  values (p_actor, (select role::text from user_roles where user_id = p_actor and role in ('admin', 'coordinator') order by role desc limit 1),
          'doctors.login_linked', 'doctors', d.id::text, null, jsonb_build_object('profile_id', p_user), 'Doctor login created');
end $$;

-- ================================================================ users & roles
create or replace function public.admin_set_staff_roles(p_user uuid, p_roles app_role[], p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); staff app_role[] := array['admin', 'coordinator', 'finance']::app_role[]; pr profiles;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'own_roles'; end if;
  if not (coalesce(p_roles, '{}') <@ staff) then raise exception 'invalid_input'; end if;
  select * into pr from profiles where id = p_user;
  if pr.id is null then raise exception 'not_found'; end if;
  if cardinality(coalesce(p_roles, '{}')) > 0 then
    if pr.email is null then raise exception 'no_email'; end if;    -- staff sign in with email + password
    if exists (select 1 from doctors where profile_id = p_user) then raise exception 'doctor_account'; end if;
    if exists (select 1 from patients where owner_user_id = p_user) then raise exception 'patient_account'; end if;
  end if;
  if exists (select 1 from user_roles where user_id = p_user and role = 'admin') and not ('admin' = any(coalesce(p_roles, '{}')))
     and not exists (select 1 from user_roles where role = 'admin' and user_id <> p_user) then raise exception 'last_admin'; end if;
  perform set_config('app.audit_reason', why, true);
  delete from user_roles where user_id = p_user and role = any(staff) and not (role = any(coalesce(p_roles, '{}')));
  insert into user_roles (user_id, role) select p_user, r from unnest(coalesce(p_roles, '{}')) r on conflict do nothing;
  if cardinality(coalesce(p_roles, '{}')) > 0 then delete from user_roles where user_id = p_user and role = 'patient'; end if;
end $$;

create or replace function public.admin_users(p_q text default null, p_kind text default 'staff', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, auth as $$
declare q text := nullif(trim(coalesce(p_q, '')), '');
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    with base as (
      select pr.id, pr.full_name, pr.phone, pr.email, pr.created_at, u.last_sign_in_at,
             coalesce((select array_agg(r.role::text order by r.role) from user_roles r where r.user_id = pr.id), '{}') roles
        from profiles pr left join auth.users u on u.id = pr.id
       where (q is null or pr.full_name ilike '%' || q || '%' or pr.phone ilike '%' || q || '%' or pr.email ilike '%' || q || '%')),
    f as (select * from base where case p_kind
            when 'staff' then roles && array['admin', 'coordinator', 'finance']
            when 'doctor' then 'doctor' = any(roles)
            when 'patient' then 'patient' = any(roles)
            when 'none' then cardinality(roles) = 0
            else true end)
    select jsonb_build_object('total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.full_name) from
              (select * from f order by full_name limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) x), '[]')));
end $$;

-- ================================================================ masters
create or replace function public.admin_save_hospital(p_id uuid, p jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); nid uuid; act boolean := coalesce((p ->> 'active')::boolean, true);
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) not between 3 and 120 or length(trim(coalesce(p ->> 'city', ''))) not between 2 and 60 then raise exception 'invalid_input'; end if;
  if coalesce(p ->> 'phone', '') !~ '^\+91[0-9]{10}$' or coalesce(p ->> 'emergency_phone', '') !~ '^(\+91[0-9]{10}|1[0-9]{2})$' then raise exception 'invalid_phone'; end if;
  if not act and p_id is not null and exists (select 1 from doctors where hospital_id = p_id and verification_status in ('verified', 'pending')) then raise exception 'in_use'; end if;
  perform set_config('app.audit_reason', why, true);
  if p_id is null then
    insert into hospitals (name, city, address, phone, emergency_phone, his_code, active)
    values (trim(p ->> 'name'), trim(p ->> 'city'), left(trim(coalesce(p ->> 'address', '')), 300), p ->> 'phone', p ->> 'emergency_phone', nullif(trim(coalesce(p ->> 'his_code', '')), ''), act)
    returning id into nid;
    return nid;
  end if;
  update hospitals set name = trim(p ->> 'name'), city = trim(p ->> 'city'), address = left(trim(coalesce(p ->> 'address', '')), 300), phone = p ->> 'phone',
         emergency_phone = p ->> 'emergency_phone', his_code = nullif(trim(coalesce(p ->> 'his_code', '')), ''), active = act
   where id = p_id;
  if not found then raise exception 'not_found'; end if;
  return p_id;
end $$;

create or replace function public.admin_save_department(p_id uuid, p jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); nid uuid; act boolean := coalesce((p ->> 'active')::boolean, true);
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) not between 2 and 80 or length(trim(coalesce(p ->> 'name_ml', ''))) not between 2 and 80 then raise exception 'invalid_input'; end if;
  if coalesce(p ->> 'icon', '') !~ '^[a-z0-9-]{1,40}$' then raise exception 'invalid_input'; end if;
  if not act and p_id is not null and exists (select 1 from doctors where department_id = p_id and verification_status in ('verified', 'pending')) then raise exception 'in_use'; end if;
  perform set_config('app.audit_reason', why, true);
  if p_id is null then
    insert into departments (name, name_ml, icon, active) values (trim(p ->> 'name'), trim(p ->> 'name_ml'), p ->> 'icon', act) returning id into nid;
    return nid;
  end if;
  update departments set name = trim(p ->> 'name'), name_ml = trim(p ->> 'name_ml'), icon = p ->> 'icon', active = act where id = p_id;
  if not found then raise exception 'not_found'; end if;
  return p_id;
end $$;

/** Holidays: slots on that day close for new bookings; existing bookings stay (returned so staff can act). */
create or replace function public.admin_save_holiday(p_hospital uuid, p_date date, p_name text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); hid uuid; doc uuid; booked int;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_date < (now() at time zone 'Asia/Kolkata')::date or length(trim(coalesce(p_name, ''))) not between 2 and 80 then raise exception 'invalid_input'; end if;
  if exists (select 1 from holidays where date = p_date and hospital_id is not distinct from p_hospital) then raise exception 'duplicate'; end if;
  perform set_config('app.audit_reason', why, true);
  insert into holidays (hospital_id, date, name) values (p_hospital, p_date, trim(p_name)) returning id into hid;
  for doc in select id from doctors where verification_status = 'verified' and (p_hospital is null or hospital_id = p_hospital) loop
    perform public.rebuild_slots(doc);
  end loop;
  select count(*) into booked from appointments a join doctors d on d.id = a.doctor_id
   where a.status = 'confirmed' and (a.start_at at time zone 'Asia/Kolkata')::date = p_date and (p_hospital is null or d.hospital_id = p_hospital);
  return jsonb_build_object('id', hid, 'bookings_that_day', booked);
end $$;

create or replace function public.admin_delete_holiday(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); h holidays; doc uuid;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform set_config('app.audit_reason', why, true);
  delete from holidays where id = p_id returning * into h;
  if h.id is null then raise exception 'not_found'; end if;
  for doc in select id from doctors where verification_status = 'verified' and (h.hospital_id is null or hospital_id = h.hospital_id) loop
    perform public.rebuild_slots(doc);
  end loop;
end $$;

create or replace function public.admin_save_drug(p jsonb, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); k text := lower(trim(coalesce(p ->> 'id', '')));
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if k !~ '^[a-z0-9-]{2,40}$' or length(trim(coalesce(p ->> 'name', ''))) not between 2 and 120 or length(trim(coalesce(p ->> 'generic_name', ''))) not between 2 and 120 then raise exception 'invalid_input'; end if;
  perform set_config('app.audit_reason', why, true);
  insert into drug_master (id, name, generic_name, form, strength, category, schedule, interaction_groups, allergy_class, default_dose, default_frequency, default_route, active)
  values (k, trim(p ->> 'name'), trim(p ->> 'generic_name'), trim(coalesce(p ->> 'form', '')), trim(coalesce(p ->> 'strength', '')),
          (p ->> 'category')::drug_category, (p ->> 'schedule')::drug_schedule,
          coalesce((select array_agg(distinct lower(trim(g))) from jsonb_array_elements_text(coalesce(p -> 'interaction_groups', '[]')) g where trim(g) <> ''), '{}'),
          nullif(lower(trim(coalesce(p ->> 'allergy_class', ''))), ''), trim(coalesce(p ->> 'default_dose', '')),
          trim(coalesce(p ->> 'default_frequency', '')), coalesce(nullif(trim(coalesce(p ->> 'default_route', '')), ''), 'Oral'), coalesce((p ->> 'active')::boolean, true))
  on conflict (id) do update set name = excluded.name, generic_name = excluded.generic_name, form = excluded.form, strength = excluded.strength,
    category = excluded.category, schedule = excluded.schedule, interaction_groups = excluded.interaction_groups, allergy_class = excluded.allergy_class,
    default_dose = excluded.default_dose, default_frequency = excluded.default_frequency, default_route = excluded.default_route, active = excluded.active;
  return k;
end $$;

create or replace function public.admin_save_icd(p_code text, p_description text, p_active boolean, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); c text := upper(trim(coalesce(p_code, '')));
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if c !~ '^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$' or length(trim(coalesce(p_description, ''))) not between 3 and 200 then raise exception 'invalid_input'; end if;
  perform set_config('app.audit_reason', why, true);
  insert into icd10_master (code, description, active) values (c, trim(p_description), coalesce(p_active, true))
  on conflict (code) do update set description = excluded.description, active = excluded.active;
  return c;
end $$;

-- inactive ICD codes no longer appear in the doctor's search (otherwise as in 20261101000010)
create or replace function public.search_icd10(p_q text)
returns setof icd10_master language sql stable set search_path = public, extensions as $$
  with q as (select trim(regexp_replace(coalesce(p_q, ''), '[%_\\]', '', 'g')) q)
  select m.* from icd10_master m, q
   where m.active and length(q.q) >= 2 and (m.code ilike q.q || '%' or m.description ilike '%' || q.q || '%' or similarity(m.description, q.q) > 0.3)
   order by (m.code ilike q.q || '%') desc, (m.description ilike q.q || '%') desc, similarity(m.description, q.q) desc, m.code
   limit 20;
$$;

-- ================================================================ appointment monitor
create or replace function public.admin_appointments(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f timestamptz := public.ist_day_start(coalesce((p ->> 'from')::date, (now() at time zone 'Asia/Kolkata')::date));
  t timestamptz := public.ist_day_start(coalesce((p ->> 'to')::date, (now() at time zone 'Asia/Kolkata')::date) + 1);
  q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  if not public.staff_ok('admin', 'coordinator', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    with base as (
      select a.*, public.appt_attention(a) attention from appointments a
       where (q is not null or (a.start_at >= f and a.start_at < t)) and a.status <> 'rescheduled'   -- a reference / phone search covers every date
         and (p ->> 'status' is null or a.status::text = p ->> 'status')
         and (p ->> 'doctor_id' is null or a.doctor_id = (p ->> 'doctor_id')::uuid)
         and (p ->> 'department_id' is null or a.department_id = (p ->> 'department_id')::uuid)
         and (p ->> 'hospital_id' is null or a.hospital_id = (p ->> 'hospital_id')::uuid)
         and (q is null or a.ref_code ilike q || '%'
              or exists (select 1 from profiles pr where pr.id = a.booked_by_user_id and pr.phone like '%' || regexp_replace(q, '\D', '', 'g') || '%' and length(regexp_replace(q, '\D', '', 'g')) >= 5))),
    f2 as (select * from base where not coalesce((p ->> 'attention')::boolean, false) or cardinality(attention) > 0)
    select jsonb_build_object('total', (select count(*) from f2),
      'attention', (select count(*) from base where cardinality(attention) > 0),
      'rows', coalesce((select jsonb_agg(r order by r.start_at) from (
        select x.id, x.ref_code, x.start_at, x.end_at, x.mode, x.consult_type, x.status, x.outcome, x.outcome_reason, x.fee_amount, x.is_free,
               x.doctor_id, x.department_id, x.extended_minutes, x.doctor_joined_at, x.patient_joined_at, x.attention, x.created_at,
               d.full_name doctor_name, dep.name department, h.name hospital,
               pt.full_name patient_name, pr.phone contact_phone,
               (select status from payments y where y.appointment_id = x.id order by created_at desc limit 1) payment_status,
               (select coalesce(sum(amount), 0) from refunds y where y.appointment_id = x.id and y.status <> 'failed') refunded,
               (select coalesce(sum(amount), 0) from payments y where y.appointment_id = x.id and y.status in ('captured', 'partially_refunded', 'refunded')) paid
          from f2 x join doctors d on d.id = x.doctor_id join departments dep on dep.id = x.department_id join hospitals h on h.id = x.hospital_id
          join patients pt on pt.id = x.patient_id left join profiles pr on pr.id = x.booked_by_user_id
         order by x.start_at limit least(greatest(coalesce((p ->> 'limit')::int, 100), 1), 500) offset greatest(coalesce((p ->> 'offset')::int, 0), 0)) r), '[]')));
end $$;

/** Staff cancel. Refund: full | policy (the patient cancellation tiers) | none. Coordinators: full only. */
create or replace function public.admin_cancel_appointment(p_appt uuid, p_refund text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; why text := public.need_reason(p_reason); q jsonb; amt int := 0; rid uuid; pct int;
begin
  if not public.staff_ok('admin', 'coordinator', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_refund not in ('full', 'policy', 'none') then raise exception 'invalid_input'; end if;
  if p_refund <> 'full' and not public.staff_ok('admin', 'finance') then raise exception 'full_refund_only'; end if;
  select * into a from appointments where id = p_appt for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status <> 'confirmed' then raise exception 'not_cancellable'; end if;
  q := public.refund_quote(a.id, case when p_refund = 'policy' then 'patient' else 'admin' end);
  amt := case when p_refund = 'none' then 0 else (q ->> 'amount')::int end;
  pct := case when p_refund = 'none' then 0 else (q ->> 'percent')::int end;
  perform set_config('app.audit_reason', 'Cancelled by Sunrise (' || p_refund || ' refund): ' || why, true);
  update reschedule_requests set status = 'expired', response_note = 'cancelled by Sunrise', responded_at = now() where appointment_id = a.id and status = 'pending';
  update appointments set status = 'cancelled', outcome = 'cancelled_by_admin', outcome_reason = why, cancelled_at = now() where id = a.id;
  update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id and start_at > now();
  if amt > 0 then
    insert into refunds (payment_id, appointment_id, amount, reason, status, initiated_by)
    values ((q ->> 'payment_id')::uuid, a.id, amt, 'Cancelled by Sunrise – ' || p_refund || ' refund (' || pct || '%)', 'initiated', auth.uid())
    returning id into rid;
  end if;
  return jsonb_build_object('refund_amount', amt, 'refund_id', rid, 'paid', q -> 'paid');
end $$;

/** Like move_appointment, but the new slot may belong to another doctor (same department, same mode). */
create or replace function public.move_appointment_to(p_appt uuid, p_slot uuid, p_reason text)
returns appointments language plpgsql security definer set search_path = public as $$
declare a appointments; s slots; d doctors; n appointments; v jsonb;
begin
  select * into a from appointments where id = p_appt for update;
  select * into s from slots where id = p_slot for update;
  if s.id is null then raise exception 'slot_not_found'; end if;
  if s.doctor_id = a.doctor_id then return public.move_appointment(p_appt, p_slot, p_reason); end if;
  select * into d from doctors where id = s.doctor_id;
  if d.verification_status <> 'verified' or not d.active then raise exception 'doctor_unavailable'; end if;
  if d.department_id <> a.department_id then raise exception 'other_department'; end if;
  if not (a.mode = any(d.modes)) then raise exception 'mode_not_offered'; end if;
  if s.start_at <= now() or not public.slot_bookable(s) then raise exception 'slot_taken'; end if;
  if exists (select 1 from appointments x where x.patient_id = a.patient_id and x.id <> a.id and x.status in ('pending_payment', 'confirmed', 'in_progress')
             and tstzrange(x.start_at, x.end_at) && tstzrange(s.start_at, s.end_at)) then raise exception 'patient_overlap'; end if;
  perform set_config('app.audit_reason', left(p_reason, 200), true);
  update slots set status = 'open', held_until = null, appointment_id = null where id = a.slot_id and appointment_id = a.id;
  update appointments set status = 'rescheduled', ref_code = ref_code || '-R', outcome_reason = coalesce(outcome_reason, left(p_reason, 300)) where id = a.id;
  -- the booked fee, type and follow-up link are kept: a Sunrise-initiated move never costs the patient more
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type,
                            index_appointment_id, follow_up_override_id, fee_amount, is_free, status, rescheduled_from_id)
  values (a.ref_code, a.patient_id, a.booked_by_user_id, d.id, d.hospital_id, d.department_id, s.id, s.start_at, s.end_at, a.mode, a.consult_type,
          a.index_appointment_id, a.follow_up_override_id, a.fee_amount, a.is_free, 'confirmed', a.id)
  returning * into n;
  update appointments set rescheduled_to_id = n.id where id = a.id;
  update slots set status = 'booked', held_until = null, appointment_id = n.id where id = s.id;
  insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, voice_note_path, vitals, allergies, current_medicines, past_history)
  select n.id, body_area, symptoms, duration, severity, description, voice_note_path, vitals, allergies, current_medicines, past_history
    from appointment_symptoms where appointment_id = a.id;
  update documents set appointment_id = n.id where appointment_id = a.id;
  update payments set appointment_id = n.id where appointment_id = a.id;
  v := public.appt_vars(n);
  perform public.enqueue_notification(a.booked_by_user_id, 'rescheduled', v, '/p/appointments', 'rescheduled:' || n.id, n.id);
  perform public.enqueue_notification((select profile_id from doctors where id = a.doctor_id), 'doctor_booking_cancelled', public.appt_vars(a),
                                      '/d/appointments/' || a.id, 'doctor_booking_cancelled:' || a.id, a.id);
  perform public.enqueue_notification(d.profile_id, 'doctor_new_booking', v, '/d/appointments/' || n.id, 'doctor_new_booking:' || n.id, n.id);
  return n;
end $$;

create or replace function public.admin_move_appointment(p_appt uuid, p_slot uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare a appointments; why text := public.need_reason(p_reason); n appointments;
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into a from appointments where id = p_appt for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status <> 'confirmed' then raise exception 'not_reschedulable'; end if;
  update reschedule_requests set status = 'expired', response_note = 'moved by Sunrise', responded_at = now() where appointment_id = a.id and status = 'pending';
  update slots s set status = 'open', held_until = null from reschedule_requests r
   where r.appointment_id = a.id and r.proposed_slot_id = s.id and s.status = 'held' and s.appointment_id is null and s.id <> p_slot;
  n := public.move_appointment_to(a.id, p_slot, 'Moved by Sunrise: ' || why);
  return n.id;
end $$;

/** Free slots a booking could move to: same doctor, or (with p_any_doctor) the department's verified doctors offering that mode. */
create or replace function public.admin_move_options(p_appt uuid, p_any_doctor boolean default false, p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a appointments;
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into a from appointments where id = p_appt;
  if a.id is null then raise exception 'not_found'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('slot_id', s.id, 'start_at', s.start_at, 'doctor_id', d.id, 'doctor_name', d.full_name) order by s.start_at, d.full_name)
    from slots s join doctors d on d.id = s.doctor_id
   where s.start_at > now() + interval '5 minutes' and s.start_at < now() + make_interval(days => least(greatest(p_days, 1), 30))
     and public.slot_bookable(s) and d.verification_status = 'verified' and d.active and a.mode = any(d.modes)
     and (d.id = a.doctor_id or (p_any_doctor and d.department_id = a.department_id))
     and not exists (select 1 from appointments x where x.patient_id = a.patient_id and x.id <> a.id and x.status in ('pending_payment', 'confirmed', 'in_progress')
                     and tstzrange(x.start_at, x.end_at) && tstzrange(s.start_at, s.end_at))), '[]');
end $$;

/** Record an outcome the automatic rules didn't (completed / patient no-show / doctor no-show / technical failure). */
create or replace function public.admin_record_outcome(p_appt uuid, p_outcome text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments; why text := public.need_reason(p_reason); pct int := coalesce((setting('patient_no_show_refund_percent'))::int, 0);
  pg int := coalesce((setting('patient_grace_minutes'))::int, 10); dg int := coalesce((setting('doctor_grace_minutes'))::int, 10); p payments; rid uuid;
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into a from appointments where id = p_appt for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status not in ('confirmed', 'in_progress') then raise exception 'outcome_recorded'; end if;
  if now() < a.start_at then raise exception 'too_early'; end if;
  perform set_config('app.audit_reason', 'Outcome by Sunrise: ' || p_outcome || ' – ' || why, true);
  update reschedule_requests set status = 'expired', response_note = 'outcome recorded', responded_at = now() where appointment_id = a.id and status = 'pending';
  if p_outcome = 'completed' then
    update appointments set status = 'completed', outcome = 'completed', completed_at = now(), outcome_reason = why where id = a.id;
  elsif p_outcome = 'patient_no_show' then
    if now() < a.start_at + make_interval(mins => pg) then raise exception 'grace_not_over'; end if;
    update appointments set status = 'no_show', outcome = 'patient_no_show', outcome_reason = why where id = a.id;
    if pct > 0 then
      select * into p from payments where appointment_id = a.id and status = 'captured';
      if p.id is not null then
        insert into refunds (payment_id, appointment_id, amount, reason, status, initiated_by)
        values (p.id, a.id, round(p.amount * pct / 100.0)::int, 'Patient no-show policy (' || pct || '%)', 'initiated', auth.uid()) returning id into rid;
      end if;
    end if;
  elsif p_outcome = 'doctor_no_show' then
    if now() < a.start_at + make_interval(mins => dg) then raise exception 'grace_not_over'; end if;
    perform public.cancel_for_doctor_reason(a.id, 'doctor_no_show', 'Doctor did not join: ' || why);
  elsif p_outcome = 'technical_failure' then
    perform public.cancel_for_doctor_reason(a.id, 'technical_failure', 'Technical failure: ' || why);
  else
    raise exception 'invalid_input';
  end if;
  return jsonb_build_object('status', (select status from appointments where id = a.id), 'refund_id', rid);
end $$;

create or replace function public.admin_extend_window(p_appt uuid, p_minutes int, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare a appointments; why text := public.need_reason(p_reason);
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_minutes not between 5 and 30 then raise exception 'invalid_input'; end if;
  select * into a from appointments where id = p_appt for update;
  if a.id is null then raise exception 'not_found'; end if;
  if a.status not in ('confirmed', 'in_progress') then raise exception 'not_joinable'; end if;
  if a.extended_minutes + p_minutes > 60 then raise exception 'extension_limit'; end if;
  perform set_config('app.audit_reason', 'Join window +' || p_minutes || ' min: ' || why, true);
  update appointments set extended_minutes = extended_minutes + p_minutes where id = a.id returning * into a;
  return a.extended_minutes;
end $$;

-- ================================================================ consent & terms content
create or replace function public.admin_publish_content(p_key text, p_title_en text, p_title_ml text, p_body_en text, p_body_ml text, p_new_version boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare why text := public.need_reason(p_reason); cur content_versions; ver text; rev int; consent boolean := p_key in ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms');
  lim int := case when p_key in ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms') then 1500 else 20000 end; affected int := 0;
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_body_en, ''))) not between 10 and lim or length(trim(coalesce(p_body_ml, ''))) not between 10 and lim then raise exception 'invalid_body'; end if;
  select * into cur from content_versions where key = p_key order by split_part(version, '.', 1)::int desc, split_part(version, '.', 2)::int desc, revision desc limit 1;
  if cur.id is not null and trim(p_body_en) = cur.body_en and trim(p_body_ml) = cur.body_ml
     and coalesce(trim(p_title_en), '') = cur.title_en and coalesce(trim(p_title_ml), '') = cur.title_ml and not p_new_version then raise exception 'no_change'; end if;
  if cur.id is null then ver := '1.0'; rev := 1;
  elsif p_new_version then ver := (split_part(cur.version, '.', 1)::int + 1) || '.0'; rev := 1;
  else ver := cur.version; rev := cur.revision + 1; end if;
  perform set_config('app.audit_reason', why, true);
  insert into content_versions (key, version, revision, title_en, title_ml, body_en, body_ml, published_by, reason)
  values (p_key, ver, rev, coalesce(trim(p_title_en), ''), coalesce(trim(p_title_ml), ''), trim(p_body_en), trim(p_body_ml), auth.uid(), why);
  if consent then
    update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_key], jsonb_build_object('en', trim(p_body_en), 'ml', trim(p_body_ml))) where key = 'consent_texts';
    if p_new_version then
      update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_key], to_jsonb(ver)) where key = 'consent_versions';
      select count(distinct user_id) into affected from consents where consent_type = p_key::consent_type and granted and withdrawn_at is null;
    end if;
  end if;
  return jsonb_build_object('version', ver, 'revision', rev, 'reconsent', consent and p_new_version and p_key <> 'whatsapp_opt_in', 'affected_users', affected);
end $$;

/** Public: latest published text (legal pages, consent screen). */
create or replace function public.public_content(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) - 'published_by' - 'reason' from (select * from content_versions where key = p_key order by split_part(version, '.', 1)::int desc, split_part(version, '.', 2)::int desc, revision desc limit 1) x;
$$;

-- ================================================================ support tickets
create or replace function public.create_ticket(p_category text, p_subject text, p_description text, p_appt uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_subject, ''))) not between 5 and 140 or length(trim(coalesce(p_description, ''))) not between 10 and 4000 then raise exception 'invalid_input'; end if;
  if p_appt is not null and not public.can_see_appointment(p_appt) then raise exception 'not_found'; end if;
  if not public.check_rate_limit('ticket:' || auth.uid(), 5, 3600) then raise exception 'rate_limited'; end if;
  perform set_config('app.audit_reason', 'Ticket opened', true);
  insert into support_tickets (user_id, appointment_id, category, subject, description, status)
  values (auth.uid(), p_appt, p_category, trim(p_subject), trim(p_description), 'open') returning id into tid;
  return tid;
end $$;

create or replace function public.post_ticket_message(p_ticket uuid, p_body text, p_internal boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare t support_tickets; staff boolean := public.staff_ok('admin', 'coordinator'); mid uuid;
begin
  select * into t from support_tickets where id = p_ticket for update;
  if t.id is null or not (staff or t.user_id = auth.uid()) then raise exception 'not_found'; end if;
  if length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_input'; end if;
  if t.status = 'closed' then raise exception 'ticket_closed'; end if;
  if not staff and p_internal then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.check_rate_limit('ticketmsg:' || auth.uid(), 30, 600) then raise exception 'rate_limited'; end if;
  perform set_config('app.audit_reason', case when staff then 'Ticket reply by Sunrise' else 'Ticket reply by user' end, true);
  insert into ticket_messages (ticket_id, author_user_id, author_kind, body, internal)
  values (t.id, auth.uid(), case when staff and t.user_id <> auth.uid() then 'staff' else 'user' end, trim(p_body), coalesce(p_internal, false))
  returning id into mid;
  if staff and t.user_id <> auth.uid() and not p_internal then
    update support_tickets set first_response_at = coalesce(first_response_at, now()), status = case when status = 'open' then 'in_progress' else status end,
           updated_at = now() where id = t.id;
    perform public.enqueue_notification(t.user_id, 'ticket_update', jsonb_build_object('ref', t.ref_code), '/p/help/' || t.id, 'ticket_update:' || mid);
  elsif not staff then
    update support_tickets set status = case when status = 'resolved' then 'open' else status end, resolved_at = case when status = 'resolved' then null else resolved_at end,
           updated_at = now() where id = t.id;
  end if;
  return mid;
end $$;

create or replace function public.admin_update_ticket(p_ticket uuid, p_status text, p_assignee uuid, p_resolution text)
returns void language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into t from support_tickets where id = p_ticket for update;
  if t.id is null then raise exception 'not_found'; end if;
  if p_status not in ('open', 'in_progress', 'resolved', 'closed') then raise exception 'invalid_input'; end if;
  if p_assignee is not null and not exists (select 1 from user_roles where user_id = p_assignee and role in ('admin', 'coordinator')) then raise exception 'invalid_assignee'; end if;
  if p_status in ('resolved', 'closed') and length(trim(coalesce(p_resolution, t.resolution, ''))) < 5 then raise exception 'resolution_required'; end if;
  perform set_config('app.audit_reason', 'Ticket ' || p_status, true);
  update support_tickets set status = p_status, assigned_to = p_assignee, resolution = coalesce(nullif(left(trim(coalesce(p_resolution, '')), 2000), ''), resolution),
         resolved_at = case when p_status in ('resolved', 'closed') then coalesce(resolved_at, now()) else null end, updated_at = now()
   where id = t.id;
  if p_status = 'resolved' and t.status <> 'resolved' then
    perform public.enqueue_notification(t.user_id, 'ticket_update', jsonb_build_object('ref', t.ref_code), '/p/help/' || t.id, 'ticket_resolved:' || t.id || ':' || extract(epoch from now())::bigint);
  end if;
end $$;

create or replace function public.admin_tickets(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    with f as (
      select t.* from support_tickets t
       where (p ->> 'status' is null or t.status = p ->> 'status' or (p ->> 'status' = 'active' and t.status in ('open', 'in_progress')))
         and (p ->> 'category' is null or t.category = p ->> 'category')
         and (p ->> 'assignee' is null or (p ->> 'assignee' = 'me' and t.assigned_to = auth.uid()) or (p ->> 'assignee' = 'none' and t.assigned_to is null))
         and (q is null or t.ref_code ilike '%' || q || '%' or t.subject ilike '%' || q || '%'))
    select jsonb_build_object('total', (select count(*) from f),
      'counts', (select jsonb_object_agg(status, n) from (select status, count(*) n from support_tickets group by status) c),
      'rows', coalesce((select jsonb_agg(r order by r.updated_at desc) from (
        select f.id, f.ref_code, f.category, f.subject, f.status, f.created_at, f.updated_at, f.first_response_at, f.resolved_at, f.assigned_to,
               pr.full_name user_name, pr.phone user_phone, (select full_name from profiles where id = f.assigned_to) assignee_name,
               (select ref_code from appointments where id = f.appointment_id) appointment_ref,
               (select count(*) from ticket_messages m where m.ticket_id = f.id) messages
          from f left join profiles pr on pr.id = f.user_id
         order by f.updated_at desc limit least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 200) offset greatest(coalesce((p ->> 'offset')::int, 0), 0)) r), '[]')));
end $$;

-- ================================================================ audit log search
create or replace function public.admin_audit(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f timestamptz := public.ist_day_start(coalesce((p ->> 'from')::date, (now() at time zone 'Asia/Kolkata')::date - 6));
  t timestamptz := public.ist_day_start(coalesce((p ->> 'to')::date, (now() at time zone 'Asia/Kolkata')::date) + 1);
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    with x as (
      select l.* from audit_logs l
       where l.created_at >= f and l.created_at < t
         and (p ->> 'entity' is null or l.entity = p ->> 'entity')
         and (p ->> 'action' is null or l.action ilike '%' || (p ->> 'action') || '%')
         and (p ->> 'actor' is null or l.actor_user_id = (p ->> 'actor')::uuid)
         and (p ->> 'actor_role' is null or l.actor_role = p ->> 'actor_role')
         and (p ->> 'entity_id' is null or l.entity_id = p ->> 'entity_id')
         and (p ->> 'q' is null or l.reason ilike '%' || (p ->> 'q') || '%'))
    select jsonb_build_object('total', (select count(*) from x),
      'rows', coalesce((select jsonb_agg(r order by r.created_at desc) from (
        select x.id, x.created_at, x.action, x.entity, x.entity_id, x.actor_user_id, x.actor_role, x.reason, x.before, x.after,
               (select full_name from profiles where id = x.actor_user_id) actor_name
          from x order by x.created_at desc limit least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 500) offset greatest(coalesce((p ->> 'offset')::int, 0), 0)) r), '[]')));
end $$;

-- ================================================================ dashboard
create or replace function public.admin_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; d0 timestamptz := public.ist_day_start(today); n int := least(greatest(p_days, 7), 90);
  money boolean := public.staff_ok('admin', 'finance'); since timestamptz;
begin
  if not public.staff_ok('admin', 'coordinator', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  since := public.ist_day_start(today - (n - 1));
  return jsonb_build_object(
    'today', jsonb_build_object(
      'booked', (select count(*) from appointments where start_at >= d0 and start_at < d0 + interval '1 day' and status in ('confirmed', 'in_progress', 'completed', 'no_show')),
      'completed', (select count(*) from appointments where start_at >= d0 and start_at < d0 + interval '1 day' and status = 'completed'),
      'in_progress', (select count(*) from appointments where status = 'in_progress'),
      'next_hour', (select count(*) from appointments where status = 'confirmed' and start_at between now() and now() + interval '1 hour'),
      'no_shows', (select count(*) from appointments where start_at >= d0 and start_at < d0 + interval '1 day'
                    and outcome in ('patient_no_show', 'doctor_no_show', 'both_no_show')),
      'new_bookings', (select count(*) from appointments where created_at >= d0 and status not in ('pending_payment', 'rescheduled') and rescheduled_from_id is null),
      'revenue', case when money then (select coalesce(sum(amount), 0) from payments where captured_at >= d0 and status in ('captured', 'partially_refunded', 'refunded')) end),
    'attention', (select count(*) from appointments a where a.start_at > now() - interval '3 days' and a.start_at < now() + interval '1 day'
                   and a.status in ('confirmed', 'in_progress', 'cancelled') and cardinality(public.appt_attention(a)) > 0),
    'pending_verifications', (select count(*) from doctors where verification_status = 'pending'),
    'open_tickets', (select count(*) from support_tickets where status in ('open', 'in_progress')),
    'unanswered_tickets', (select count(*) from support_tickets where status = 'open' and first_response_at is null),
    'failed_notifications', (select count(*) from notifications where status = 'failed' and created_at > now() - interval '24 hours'),
    'refunds_pending', case when money then (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0)) from refunds where status = 'initiated') end,
    'month_revenue', case when money then
        (select coalesce(sum(amount), 0) from payments where captured_at >= public.ist_day_start(date_trunc('month', today)::date) and status in ('captured', 'partially_refunded', 'refunded'))
      - (select coalesce(sum(amount), 0) from refunds where status = 'processed' and processed_at >= public.ist_day_start(date_trunc('month', today)::date)) end,
    'days', (select jsonb_agg(jsonb_build_object(
        'date', g.d,
        'completed', (select count(*) from appointments a where a.start_at >= public.ist_day_start(g.d) and a.start_at < public.ist_day_start(g.d + 1) and a.status = 'completed'),
        'upcoming', (select count(*) from appointments a where a.start_at >= public.ist_day_start(g.d) and a.start_at < public.ist_day_start(g.d + 1) and a.status in ('confirmed', 'in_progress')),
        'no_show', (select count(*) from appointments a where a.start_at >= public.ist_day_start(g.d) and a.start_at < public.ist_day_start(g.d + 1)
                     and a.outcome in ('patient_no_show', 'doctor_no_show', 'both_no_show')),
        'cancelled', (select count(*) from appointments a where a.start_at >= public.ist_day_start(g.d) and a.start_at < public.ist_day_start(g.d + 1)
                       and a.status = 'cancelled' and a.outcome is distinct from 'payment_expired' and a.outcome not in ('doctor_no_show', 'both_no_show')),
        'revenue', case when money then
            (select coalesce(sum(amount), 0) from payments y where y.captured_at >= public.ist_day_start(g.d) and y.captured_at < public.ist_day_start(g.d + 1)
               and y.status in ('captured', 'partially_refunded', 'refunded'))
          - (select coalesce(sum(amount), 0) from refunds y where y.status = 'processed' and y.processed_at >= public.ist_day_start(g.d) and y.processed_at < public.ist_day_start(g.d + 1)) end
      ) order by g.d) from generate_series(today - (n - 1), today, interval '1 day') g0, lateral (select g0::date d) g),
    'departments', (select coalesce(jsonb_agg(jsonb_build_object('name', dep.name, 'name_ml', dep.name_ml, 'count', c.n) order by c.n desc), '[]') from (
        select department_id, count(*) n from appointments where start_at >= since and start_at < d0 + interval '1 day'
           and status in ('confirmed', 'in_progress', 'completed', 'no_show') group by department_id) c join departments dep on dep.id = c.department_id),
    'money', money);
end $$;

-- ================================================================ reports (no patient identity in any row)
create or replace function public.admin_report(p_kind text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f timestamptz := public.ist_day_start(p_from); t timestamptz := public.ist_day_start(p_to + 1);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid_range'; end if;
  if p_kind = 'revenue' then
    if not public.staff_ok('admin', 'finance') then raise exception 'forbidden' using errcode = '42501'; end if;
  elsif p_kind = 'notifications' then
    if not public.staff_ok('admin', 'coordinator') then raise exception 'forbidden' using errcode = '42501'; end if;
  elsif not public.staff_ok('admin', 'coordinator', 'finance') then raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_kind = 'appointments' then
    return coalesce((select jsonb_agg(r order by r.start_at) from (
      select a.ref_code, a.start_at, to_char(a.start_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') date_ist, to_char(a.start_at at time zone 'Asia/Kolkata', 'HH24:MI') time_ist,
             d.full_name doctor, dep.name department, h.name hospital, a.mode, a.consult_type, a.is_free, a.fee_amount, a.status, a.outcome,
             (select status from payments y where y.appointment_id = a.id order by created_at desc limit 1) payment_status,
             (select coalesce(sum(amount), 0) from refunds y where y.appointment_id = a.id and y.status <> 'failed') refunded
        from appointments a join doctors d on d.id = a.doctor_id join departments dep on dep.id = a.department_id join hospitals h on h.id = a.hospital_id
       where a.start_at >= f and a.start_at < t and a.status <> 'rescheduled') r), '[]');

  elsif p_kind = 'revenue' then
    return (select jsonb_agg(to_jsonb(r) || jsonb_build_object('net', r.gross - r.refunds_processed) order by r.date) from (
      select g.d date,
             (select count(*) from payments y where y.captured_at >= public.ist_day_start(g.d) and y.captured_at < public.ist_day_start(g.d + 1) and y.status in ('captured', 'partially_refunded', 'refunded')) payments,
             (select coalesce(sum(amount), 0) from payments y where y.captured_at >= public.ist_day_start(g.d) and y.captured_at < public.ist_day_start(g.d + 1) and y.status in ('captured', 'partially_refunded', 'refunded')) gross,
             (select count(*) from refunds y where y.status = 'processed' and y.processed_at >= public.ist_day_start(g.d) and y.processed_at < public.ist_day_start(g.d + 1)) refunds_count,
             (select coalesce(sum(amount), 0) from refunds y where y.status = 'processed' and y.processed_at >= public.ist_day_start(g.d) and y.processed_at < public.ist_day_start(g.d + 1)) refunds_processed,
             (select coalesce(sum(amount), 0) from refunds y where y.created_at >= public.ist_day_start(g.d) and y.created_at < public.ist_day_start(g.d + 1)) refunds_initiated,
             (select coalesce(sum(amount), 0) from refunds y where y.status = 'failed' and y.created_at >= public.ist_day_start(g.d) and y.created_at < public.ist_day_start(g.d + 1)) refunds_failed
        from (select x::date d from generate_series(p_from, p_to, interval '1 day') x) g) r);

  elsif p_kind = 'no_shows' then
    return coalesce((select jsonb_agg(r order by r.doctor) from (
      select d.full_name doctor, dep.name department, count(*) due,
             count(*) filter (where a.outcome = 'completed') completed,
             count(*) filter (where a.outcome = 'patient_no_show') patient_no_show,
             count(*) filter (where a.outcome = 'doctor_no_show') doctor_no_show,
             count(*) filter (where a.outcome = 'both_no_show') both_no_show,
             count(*) filter (where a.outcome = 'technical_failure') technical_failure,
             count(*) filter (where a.outcome = 'cancelled_by_doctor') doctor_cancelled
        from appointments a join doctors d on d.id = a.doctor_id join departments dep on dep.id = d.department_id
       where a.start_at >= f and a.start_at < least(t, now())
         and a.outcome in ('completed', 'patient_no_show', 'doctor_no_show', 'both_no_show', 'technical_failure', 'cancelled_by_doctor')
       group by d.full_name, dep.name) r), '[]');

  elsif p_kind = 'utilisation' then
    return coalesce((select jsonb_agg(r order by r.doctor) from (
      select d.full_name doctor, dep.name department, count(s.*) offered,
             count(s.*) filter (where s.status = 'booked') booked,
             count(s.*) filter (where s.status = 'booked' and exists (select 1 from appointments a where a.slot_id = s.id and a.status = 'completed')) completed,
             coalesce(sum(extract(epoch from s.end_at - s.start_at) / 60) filter (where s.status = 'booked'), 0)::int booked_minutes
        from doctors d join departments dep on dep.id = d.department_id
        left join slots s on s.doctor_id = d.id and s.start_at >= f and s.start_at < t and s.status <> 'blocked'
       where d.verification_status in ('verified', 'suspended')
       group by d.full_name, dep.name) r), '[]');

  elsif p_kind = 'follow_ups' then
    return coalesce((select jsonb_agg(r order by r.doctor) from (
      select d.full_name doctor, dep.name department,
             count(*) filter (where not a.is_free and a.consult_type = 'first' and a.status = 'completed') paid_first_completed,
             count(*) filter (where a.is_free and a.status in ('confirmed', 'in_progress', 'completed', 'no_show')) free_booked,
             count(*) filter (where a.is_free and a.status = 'completed') free_completed,
             count(*) filter (where a.is_free and a.follow_up_override_id is not null and a.status in ('confirmed', 'in_progress', 'completed', 'no_show')) via_override,
             coalesce(sum(public.resolve_consult_fee(a.doctor_id, a.mode, 'follow_up')) filter (where a.is_free and a.status = 'completed'), 0) fee_forgone
        from appointments a join doctors d on d.id = a.doctor_id join departments dep on dep.id = d.department_id
       where a.start_at >= f and a.start_at < t
       group by d.full_name, dep.name) r), '[]');

  elsif p_kind = 'notifications' then
    return coalesce((select jsonb_agg(r order by r.template_key, r.channel) from (
      select template_key, channel::text channel, count(*) total,
             count(*) filter (where status in ('sent', 'delivered', 'read')) sent,
             count(*) filter (where status in ('delivered', 'read')) delivered,
             count(*) filter (where status = 'read') read,
             count(*) filter (where status = 'failed') failed,
             count(*) filter (where status = 'skipped') skipped,
             count(*) filter (where clicked_at is not null) clicked,
             coalesce(sum(cost_paise), 0) cost_paise
        from notifications where created_at >= f and created_at < t group by template_key, channel) r), '[]');
  end if;
  raise exception 'invalid_input';
end $$;

-- ================================================================ grants
revoke execute on function public.need_reason, public.ist_day_start, public.appt_attention, public.move_appointment_to, public.link_doctor_login from public, anon, authenticated;
grant execute on function public.link_doctor_login to service_role;
revoke execute on function public.admin_save_doctor, public.admin_add_doctor_credential, public.admin_submit_doctor, public.admin_verify_doctor,
  public.admin_suspend_doctor, public.admin_reinstate_doctor, public.admin_set_staff_roles, public.admin_users, public.admin_save_hospital,
  public.admin_save_department, public.admin_save_holiday, public.admin_delete_holiday, public.admin_save_drug, public.admin_save_icd,
  public.admin_appointments, public.admin_cancel_appointment, public.admin_move_appointment, public.admin_move_options, public.admin_record_outcome,
  public.admin_extend_window, public.admin_publish_content, public.create_ticket, public.post_ticket_message, public.admin_update_ticket,
  public.admin_tickets, public.admin_audit, public.admin_dashboard, public.admin_report from public, anon;
grant execute on function public.admin_save_doctor, public.admin_add_doctor_credential, public.admin_submit_doctor, public.admin_verify_doctor,
  public.admin_suspend_doctor, public.admin_reinstate_doctor, public.admin_set_staff_roles, public.admin_users, public.admin_save_hospital,
  public.admin_save_department, public.admin_save_holiday, public.admin_delete_holiday, public.admin_save_drug, public.admin_save_icd,
  public.admin_appointments, public.admin_cancel_appointment, public.admin_move_appointment, public.admin_move_options, public.admin_record_outcome,
  public.admin_extend_window, public.admin_publish_content, public.create_ticket, public.post_ticket_message, public.admin_update_ticket,
  public.admin_tickets, public.admin_audit, public.admin_dashboard, public.admin_report to authenticated;
grant select on content_versions, ticket_messages, doctor_credentials to authenticated;   -- RLS decides which rows
grant execute on function public.public_content to anon, authenticated;
revoke execute on function public.am_staff from public, anon;
grant execute on function public.am_staff to authenticated;
