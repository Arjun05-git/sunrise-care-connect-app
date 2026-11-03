-- =============================================================================
-- Row Level Security
--
--  Visibility model
--   * patient      : own record + dependents (my_patient_ids()), their appointments, documents,
--                    final notes & prescriptions, own consents / notifications / tickets.
--   * doctor       : own doctor row; only appointments assigned to them; a patient's record,
--                    documents and history ONLY if that patient has an appointment with them.
--                    Optional PIN/biometric step-up gate (app_settings.require_doctor_step_up).
--   * admin        : everything, incl. audit log. Needs aal2 when an MFA factor is enrolled.
--   * coordinator  : operational data (appointments, patients' demographics, slots, tickets,
--                    outbox) – NOT clinical content (symptoms, notes, prescriptions, documents).
--   * finance      : payments, refunds, fees, appointment metadata – NOT clinical content.
--   * anon         : nothing (prescription QR verification is a SECURITY DEFINER RPC, later phase).
--
--  Writes that carry business rules (booking, payment capture, refunds, outcomes, prescription
--  finalisation) are deliberately NOT granted here; they are added as SECURITY DEFINER RPCs in the
--  booking phase. With RLS forced and no policy, those writes are denied by default.
-- =============================================================================

-- ---------------------------------------------------------------- helper functions
create or replace function public.has_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = r);
$$;

-- Staff in any of the given roles; if the user has a verified MFA factor the JWT must be aal2.
create or replace function public.staff_ok(variadic roles app_role[])
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = any(roles))
     and (
       coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
       or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
     );
$$;

-- The caller's doctor id (null if not a doctor, or step-up required and not done).
create or replace function public.my_doctor_id()
returns uuid language sql stable security definer set search_path = public as $$
  select d.id from doctors d
  where d.profile_id = auth.uid()
    and (
      coalesce((select (value)::boolean from app_settings where key = 'require_doctor_step_up'), true) = false
      or exists (select 1 from auth_step_up s where s.user_id = auth.uid() and s.verified_until > now())
    );
$$;

-- Patient records the caller owns (self + dependents).
create or replace function public.my_patient_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from patients where owner_user_id = auth.uid() and archived_at is null;
$$;

create or replace function public.doctor_sees_patient(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from appointments a where a.patient_id = p and a.doctor_id = public.my_doctor_id());
$$;

-- Operational visibility of an appointment (times, status, fee) – patients, the doctor, all staff.
create or replace function public.can_see_appointment(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from appointments a
    where a.id = a_id
      and (a.patient_id in (select public.my_patient_ids())
           or a.doctor_id = public.my_doctor_id()
           or public.staff_ok('admin', 'coordinator', 'finance'))
  );
$$;

-- Clinical visibility (symptoms, notes, prescriptions) – patient, treating doctor, admin only.
create or replace function public.can_see_clinical(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from appointments a
    where a.id = a_id
      and (a.patient_id in (select public.my_patient_ids())
           or a.doctor_id = public.my_doctor_id()
           or public.staff_ok('admin'))
  );
$$;

revoke execute on function public.has_role, public.staff_ok, public.my_doctor_id, public.my_patient_ids,
  public.doctor_sees_patient, public.can_see_appointment, public.can_see_clinical from anon;

-- ---------------------------------------------------------------- enable + force RLS everywhere
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Tables with NO policies (service role / SECURITY DEFINER only):
--   doctor_secrets, auth_step_up, payment_webhook_events, rate_limits

-- ---------------------------------------------------------------- identity
create policy profiles_select_self  on profiles for select using (id = auth.uid());
create policy profiles_select_staff on profiles for select using (public.staff_ok('admin', 'coordinator', 'finance'));
create policy profiles_select_doctor on profiles for select using (
  exists (select 1 from patients p where p.owner_user_id = profiles.id and public.doctor_sees_patient(p.id)));
create policy profiles_update_self  on profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy user_roles_select_self  on user_roles for select using (user_id = auth.uid());
create policy user_roles_admin_all    on user_roles for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));

create policy doctor_prefs_own on doctor_preferences for all using (doctor_id = public.my_doctor_id()) with check (doctor_id = public.my_doctor_id());

