-- =============================================================================
-- Audit log: who, what, when, before & after – for every sensitive table.
--
--  * One generic trigger function, attached per table with an optional list of columns to
--    redact (clinical free text is replaced by "[redacted]" so the log itself holds minimal PHI).
--  * UPDATE stores only the columns that changed (before/after diff); no-op updates are skipped.
--  * Reason: callers set `set local app.audit_reason = '…'` in the same transaction
--    (admin overrides, refunds etc. make this mandatory in the RPC layer).
--  * audit_logs is append-only: UPDATE/DELETE/TRUNCATE are blocked by trigger for every role,
--    except a retention job that explicitly sets app.audit_purge = 'on'.
-- =============================================================================

create or replace function public.audit_actor_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role::text from user_roles where user_id = auth.uid()
      order by case role when 'admin' then 0 when 'finance' then 1 when 'coordinator' then 2 when 'doctor' then 3 else 4 end limit 1),
    case when auth.uid() is null then 'system' else 'unknown' end);
$$;

-- Explicit entry point for application code (RPCs / edge functions).
create or replace function public.write_audit(p_action text, p_entity text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (actor_user_id, actor_role, action, entity, entity_id, before, after, reason)
  values (auth.uid(), public.audit_actor_role(), p_action, p_entity, p_entity_id, p_before, p_after,
          coalesce(p_reason, nullif(current_setting('app.audit_reason', true), '')));
end $$;
revoke execute on function public.write_audit from anon;

-- Generic row trigger. TG_ARGV = columns to redact.
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  b jsonb;
  a jsonb;
  col text;
  k text;
  row_id text;
begin
  -- redact sensitive free-text columns
  foreach col in array coalesce(tg_argv, '{}'::text[]) loop
    if o ? col and o ->> col is not null then o := jsonb_set(o, array[col], '"[redacted]"'); end if;
    if n ? col and n ->> col is not null then n := jsonb_set(n, array[col], '"[redacted]"'); end if;
  end loop;

  if tg_op = 'UPDATE' then
    b := '{}'; a := '{}';
    for k in select jsonb_object_keys(n) loop
      if (to_jsonb(old) -> k) is distinct from (to_jsonb(new) -> k) then
        b := b || jsonb_build_object(k, o -> k);
        a := a || jsonb_build_object(k, n -> k);
      end if;
    end loop;
    if a = '{}'::jsonb then return new; end if;     -- nothing changed
  else
    b := o; a := n;
  end if;

  row_id := coalesce(n ->> 'id', o ->> 'id', n ->> 'key', o ->> 'key', n ->> 'code', o ->> 'code',
                     n ->> 'appointment_id', o ->> 'appointment_id', n ->> 'user_id', o ->> 'user_id');

  insert into audit_logs (actor_user_id, actor_role, action, entity, entity_id, before, after, reason)
  values (auth.uid(), public.audit_actor_role(), tg_table_name || '.' || lower(tg_op), tg_table_name, row_id, b, a,
          nullif(current_setting('app.audit_reason', true), ''));
  return coalesce(new, old);
end $$;

-- Attach to sensitive tables: (table, columns to redact)
do $$
declare r record;
begin
  for r in select * from (values
    -- clinical
    ('appointments',        '{}'::text[]),
    ('consultations',       '{chief_complaint,history,examination,diagnoses,advice,investigations}'::text[]),
    ('prescriptions',       '{advice,investigations,diagnoses,addendum_reason}'::text[]),
    ('prescription_items',  '{instructions}'::text[]),
    ('documents',           '{file_name}'::text[]),
    ('reschedule_requests', '{}'::text[]),
    -- people & consent
    ('patients',            '{allergies,address}'::text[]),
    ('dependents',          '{}'::text[]),
    ('consents',            '{user_agent}'::text[]),
    ('data_requests',       '{note}'::text[]),
    ('user_roles',          '{}'::text[]),
    ('doctors',             '{}'::text[]),
    -- money
    ('payments',            '{}'::text[]),
    ('refunds',             '{}'::text[]),
    ('fee_config',          '{}'::text[]),
    -- configuration & masters
    ('follow_up_policy',    '{}'::text[]),
    ('app_settings',        '{}'::text[]),
    ('drug_rules',          '{}'::text[]),
    ('drug_master',         '{}'::text[]),
    ('notification_templates', '{}'::text[]),
    ('hospitals',           '{}'::text[]),
    ('departments',         '{}'::text[]),
    ('holidays',            '{}'::text[]),
    ('doctor_availability', '{}'::text[]),
    ('support_tickets',     '{description}'::text[])
  ) as t(tbl, redact) loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', r.tbl);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row_change(%2$s)',
                   r.tbl, (select coalesce(string_agg(quote_literal(c), ','), '') from unnest(r.redact) c));
  end loop;
end $$;

-- Append-only guard on audit_logs (applies even to the table owner).
create or replace function public.audit_logs_immutable()
returns trigger language plpgsql as $$
begin
  if current_setting('app.audit_purge', true) = 'on' and tg_op = 'DELETE' then return old; end if;
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_logs_no_update before update or delete on audit_logs for each row execute function public.audit_logs_immutable();
create trigger audit_logs_no_truncate before truncate on audit_logs for each statement execute function public.audit_logs_immutable();

-- Finalised prescriptions are immutable (corrections = versioned addendum). Only pdf_path may be filled in later.
create or replace function public.prescription_immutable()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'prescriptions' then
    if old.status = 'final' then
      if tg_op = 'DELETE' then raise exception 'prescription_immutable'; end if;
      if (to_jsonb(new) - 'pdf_path') is distinct from (to_jsonb(old) - 'pdf_path') then
        raise exception 'prescription_immutable' using hint = 'Create an addendum instead';
      end if;
    end if;
  elsif exists (select 1 from prescriptions p where p.id = coalesce(new.prescription_id, old.prescription_id) and p.status = 'final') then
    raise exception 'prescription_immutable';
  end if;
  return coalesce(new, old);
end $$;
create trigger rx_immutable before update or delete on prescriptions for each row execute function public.prescription_immutable();
create trigger rx_items_immutable before insert or update or delete on prescription_items for each row execute function public.prescription_immutable();
