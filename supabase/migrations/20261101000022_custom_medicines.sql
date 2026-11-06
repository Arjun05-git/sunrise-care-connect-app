-- =============================================================================
-- Custom medicines (hardening phase 10).
--
-- A doctor can add a medicine that is not in the catalogue. The rule engine (List O / A / B / Prohibited, schedule,
-- interactions) cannot judge a medicine it does not know, so this is built to be safe:
--   * the SERVER refuses any custom name that matches a catalogue medicine (by ingredient word, tolerant of spelling
--     slips; dose-form words like "syrup" or "tablet" do not count), so a restricted drug cannot be retyped as "custom";
--   * every custom line must be acknowledged by the doctor before the prescription can be signed, and is re-checked then;
--   * allergies are still checked by name (a warning, as for catalogue medicines);
--   * custom lines are flagged in the data (is_custom), printed on the prescription, kept in addenda, and listed for
--     admins (admin_custom_medicines) so frequently used ones can be added to the catalogue with a proper category;
--   * the hospital can switch the feature off with app_settings.allow_custom_medicines = false (missing = allowed).
--   * app_settings.custom_medicine_mode = 'direct' (the DEMO seed sets it) drops the catalogue match and the acknowledgement: the
--     typed medicine is added as typed. Anything else (including missing) is the checked behaviour above.
-- Catalogue medicines work exactly as before.
-- =============================================================================

-- ---------------------------------------------------------------- the table keeps the two kinds apart
alter table prescription_items alter column drug_id drop not null;
alter table prescription_items
  add column is_custom boolean not null default false,
  add column generic_name text not null default '',          -- custom lines only: what the doctor typed (catalogue lines use the master)
  add column custom_acknowledged boolean not null default false;
alter table prescription_items add constraint prescription_items_custom_chk
  check ((is_custom and drug_id is null) or (not is_custom and drug_id is not null));

-- ---------------------------------------------------------------- the mode
/**
 * app_settings.custom_medicine_mode:
 *   'checked' (default, also when the setting is missing)  the safe behaviour for real use: the catalogue-match guard below and
 *                                                           the doctor's acknowledgement before signing
 *   'direct'  (the demo seed sets this)                      the typed medicine is added exactly as typed: no catalogue match,
 *                                                           no acknowledgement. Saving, signing, printing and addenda work the same.
 * The name is still sanity-checked and allow_custom_medicines still switches the feature off in both modes.
 */
create or replace function public.custom_medicine_direct()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.setting('custom_medicine_mode') = '"direct"'::jsonb, false);
$$;

-- ---------------------------------------------------------------- the guard
/** The catalogue medicine a custom name matches (by ingredient word), or an all-null row. Internal. */
create or replace function public.rx_custom_match(p_name text)
returns drug_master language plpgsql stable security definer set search_path = public, extensions as $$
declare toks text[]; t text; m drug_master;
  -- words that describe the dose form or are shared by many drugs: they are not an ingredient
  stop text[] := array['tablet', 'tablets', 'capsule', 'capsules', 'syrup', 'ointment', 'cream', 'gel', 'spray', 'nasal', 'drops', 'drop', 'injection',
                       'suspension', 'solution', 'lotion', 'powder', 'sachet', 'oral', 'topical', 'forte', 'plus', 'acid', 'sodium', 'potassium',
                       'hydrochloride', 'phosphate', 'sulphate', 'sulfate', 'extended', 'release', 'cough', 'eye', 'ear', 'with', 'and', 'vitamin', 'vitamins'];
begin
  toks := array(select distinct w from regexp_split_to_table(lower(coalesce(p_name, '')), '[^a-z]+') w where length(w) >= 3 and w <> all(stop));
  foreach t in array toks loop
    select x.* into m from drug_master x
     where exists (select 1 from regexp_split_to_table(lower(x.name || ' ' || x.generic_name), '[^a-z]+') k
                    where length(k) >= 3 and k <> all(stop) and (k = t or (length(t) >= 6 and length(k) >= 6 and similarity(k, t) >= 0.55)))
     order by x.active desc, x.name limit 1;
    if m.id is not null then return m; end if;
  end loop;
  return null;
end $$;

/** ok / code (custom_disabled | custom_invalid | use_catalogue_entry) / the catalogue match / allergy warnings. Internal. */
create or replace function public.rx_custom_verdict(p_name text, p_generic text, p_allergies text[])
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare nm text := trim(coalesce(p_name, '')); gn text := trim(coalesce(p_generic, '')); m drug_master; warnings jsonb := '[]'; al text;
  direct boolean := public.custom_medicine_direct(); md text := case when public.custom_medicine_direct() then 'direct' else 'checked' end;
begin
  if not coalesce((public.setting('allow_custom_medicines'))::boolean, true) then
    return jsonb_build_object('ok', false, 'code', 'custom_disabled', 'mode', md, 'match', null, 'warnings', '[]'::jsonb);
  end if;
  if length(nm) < 2 or length(nm) > 80 or length(gn) > 120 or nm ~ '[[:cntrl:]<>{}\\]' or gn ~ '[[:cntrl:]<>{}\\]' then
    return jsonb_build_object('ok', false, 'code', 'custom_invalid', 'mode', md, 'match', null, 'warnings', '[]'::jsonb);
  end if;
  if not direct then m := public.rx_custom_match(nm || ' ' || gn); end if;   -- direct (demo): added exactly as typed
  if m.id is not null then
    return jsonb_build_object('ok', false, 'code', 'use_catalogue_entry', 'mode', md, 'warnings', '[]'::jsonb,
      'match', jsonb_build_object('drug_id', m.id, 'name', m.name, 'generic_name', m.generic_name, 'category', m.category, 'schedule', m.schedule));
  end if;
  foreach al in array coalesce(p_allergies, '{}') loop
    if lower(nm || ' ' || gn) like '%' || al || '%' then
      warnings := warnings || jsonb_build_array(jsonb_build_object('code', 'allergy', 'allergy', al));
      exit;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'code', null, 'mode', md, 'match', null, 'warnings', warnings);