-- ---------------------------------------------------------------- catalogue & configuration
create policy hospitals_read        on hospitals    for select to authenticated using (true);
create policy hospitals_admin       on hospitals    for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy departments_read      on departments  for select to authenticated using (true);
create policy departments_admin     on departments  for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy doctors_read_public   on doctors      for select to authenticated using (active and verification_status = 'verified');
create policy doctors_read_self     on doctors      for select using (profile_id = auth.uid());
create policy doctors_read_staff    on doctors      for select using (public.staff_ok('admin', 'coordinator', 'finance'));
create policy doctors_admin         on doctors      for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy availability_read     on doctor_availability for select to authenticated using (true);
create policy availability_own      on doctor_availability for all using (doctor_id = public.my_doctor_id()) with check (doctor_id = public.my_doctor_id());
create policy availability_staff    on doctor_availability for all using (public.staff_ok('admin', 'coordinator')) with check (public.staff_ok('admin', 'coordinator'));
create policy holidays_read         on holidays     for select to authenticated using (true);
create policy holidays_admin        on holidays     for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy slots_read            on slots        for select to authenticated using (true);   -- times only, no PHI
create policy slots_staff           on slots        for all using (public.staff_ok('admin', 'coordinator')) with check (public.staff_ok('admin', 'coordinator'));
create policy fee_read              on fee_config   for select to authenticated using (true);
create policy fee_write             on fee_config   for all using (public.staff_ok('admin', 'finance')) with check (public.staff_ok('admin', 'finance'));
create policy followup_read         on follow_up_policy for select to authenticated using (true);
create policy followup_admin        on follow_up_policy for update using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy settings_read         on app_settings for select to authenticated using (true);
create policy settings_admin        on app_settings for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy icd_read              on icd10_master for select to authenticated using (true);
create policy icd_admin             on icd10_master for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy drugs_read            on drug_master  for select to authenticated using (true);
create policy drugs_admin           on drug_master  for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy drug_rules_read       on drug_rules   for select to authenticated using (true);
create policy drug_rules_admin      on drug_rules   for update using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
create policy templates_read        on notification_templates for select using (public.staff_ok('admin', 'coordinator'));
create policy templates_admin       on notification_templates for update using (public.staff_ok('admin')) with check (public.staff_ok('admin'));

-- ---------------------------------------------------------------- patients, dependents, consent
create policy patients_select_own    on patients for select using (id in (select public.my_patient_ids()));
create policy patients_insert_own    on patients for insert with check (owner_user_id = auth.uid());
create policy patients_update_own    on patients for update using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy patients_select_doctor on patients for select using (public.doctor_sees_patient(id));
create policy patients_select_staff  on patients for select using (public.staff_ok('admin', 'coordinator', 'finance'));

create policy dependents_own   on dependents for all
  using (owner_patient_id in (select public.my_patient_ids()))
  with check (owner_patient_id in (select public.my_patient_ids()) and patient_id in (select public.my_patient_ids()));
create policy dependents_staff on dependents for select using (public.staff_ok('admin', 'coordinator'));

create policy consents_select_own   on consents for select using (user_id = auth.uid());
create policy consents_insert_own   on consents for insert with check (user_id = auth.uid() and granted);
create policy consents_withdraw_own on consents for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy consents_select_admin on consents for select using (public.staff_ok('admin'));

create policy data_requests_own    on data_requests for select using (user_id = auth.uid());
create policy data_requests_create on data_requests for insert with check (user_id = auth.uid() and status = 'received');
create policy data_requests_admin  on data_requests for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));

-- ---------------------------------------------------------------- appointments (read-only until booking RPCs)
create policy appointments_select on appointments for select using (public.can_see_appointment(id));

create policy symptoms_select       on appointment_symptoms for select using (public.can_see_clinical(appointment_id));
create policy symptoms_update_own   on appointment_symptoms for update using (
  exists (select 1 from appointments a where a.id = appointment_id and a.patient_id in (select public.my_patient_ids()) and a.status in ('pending_payment', 'confirmed')));

create policy documents_select on documents for select using (
  patient_id in (select public.my_patient_ids()) or public.doctor_sees_patient(patient_id) or public.staff_ok('admin'));
create policy documents_insert on documents for insert with check (
  uploaded_by = auth.uid() and (patient_id in (select public.my_patient_ids()) or public.doctor_sees_patient(patient_id)));
create policy documents_attach on documents for update
  using (patient_id in (select public.my_patient_ids())) with check (patient_id in (select public.my_patient_ids()));
create policy documents_delete on documents for delete using (
  patient_id in (select public.my_patient_ids())
  and (appointment_id is null or exists (select 1 from appointments a where a.id = appointment_id and a.status in ('pending_payment', 'confirmed', 'cancelled'))));

