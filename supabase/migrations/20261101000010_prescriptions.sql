-- =============================================================================
-- Phase 7: clinical notes + e-prescriptions.
--
--  * Notes: autosaved draft (save_consult_notes) incl. diagnoses checked against icd10_master (or a
--    clearly marked free-text provisional diagnosis). Final with the prescription, then locked.
--  * Templates: Sunrise templates (doctor_id null, from the seed) + each doctor's own.
--  * Drug rules: one verdict function used for search, drafts and finalisation, so the reason the
--    doctor sees is the reason the server enforces. Blocking = drug_rules (List O / A / B / Prohibited
--    × mode × first / follow-up, Telemedicine Practice Guidelines 2020), Schedule X / narcotics,
--    inactive drugs. Warnings (never blocking) = recorded allergies, basic interactions, duplicates.
--  * Finalise = signing PIN (bcrypt, 5 tries then 15 min lock) + uploaded signature → status final,
--    unique Rx number, verification code for the QR, doctor / patient / hospital snapshot. The row is
--    then immutable (trigger from 20261101000003); corrections are versioned addenda.
--  * Public verification returns only validity, doctor and date (service-only RPC behind the
--    rate-limited prescription-verify edge function).
-- =============================================================================

-- ---------------------------------------------------------------- reference data
create table drug_interactions (
  group_a text not null,
  group_b text not null,
  key text not null,
  primary key (group_a, group_b)
);
alter table drug_interactions enable row level security;
alter table drug_interactions force row level security;
create policy drug_interactions_read on drug_interactions for select to authenticated using (true);
create policy drug_interactions_admin on drug_interactions for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
insert into drug_interactions (group_a, group_b, key) values
  ('anticoagulant', 'nsaid', 'bleeding_nsaid'), ('anticoagulant', 'antiplatelet', 'bleeding_antiplatelet'), ('nsaid', 'nsaid', 'two_nsaids'),
  ('ace_inhibitor', 'potassium_sparing', 'hyperkalaemia'), ('ace_inhibitor', 'arb', 'dual_raas'), ('macrolide', 'statin', 'statin_myopathy'),
  ('ssri', 'triptan', 'serotonin_triptan'), ('ssri', 'tramadol', 'serotonin_tramadol'), ('qt_prolonging', 'qt_prolonging', 'qt'),
  ('sulfonylurea', 'fluoroquinolone', 'dysglycaemia'), ('ppi', 'clopidogrel', 'ppi_clopidogrel');

