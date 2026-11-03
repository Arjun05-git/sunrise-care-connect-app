-- LOCAL DEVELOPMENT ONLY (not a migration): feeds scripts/local-stack/realtime.ts, which emulates
-- Supabase Realtime postgres_changes. Every table in the supabase_realtime publication NOTIFYs its changes.
create or replace function public.local_realtime_notify()
returns trigger language plpgsql as $$
begin
  perform pg_notify('scc_realtime', json_build_object(
    'table', tg_table_name, 'type', tg_op,
    'record', case when tg_op <> 'DELETE' then row_to_json(new) end,
    'old_record', case when tg_op <> 'INSERT' then json_build_object('id', old.id) end)::text);
  return null;
end $$;

do $$
declare t record;
begin
  for t in select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' loop
    execute format('drop trigger if exists local_realtime on public.%I', t.tablename);
    execute format('create trigger local_realtime after insert or update or delete on public.%I for each row execute function public.local_realtime_notify()', t.tablename);
  end loop;
end $$;
