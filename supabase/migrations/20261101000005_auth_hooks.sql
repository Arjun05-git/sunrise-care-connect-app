-- =============================================================================
-- New auth users get a profile + patient role automatically (phone OTP sign-up).
-- Doctors / staff are pre-provisioned by admins (role rows inserted by admin tooling).
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, phone, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), case when new.phone is null or new.phone = '' then null else '+' || ltrim(new.phone, '+') end, new.email)
  on conflict (id) do nothing;
  if not exists (select 1 from user_roles where user_id = new.id) then
    insert into user_roles (user_id, role) values (new.id, 'patient');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Realtime: let clients subscribe to changes they can already read via RLS.
alter publication supabase_realtime add table appointments, reschedule_requests, chat_messages, notifications;