create table note_templates (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid references doctors (id) on delete cascade,   -- null = Sunrise template for everyone
  name text not null check (length(name) between 2 and 80),
  body jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index note_templates_doctor_idx on note_templates (doctor_id);
alter table note_templates enable row level security;
alter table note_templates force row level security;
create policy note_templates_read on note_templates for select using (doctor_id is null or doctor_id = public.my_doctor_id() or public.staff_ok('admin'));
create policy note_templates_admin on note_templates for all using (public.staff_ok('admin')) with check (public.staff_ok('admin'));
-- doctors write their own through save_note_template / delete_note_template

alter table doctors add column signature_updated_at timestamptz;

create sequence rx_no_seq;
alter table prescriptions
  add column rx_no text unique,
  add column doctor_snapshot jsonb,
  add column patient_snapshot jsonb,
  add column hospital_snapshot jsonb,
  add column updated_at timestamptz not null default now();
create index prescriptions_root_idx on prescriptions (coalesce(parent_prescription_id, id));

-- ---------------------------------------------------------------- helpers
create or replace function public.rx_doctor_snapshot(p_doctor uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', d.full_name, 'qualification', d.qualification, 'registration_no', d.registration_no,
                            'council', d.registration_council, 'department', dep.name)
    from doctors d join departments dep on dep.id = d.department_id where d.id = p_doctor;
$$;
create or replace function public.rx_patient_snapshot(p_patient uuid, p_at timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', p.full_name, 'gender', p.gender, 'mrn', p.his_mrn,
                            'age', extract(year from age((p_at at time zone 'Asia/Kolkata')::date, p.date_of_birth))::int)
    from patients p where p.id = p_patient;
$$;
create or replace function public.rx_hospital_snapshot(p_appt uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', h.name, 'city', h.city, 'address', h.address, 'phone', h.phone)
    from appointments a join hospitals h on h.id = a.hospital_id where a.id = p_appt;
$$;

-- Unique, human-readable number + snapshots, filled the moment a prescription becomes final
-- (also for the seed, which finalises with a plain update). Addenda: <root number>-A<n>.
create or replace function public.rx_on_finalize()
returns trigger language plpgsql security definer set search_path = public as $$
declare root_no text;
begin
  if old.status = 'draft' and new.status = 'final' then
    if new.parent_prescription_id is not null then
      select rx_no into root_no from prescriptions where id = new.parent_prescription_id;
    end if;
    new.rx_no := coalesce(new.rx_no, case when root_no is not null then root_no || '-A' || (new.version - 1)
      else 'SCRX-' || to_char(new.finalized_at at time zone 'Asia/Kolkata', 'YYMM') || '-' || lpad(nextval('rx_no_seq')::text, 6, '0') end);
    new.doctor_snapshot := coalesce(new.doctor_snapshot, public.rx_doctor_snapshot(new.doctor_id));
    new.patient_snapshot := coalesce(new.patient_snapshot, public.rx_patient_snapshot(new.patient_id, new.finalized_at));
    new.hospital_snapshot := coalesce(new.hospital_snapshot, public.rx_hospital_snapshot(new.appointment_id));
  end if;
  return new;
end $$;
create trigger rx_finalize_fill before update on prescriptions for each row execute function public.rx_on_finalize();

-- Final notes are locked too (they are the record the prescription was issued from).
create or replace function public.consultation_final_lock()
returns trigger language plpgsql as $$
begin
  if old.status = 'final' then raise exception 'notes_final'; end if;
  return coalesce(new, old);
end $$;
create trigger consultations_final_lock before update or delete on consultations for each row execute function public.consultation_final_lock();

/** [{code, description}] – ICD-10 codes resolved from the master (client text ignored), or a free-text
 *  provisional diagnosis {code: null, description}. At most 10. */
create or replace function public.normalize_diagnoses(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e jsonb; out jsonb := '[]'; m icd10_master; txt text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
  if jsonb_array_length(p) > 10 then raise exception 'too_many_diagnoses'; end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) = 'string' then e := jsonb_build_object('code', e #>> '{}'); end if;
    if nullif(e ->> 'code', '') is not null then
      select * into m from icd10_master where code = upper(trim(e ->> 'code'));
      if m.code is null then raise exception 'invalid_diagnosis'; end if;
      if not out @> jsonb_build_array(jsonb_build_object('code', m.code)) then
        out := out || jsonb_build_array(jsonb_build_object('code', m.code, 'description', m.description));
      end if;
    else
      txt := left(trim(regexp_replace(coalesce(e ->> 'description', ''), '\s+', ' ', 'g')), 120);
      if length(txt) < 2 then raise exception 'invalid_diagnosis'; end if;
      out := out || jsonb_build_array(jsonb_build_object('code', null, 'description', txt));
    end if;
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------- ICD-10 search
create or replace function public.search_icd10(p_q text)
returns setof icd10_master language sql stable set search_path = public, extensions as $$
  with q as (select trim(regexp_replace(coalesce(p_q, ''), '[%_\\]', '', 'g')) q)
  select m.* from icd10_master m, q
   where length(q.q) >= 2 and (m.code ilike q.q || '%' or m.description ilike '%' || q.q || '%' or similarity(m.description, q.q) > 0.3)
   order by (m.code ilike q.q || '%') desc, (m.description ilike q.q || '%') desc, similarity(m.description, q.q) desc, m.code
   limit 20;
$$;

-- ---------------------------------------------------------------- notes (now with diagnoses)
create or replace function public.save_consult_notes(p_appt uuid, p_notes jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare a appointments; c consultations; dx jsonb;
begin
  select * into a from appointments where id = p_appt and doctor_id = public.my_doctor_id();
  if a.id is null then raise exception 'not_found'; end if;
  select * into c from consultations where appointment_id = a.id;
  if c.status = 'final' then raise exception 'notes_final'; end if;
  dx := case when p_notes ? 'diagnoses' then public.normalize_diagnoses(p_notes -> 'diagnoses') else coalesce(c.diagnoses, '[]') end;
  insert into consultations (appointment_id, doctor_id, patient_id, chief_complaint, history, examination, diagnoses, advice, investigations, follow_up_date, updated_at)
  values (a.id, a.doctor_id, a.patient_id, left(coalesce(p_notes ->> 'chief_complaint', ''), 2000), left(coalesce(p_notes ->> 'history', ''), 4000),
          left(coalesce(p_notes ->> 'examination', ''), 4000), dx, left(coalesce(p_notes ->> 'advice', ''), 4000), left(coalesce(p_notes ->> 'investigations', ''), 2000),
          nullif(p_notes ->> 'follow_up_date', '')::date, now())
  on conflict (appointment_id) do update set
    chief_complaint = excluded.chief_complaint, history = excluded.history, examination = excluded.examination, diagnoses = excluded.diagnoses,
    advice = excluded.advice, investigations = excluded.investigations, follow_up_date = excluded.follow_up_date, updated_at = now();
  return now();
end $$;

-- ---------------------------------------------------------------- templates
create or replace function public.save_note_template(p_id uuid, p_name text, p_body jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare doc uuid := public.my_doctor_id(); t note_templates; body jsonb;
begin
  if doc is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'invalid_input'; end if;
  body := jsonb_build_object(
    'chief_complaint', left(coalesce(p_body ->> 'chief_complaint', ''), 2000), 'history', left(coalesce(p_body ->> 'history', ''), 4000),
    'examination', left(coalesce(p_body ->> 'examination', ''), 4000), 'advice', left(coalesce(p_body ->> 'advice', ''), 4000),
    'investigations', left(coalesce(p_body ->> 'investigations', ''), 2000), 'diagnoses', public.normalize_diagnoses(p_body -> 'diagnoses'));
  if p_id is not null then
    update note_templates set name = left(trim(p_name), 80), body = save_note_template.body, updated_at = now()
     where id = p_id and doctor_id = doc returning * into t;
    if t.id is null then raise exception 'not_found'; end if;
    return t.id;
  end if;
  if (select count(*) from note_templates where doctor_id = doc) >= 50 then raise exception 'too_many_templates'; end if;
  insert into note_templates (doctor_id, name, body) values (doc, left(trim(p_name), 80), body) returning * into t;
  return t.id;
end $$;

create or replace function public.delete_note_template(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from note_templates where id = p_id and doctor_id = public.my_doctor_id();
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------- drug rule engine
/** Allergies recorded for the booking: patient record + what was typed in the pre-consult form. */
create or replace function public.rx_allergies(a appointments)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct lower(trim(x))) filter (where length(trim(x)) >= 3), '{}')
    from (select unnest(p.allergies) x from patients p where p.id = a.patient_id
          union all
          select regexp_split_to_table(coalesce(s.allergies, ''), '[,;/\n]| and ') from appointment_symptoms s where s.appointment_id = a.id) t
   where lower(trim(x)) not in ('none', 'nil', 'no', 'nkda', 'no known allergies', 'na', 'n/a');
$$;

/**
 * One drug, in this consultation, next to the other drugs on the prescription.
 * reasons (blocking): inactive · schedule (X / narcotic) · prohibited · list (category not allowed for
 * this mode + consult type, with the admin's rule note). warnings: allergy · interaction · duplicate.
 */
create or replace function public.rx_drug_verdict(p_mode consult_mode, p_type consult_type, d drug_master, p_allergies text[], p_others text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare reasons jsonb := '[]'; warnings jsonb := '[]'; r drug_rules; o drug_master; al text; i drug_interactions;
begin
  if not d.active then reasons := reasons || jsonb_build_array(jsonb_build_object('code', 'inactive')); end if;
  if d.schedule in ('X', 'narcotic') then reasons := reasons || jsonb_build_array(jsonb_build_object('code', 'schedule', 'schedule', d.schedule)); end if;
  if d.category = 'prohibited' then
    reasons := reasons || jsonb_build_array(jsonb_build_object('code', 'prohibited'));
  else
    select * into r from drug_rules where category = d.category and mode = p_mode and consult_type = p_type;
    if r.id is null or not r.allowed then
      reasons := reasons || jsonb_build_array(jsonb_build_object('code', 'list', 'category', d.category, 'mode', p_mode, 'consult_type', p_type, 'note', coalesce(r.note, '')));
    end if;
  end if;

  foreach al in array coalesce(p_allergies, '{}') loop
    if (d.allergy_class is not null and (al like '%' || d.allergy_class || '%' or d.allergy_class like '%' || al || '%'))
       or lower(d.generic_name) like '%' || al || '%' or lower(d.name) like '%' || al || '%' then
      warnings := warnings || jsonb_build_array(jsonb_build_object('code', 'allergy', 'allergy', al));
      exit;
    end if;
  end loop;

  for o in select * from drug_master where id = any(coalesce(p_others, '{}')) order by name loop
    if o.id = d.id then
      warnings := warnings || jsonb_build_array(jsonb_build_object('code', 'duplicate'));
      continue;
    end if;
    for i in select * from drug_interactions x
              where (x.group_a = any(d.interaction_groups) and x.group_b = any(o.interaction_groups))
                 or (x.group_b = any(d.interaction_groups) and x.group_a = any(o.interaction_groups)) loop
      warnings := warnings || jsonb_build_array(jsonb_build_object('code', 'interaction', 'key', i.key, 'with', o.name));
    end loop;
  end loop;
  return jsonb_build_object('drug_id', d.id, 'name', d.name, 'category', d.category, 'schedule', d.schedule,
                            'blocked', jsonb_array_length(reasons) > 0, 'reasons', reasons, 'warnings', warnings);
end $$;

create or replace function public.rx_appointment(p_appt uuid)
returns appointments language plpgsql stable security definer set search_path = public as $$
declare a appointments;
begin
  select * into a from appointments where id = p_appt and doctor_id = public.my_doctor_id();
  if a.id is null then raise exception 'not_found'; end if;
  return a;
end $$;

/** Verdicts for the drugs on a prescription (each checked against all the others). */
create or replace function public.check_rx_drugs(p_appt uuid, p_drug_ids text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a appointments := public.rx_appointment(p_appt); al text[] := public.rx_allergies(a); out jsonb := '[]'; d drug_master; n int;
begin
  if coalesce(array_length(p_drug_ids, 1), 0) > 30 then raise exception 'invalid_input'; end if;
  for n in 1 .. coalesce(array_length(p_drug_ids, 1), 0) loop
    select * into d from drug_master where id = p_drug_ids[n];
    continue when d.id is null;
    out := out || jsonb_build_array(public.rx_drug_verdict(a.mode, a.consult_type, d, al,
                                     p_drug_ids[1:n - 1] || p_drug_ids[n + 1:]));
  end loop;
  return out;
end $$;

/** Drug search for the builder: matches with their verdict against the drugs already on the list. */
create or replace function public.search_rx_drugs(p_appt uuid, p_q text, p_current text[])
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare a appointments := public.rx_appointment(p_appt); al text[] := public.rx_allergies(a); q text := trim(regexp_replace(coalesce(p_q, ''), '[%_\\]', '', 'g'));
begin
  if length(q) < 2 then return '[]'; end if;
  return coalesce((
    select jsonb_agg(public.rx_drug_verdict(a.mode, a.consult_type, d.m, al, p_current) || jsonb_build_object(
             'generic_name', (d.m).generic_name, 'form', (d.m).form, 'strength', (d.m).strength, 'default_dose', (d.m).default_dose,
             'default_frequency', (d.m).default_frequency, 'default_route', (d.m).default_route) order by d.rank, d.name)
      from (select m, m.name, case when m.name ilike q || '%' then 0 when m.generic_name ilike q || '%' then 1 else 2 end rank
              from drug_master m
             where m.name ilike '%' || q || '%' or m.generic_name ilike '%' || q || '%' or similarity(m.name, q) > 0.35
             order by rank, m.name limit 15) d), '[]');
end $$;

-- ---------------------------------------------------------------- drafts and addenda
create or replace function public.rx_open_draft(p_appt uuid)
returns prescriptions language sql stable security definer set search_path = public as $$
  select * from prescriptions where appointment_id = p_appt and status = 'draft' order by version desc limit 1;
$$;

/**
 * Saves the draft's items (blocked drugs are refused with drug_blocked) and, for an addendum, its own
 * diagnoses / advice / investigations / follow-up (version 1 takes those from the notes when finalised).
 * Creates the version-1 draft on first use; after a final prescription exists, changes need an addendum.
 */
create or replace function public.save_rx_draft(p_appt uuid, p_items jsonb, p_fields jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a appointments := public.rx_appointment(p_appt); r prescriptions; al text[] := public.rx_allergies(a); e jsonb; d drug_master;
  ids text[]; v jsonb; n int := 0;
begin
  if a.status not in ('in_progress', 'completed') then raise exception 'rx_not_allowed'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then raise exception 'invalid_input'; end if;
  r := public.rx_open_draft(a.id);
  if r.id is null then
    if exists (select 1 from prescriptions where appointment_id = a.id and status = 'final') then raise exception 'use_addendum'; end if;
    perform set_config('app.audit_reason', 'Prescription draft started', true);
    insert into prescriptions (appointment_id, doctor_id, patient_id) values (a.id, a.doctor_id, a.patient_id) returning * into r;
  end if;

  select coalesce(array_agg(x ->> 'drug_id'), '{}') into ids from jsonb_array_elements(p_items) x;
  delete from prescription_items where prescription_id = r.id;
  for e in select * from jsonb_array_elements(p_items) loop
    select * into d from drug_master where id = e ->> 'drug_id';
    if d.id is null then raise exception 'invalid_input'; end if;
    v := public.rx_drug_verdict(a.mode, a.consult_type, d, al, ids[1:n] || ids[n + 2:]);
    if (v ->> 'blocked')::boolean then raise exception 'drug_blocked' using detail = d.id; end if;
    insert into prescription_items (prescription_id, drug_id, drug_name, strength, form, dose, frequency, duration, route, instructions, position)
    values (r.id, d.id, d.name, d.strength, d.form, left(coalesce(e ->> 'dose', ''), 60), left(coalesce(e ->> 'frequency', ''), 60),
            left(coalesce(e ->> 'duration', ''), 40), left(coalesce(nullif(e ->> 'route', ''), d.default_route), 30), left(coalesce(e ->> 'instructions', ''), 200), n);
    n := n + 1;
  end loop;

  if r.version > 1 and p_fields is not null then
    update prescriptions set diagnoses = public.normalize_diagnoses(p_fields -> 'diagnoses'), advice = left(coalesce(p_fields ->> 'advice', ''), 4000),
           investigations = left(coalesce(p_fields ->> 'investigations', ''), 2000), follow_up_date = nullif(p_fields ->> 'follow_up_date', '')::date
     where id = r.id;
  end if;
  update prescriptions set updated_at = now() where id = r.id returning * into r;
  return jsonb_build_object('id', r.id, 'version', r.version, 'updated_at', r.updated_at);
end $$;

/** Versioned addendum to the latest final version: a draft copy (items + fields) with a reason. */
create or replace function public.start_addendum(p_rx uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r prescriptions; root uuid; latest int; n prescriptions;
begin
  select * into r from prescriptions where id = p_rx and doctor_id = public.my_doctor_id() and status = 'final';
  if r.id is null then raise exception 'not_found'; end if;
  root := coalesce(r.parent_prescription_id, r.id);
  select max(version) into latest from prescriptions where coalesce(parent_prescription_id, id) = root;
  select * into n from prescriptions where coalesce(parent_prescription_id, id) = root and status = 'draft';
  if n.id is not null then return n.id; end if;   -- an addendum is already open
  if r.version <> latest then raise exception 'not_latest'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  perform set_config('app.audit_reason', 'Addendum: ' || left(trim(p_reason), 150), true);
  insert into prescriptions (appointment_id, doctor_id, patient_id, version, parent_prescription_id, addendum_reason, advice, investigations, follow_up_date, diagnoses)
  values (r.appointment_id, r.doctor_id, r.patient_id, latest + 1, root, left(trim(p_reason), 300), r.advice, r.investigations, r.follow_up_date, r.diagnoses)
  returning * into n;
  insert into prescription_items (prescription_id, drug_id, drug_name, strength, form, dose, frequency, duration, route, instructions, position)
  select n.id, drug_id, drug_name, strength, form, dose, frequency, duration, route, instructions, position from prescription_items where prescription_id = r.id;
  return n.id;
end $$;

create or replace function public.discard_rx_draft(p_rx uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.audit_reason', 'Prescription draft discarded', true);
  delete from prescriptions where id = p_rx and doctor_id = public.my_doctor_id() and status = 'draft';
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------- signing PIN + signature
/** Checks the caller's signing PIN WITHOUT raising (a raise would roll back the failure counter). */
create or replace function public.check_signing_pin(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s doctor_secrets;
begin
  select * into s from doctor_secrets where profile_id = auth.uid() for update;
  if s.profile_id is null then return jsonb_build_object('ok', false, 'error', 'pin_not_set'); end if;
  if s.locked_until > now() then return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', s.locked_until); end if;
  if p_pin ~ '^\d{4,6}$' and crypt(p_pin, s.pin_hash) = s.pin_hash then
    update doctor_secrets set failed_attempts = 0, locked_until = null where profile_id = s.profile_id;
    return jsonb_build_object('ok', true);
  end if;
  if s.failed_attempts + 1 >= 5 then
    update doctor_secrets set failed_attempts = 0, locked_until = now() + interval '15 minutes' where profile_id = s.profile_id;
    return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', now() + interval '15 minutes');
  end if;
  update doctor_secrets set failed_attempts = failed_attempts + 1 where profile_id = s.profile_id;
  return jsonb_build_object('ok', false, 'error', 'pin_wrong', 'attempts_left', 4 - s.failed_attempts);
end $$;

create or replace function public.signing_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('pin_set', s.profile_id is not null, 'locked_until', case when s.locked_until > now() then s.locked_until end,
                            'signature_updated_at', d.signature_updated_at)
    from doctors d left join doctor_secrets s on s.profile_id = d.profile_id where d.id = public.my_doctor_id();
$$;

/** Set (first time) or change the signing PIN; changing needs the current PIN. Returns {ok, error?}. */
create or replace function public.set_signing_pin(p_current text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare chk jsonb;
begin
  if public.my_doctor_id() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_new, '') !~ '^\d{4,6}$' then raise exception 'pin_format'; end if;
  if p_new ~ '^(\d)\1+$' or p_new in ('1234', '12345', '123456', '4321', '654321') then raise exception 'pin_weak'; end if;
  if exists (select 1 from doctor_secrets where profile_id = auth.uid()) then
    chk := public.check_signing_pin(p_current);
    if not (chk ->> 'ok')::boolean then return chk; end if;
  end if;
  perform set_config('app.audit_reason', 'Signing PIN set', true);
  insert into doctor_secrets (profile_id, pin_hash) values (auth.uid(), crypt(p_new, gen_salt('bf', 8)))
  on conflict (profile_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null;
  return jsonb_build_object('ok', true);
end $$;

/** For the doctor-signature edge function (as the user): PIN check without raising. */
create or replace function public.verify_signing_pin(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.my_doctor_id() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return public.check_signing_pin(p_pin);
end $$;

/** Service (doctor-signature edge function, after it stored the PNG). */
create or replace function public.record_signature(p_doctor uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.audit_reason', 'Signature uploaded', true);
  update doctors set signature_updated_at = now(), signature_url = 'signatures/' || p_doctor || '.png' where id = p_doctor;
end $$;

-- ---------------------------------------------------------------- finalise and lock
create or replace function public.finalize_prescription(p_rx uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r prescriptions; a appointments; c consultations; chk jsonb; al text[]; it prescription_items; d drug_master; ids text[]; v jsonb; code text; n int := 0;
begin
  select * into r from prescriptions where id = p_rx and doctor_id = public.my_doctor_id() for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.status = 'final' then raise exception 'already_final'; end if;
  select * into a from appointments where id = r.appointment_id;
  if a.status not in ('in_progress', 'completed') then raise exception 'rx_not_allowed'; end if;
  if (select signature_updated_at from doctors where id = r.doctor_id) is null then raise exception 'signature_missing'; end if;

  if r.version = 1 then
    select * into c from consultations where appointment_id = a.id;
    if c.id is null then raise exception 'notes_missing'; end if;
    r.diagnoses := c.diagnoses; r.advice := c.advice; r.investigations := c.investigations; r.follow_up_date := c.follow_up_date;
  end if;
  if jsonb_array_length(r.diagnoses) = 0 then raise exception 'diagnosis_required'; end if;
  if not exists (select 1 from prescription_items where prescription_id = r.id) and trim(r.advice) = '' and trim(r.investigations) = '' then
    raise exception 'rx_empty';
  end if;

  -- rules may have changed since the draft was saved: check every drug again
  al := public.rx_allergies(a);
  select coalesce(array_agg(drug_id order by position), '{}') into ids from prescription_items where prescription_id = r.id;
  for it in select * from prescription_items where prescription_id = r.id order by position loop
    select * into d from drug_master where id = it.drug_id;
    v := public.rx_drug_verdict(a.mode, a.consult_type, d, al, ids[1:n] || ids[n + 2:]);
    if (v ->> 'blocked')::boolean then raise exception 'drug_blocked' using detail = d.id; end if;
    n := n + 1;
  end loop;

  -- signature last: a wrong PIN returns (and keeps the attempt counter) instead of raising
  chk := public.check_signing_pin(p_pin);
  if not (chk ->> 'ok')::boolean then return chk; end if;

  loop
    code := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(b, i) % 32) + 1, 1), '')
               from (select gen_random_bytes(10) b) x, generate_series(0, 9) i);
    exit when not exists (select 1 from prescriptions where verification_code = code);
  end loop;
  perform set_config('app.audit_reason', case when r.version = 1 then 'Prescription signed and finalised' else 'Addendum v' || r.version || ' signed and finalised' end, true);
  update prescriptions set status = 'final', verification_code = code, finalized_at = now(), updated_at = now(),
         diagnoses = r.diagnoses, advice = r.advice, investigations = r.investigations, follow_up_date = r.follow_up_date
   where id = r.id returning * into r;
  if c.id is not null then
    update consultations set status = 'final', updated_at = now() where id = c.id;
  end if;
  perform public.notify_user(a.booked_by_user_id, 'prescription_ready', jsonb_build_object('ref', a.ref_code, 'link', '/p/records'),
                             'Your consultation summary for ' || a.ref_code || ' is ready. View securely in the app.', '/p/records/' || r.id);
  return jsonb_build_object('ok', true, 'id', r.id, 'rx_no', r.rx_no, 'verification_code', r.verification_code, 'version', r.version);
end $$;

-- ---------------------------------------------------------------- public verification + PDF data (service only)
create or replace function public.verify_prescription(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r prescriptions; latest int;
begin
  select * into r from prescriptions where verification_code = upper(trim(coalesce(p_code, ''))) and status = 'final';
  if r.id is null then return jsonb_build_object('status', 'not_found'); end if;
  select max(version) into latest from prescriptions where coalesce(parent_prescription_id, id) = coalesce(r.parent_prescription_id, r.id) and status = 'final';
  return jsonb_build_object(
    'status', case when r.version < latest then 'superseded' else 'valid' end,
    'doctor', r.doctor_snapshot ->> 'name', 'registration_no', r.doctor_snapshot ->> 'registration_no', 'council', r.doctor_snapshot ->> 'council',
    'issued_at', r.finalized_at);
end $$;

create or replace function public.rx_pdf_payload(p_rx uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r prescriptions; a appointments; root prescriptions; latest int;
begin
  select * into r from prescriptions where id = p_rx;
  if r.id is null then raise exception 'not_found'; end if;
  select * into a from appointments where id = r.appointment_id;
  if r.parent_prescription_id is not null then select * into root from prescriptions where id = r.parent_prescription_id; end if;
  select max(version) into latest from prescriptions where coalesce(parent_prescription_id, id) = coalesce(r.parent_prescription_id, r.id) and status = 'final';
  return jsonb_build_object(
    'id', r.id, 'status', r.status, 'version', r.version, 'rx_no', r.rx_no, 'verification_code', r.verification_code, 'finalized_at', r.finalized_at,
    'created_at', r.created_at, 'addendum_reason', r.addendum_reason, 'parent_rx_no', root.rx_no, 'superseded', r.status = 'final' and r.version < latest,
    'doctor_id', r.doctor_id, 'pdf_path', r.pdf_path,
    'doctor', coalesce(r.doctor_snapshot, public.rx_doctor_snapshot(r.doctor_id)),
    'patient', coalesce(r.patient_snapshot, public.rx_patient_snapshot(r.patient_id, now())),
    'hospital', coalesce(r.hospital_snapshot, public.rx_hospital_snapshot(r.appointment_id)),
    'consult', jsonb_build_object('ref', a.ref_code, 'mode', a.mode, 'consult_type', a.consult_type, 'start_at', a.start_at),
    -- a draft version 1 previews the current notes
    'diagnoses', case when r.status = 'draft' and r.version = 1 then coalesce((select diagnoses from consultations where appointment_id = a.id), '[]') else r.diagnoses end,
    'advice', case when r.status = 'draft' and r.version = 1 then coalesce((select advice from consultations where appointment_id = a.id), '') else r.advice end,
    'investigations', case when r.status = 'draft' and r.version = 1 then coalesce((select investigations from consultations where appointment_id = a.id), '') else r.investigations end,
    'follow_up_date', case when r.status = 'draft' and r.version = 1 then (select follow_up_date from consultations where appointment_id = a.id) else r.follow_up_date end,
    'items', coalesce((select jsonb_agg(jsonb_build_object('drug_name', i.drug_name, 'generic_name', m.generic_name, 'strength', i.strength, 'form', i.form,
                         'dose', i.dose, 'frequency', i.frequency, 'duration', i.duration, 'route', i.route, 'instructions', i.instructions) order by i.position)
                         from prescription_items i join drug_master m on m.id = i.drug_id where i.prescription_id = r.id), '[]'));
end $$;

create or replace function public.set_rx_pdf_path(p_rx uuid, p_path text)
returns void language sql security definer set search_path = public as $$
  update prescriptions set pdf_path = p_path where id = p_rx and status = 'final' and pdf_path is null;
$$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.rx_doctor_snapshot, public.rx_patient_snapshot, public.rx_hospital_snapshot, public.rx_on_finalize,
  public.normalize_diagnoses, public.rx_allergies, public.rx_drug_verdict, public.rx_appointment, public.rx_open_draft, public.check_signing_pin,
  public.record_signature, public.verify_prescription, public.rx_pdf_payload, public.set_rx_pdf_path
  from public, anon, authenticated;
grant execute on function public.record_signature, public.verify_prescription, public.rx_pdf_payload, public.set_rx_pdf_path to service_role;
revoke execute on function public.search_icd10, public.save_note_template, public.delete_note_template, public.check_rx_drugs, public.search_rx_drugs,
  public.save_rx_draft, public.start_addendum, public.discard_rx_draft, public.signing_status, public.set_signing_pin, public.finalize_prescription,
  public.verify_signing_pin
  from public, anon;
grant execute on function public.search_icd10, public.save_note_template, public.delete_note_template, public.check_rx_drugs, public.search_rx_drugs,
  public.save_rx_draft, public.start_addendum, public.discard_rx_draft, public.signing_status, public.set_signing_pin, public.finalize_prescription,
  public.verify_signing_pin
  to authenticated;

-- rate-limit counters: only SECURITY DEFINER functions (as owner) and edge functions (service) may touch them;
-- a client could otherwise exhaust another user's quota (e.g. chat:<their id>)
revoke execute on function public.check_rate_limit from public, anon, authenticated;
grant execute on function public.check_rate_limit to service_role;
grant select, insert, update, delete on drug_interactions, note_templates to authenticated;   -- RLS decides (admin writes)

-- direct writes to drafts go through the RPCs above (rule checks); reads stay on RLS
drop policy if exists rx_insert_doctor on prescriptions;
drop policy if exists rx_update_draft on prescriptions;
drop policy if exists rx_items_write on prescription_items;