create policy reschedule_select on reschedule_requests for select using (public.can_see_appointment(appointment_id));
create policy call_logs_select  on call_logs for select using (public.can_see_appointment(appointment_id));
create policy call_logs_insert  on call_logs for insert with check (actor_user_id = auth.uid() and public.can_see_clinical(appointment_id));

create policy chat_select on chat_messages for select using (
  exists (select 1 from appointments a where a.id = appointment_id and (a.patient_id in (select public.my_patient_ids()) or a.doctor_id = public.my_doctor_id())));
create policy chat_insert on chat_messages for insert with check (
  sender_user_id = auth.uid()
  and exists (select 1 from appointments a where a.id = appointment_id and a.status in ('confirmed', 'in_progress')
              and (a.patient_id in (select public.my_patient_ids()) or a.doctor_id = public.my_doctor_id())));

-- ---------------------------------------------------------------- money (no clinical data)
create policy payments_select_own   on payments for select using (exists (select 1 from appointments a where a.id = appointment_id and a.patient_id in (select public.my_patient_ids())));
create policy payments_select_staff on payments for select using (public.staff_ok('admin', 'finance'));
create policy refunds_select_own    on refunds  for select using (exists (select 1 from appointments a where a.id = appointment_id and a.patient_id in (select public.my_patient_ids())));
create policy refunds_select_staff  on refunds  for select using (public.staff_ok('admin', 'finance'));
create policy refunds_update_staff  on refunds  for update using (public.staff_ok('admin', 'finance')) with check (public.staff_ok('admin', 'finance'));

-- ---------------------------------------------------------------- clinical
create policy consultations_doctor  on consultations for all using (doctor_id = public.my_doctor_id()) with check (doctor_id = public.my_doctor_id());
create policy consultations_patient on consultations for select using (status = 'final' and patient_id in (select public.my_patient_ids()));
create policy consultations_admin   on consultations for select using (public.staff_ok('admin'));

create policy rx_select_doctor  on prescriptions for select using (doctor_id = public.my_doctor_id() or (status = 'final' and public.doctor_sees_patient(patient_id)));
create policy rx_insert_doctor  on prescriptions for insert with check (doctor_id = public.my_doctor_id() and status = 'draft');
create policy rx_update_draft   on prescriptions for update using (doctor_id = public.my_doctor_id() and status = 'draft') with check (doctor_id = public.my_doctor_id() and status = 'draft');
create policy rx_select_patient on prescriptions for select using (status = 'final' and patient_id in (select public.my_patient_ids()));
create policy rx_select_admin   on prescriptions for select using (public.staff_ok('admin'));

create policy rx_items_select on prescription_items for select using (exists (select 1 from prescriptions p where p.id = prescription_id));  -- inherits prescriptions RLS
create policy rx_items_write  on prescription_items for all
  using (exists (select 1 from prescriptions p where p.id = prescription_id and p.doctor_id = public.my_doctor_id() and p.status = 'draft'))
  with check (exists (select 1 from prescriptions p where p.id = prescription_id and p.doctor_id = public.my_doctor_id() and p.status = 'draft'));

-- ---------------------------------------------------------------- engagement & support
create policy notifications_own       on notifications for select using (user_id = auth.uid());
create policy notifications_mark_read on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_outbox    on notifications for select using (public.staff_ok('admin', 'coordinator'));

create policy ratings_select on ratings for select using (public.can_see_appointment(appointment_id));
create policy ratings_insert on ratings for insert with check (
  patient_id in (select public.my_patient_ids())
  and exists (select 1 from appointments a where a.id = appointment_id and a.patient_id = ratings.patient_id and a.status = 'completed'));

create policy tickets_own    on support_tickets for select using (user_id = auth.uid());
create policy tickets_create on support_tickets for insert with check (user_id = auth.uid() and status = 'open');
create policy tickets_staff  on support_tickets for select using (public.staff_ok('admin', 'coordinator'));
create policy tickets_update on support_tickets for update using (public.staff_ok('admin', 'coordinator')) with check (public.staff_ok('admin', 'coordinator'));

-- ---------------------------------------------------------------- audit (append-only, admin read)
create policy audit_admin_read on audit_logs for select using (public.staff_ok('admin'));

-- ---------------------------------------------------------------- grants (RLS still applies on top)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on audit_logs from authenticated;