end $$;

/** What the "add a medicine that is not in the list" dialog asks before adding it. */
create or replace function public.check_custom_medicine(p_appt uuid, p_name text, p_generic text default '')
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare a appointments := public.rx_appointment(p_appt);
begin
  return public.rx_custom_verdict(p_name, p_generic, public.rx_allergies(a));
end $$;

/** Admin review: which custom medicines are being used (final prescriptions only), how often, by how many doctors. No patient data. */
create or replace function public.admin_custom_medicines(p_days int default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_ok('admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(g.x order by (g.x ->> 'uses')::int desc, g.x ->> 'name')
      from (select jsonb_build_object('name', min(i.drug_name), 'generic_name', min(i.generic_name), 'strength', min(i.strength), 'form', min(i.form),
                                      'uses', count(*), 'doctors', count(distinct p.doctor_id), 'last_used', max(p.finalized_at)) x
              from prescription_items i join prescriptions p on p.id = i.prescription_id
             where i.is_custom and p.status = 'final' and p.finalized_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 3650)))
             group by lower(trim(i.drug_name)), lower(trim(i.strength)), lower(trim(i.form))) g), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- the existing functions, made custom-aware (taken from the live definitions)
CREATE OR REPLACE FUNCTION public.save_rx_draft(p_appt uuid, p_items jsonb, p_fields jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a appointments := public.rx_appointment(p_appt); r prescriptions; al text[] := public.rx_allergies(a); e jsonb; d drug_master; cv jsonb; custom_n int := 0;
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
    if coalesce(e -> 'custom' = 'true'::jsonb, false) then
      -- a medicine that is not in the catalogue: no rule engine can judge it, so the server refuses anything that
      -- matches a catalogue medicine (it would bypass the List O / A / B / Prohibited rules) and keeps the doctor's acknowledgement
      custom_n := custom_n + 1;
      if custom_n > 10 then raise exception 'too_many_custom'; end if;
      cv := public.rx_custom_verdict(e ->> 'name', e ->> 'generic_name', al);
      if cv ->> 'code' is not null then raise exception '%', cv ->> 'code' using detail = coalesce(cv -> 'match' ->> 'drug_id', ''); end if;
      insert into prescription_items (prescription_id, drug_id, is_custom, generic_name, custom_acknowledged, drug_name, strength, form, dose, frequency, duration, route, instructions, position)
      values (r.id, null, true, left(trim(coalesce(e ->> 'generic_name', '')), 120), coalesce(e -> 'acknowledged' = 'true'::jsonb, false), left(trim(e ->> 'name'), 80),
              left(trim(coalesce(e ->> 'strength', '')), 40), left(trim(coalesce(e ->> 'form', '')), 40), left(coalesce(e ->> 'dose', ''), 60), left(coalesce(e ->> 'frequency', ''), 60),
              left(coalesce(e ->> 'duration', ''), 40), left(coalesce(e ->> 'route', ''), 30), left(coalesce(e ->> 'instructions', ''), 200), n);
      n := n + 1;
      continue;
    end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.start_addendum(p_rx uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  insert into prescription_items (prescription_id, drug_id, is_custom, generic_name, custom_acknowledged, drug_name, strength, form, dose, frequency, duration, route, instructions, position)
  select n.id, drug_id, is_custom, generic_name, custom_acknowledged, drug_name, strength, form, dose, frequency, duration, route, instructions, position from prescription_items where prescription_id = r.id;
  return n.id;
end $function$;

CREATE OR REPLACE FUNCTION public.finalize_prescription(p_rx uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r prescriptions; a appointments; c consultations; chk jsonb; al text[]; it prescription_items; d drug_master; ids text[]; v jsonb; code text; n int := 0; cv jsonb;
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
    if it.is_custom then
      -- signing is the doctor's own check of a medicine the rule engine cannot judge: it must be acknowledged, and it must
      -- still not match a catalogue medicine (the catalogue may have grown since the draft was saved)
      if not it.custom_acknowledged and not public.custom_medicine_direct() then raise exception 'custom_not_acknowledged'; end if;
      cv := public.rx_custom_verdict(it.drug_name, it.generic_name, al);
      if cv ->> 'code' is not null then raise exception '%', cv ->> 'code'; end if;
      n := n + 1;
      continue;
    end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.rx_pdf_payload(p_rx uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'items', coalesce((select jsonb_agg(jsonb_build_object('drug_name', i.drug_name, 'generic_name', coalesce(m.generic_name, i.generic_name, ''), 'custom', i.is_custom, 'strength', i.strength, 'form', i.form,
                         'dose', i.dose, 'frequency', i.frequency, 'duration', i.duration, 'route', i.route, 'instructions', i.instructions) order by i.position)
                         from prescription_items i left join drug_master m on m.id = i.drug_id where i.prescription_id = r.id), '[]'));
end $function$;

-- ---------------------------------------------------------------- privileges
revoke execute on function public.custom_medicine_direct(), public.rx_custom_match(text), public.rx_custom_verdict(text, text, text[]),
  public.check_custom_medicine(uuid, text, text), public.admin_custom_medicines(int) from public, anon, authenticated;
grant execute on function public.check_custom_medicine(uuid, text, text), public.admin_custom_medicines(int) to authenticated;
grant execute on function public.custom_medicine_direct(), public.rx_custom_match(text), public.rx_custom_verdict(text, text, text[]),
  public.check_custom_medicine(uuid, text, text), public.admin_custom_medicines(int) to service_role;
