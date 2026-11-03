-- Minimal stand-in for the Supabase-managed schemas so migrations + tests run on plain PostgreSQL
-- (CI, or a laptop without Docker). NEVER run this against a Supabase project – it already has these.
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table auth.users (instance_id uuid, id uuid primary key, aud text, role text, email text, phone text, encrypted_password text,
  email_confirmed_at timestamptz, phone_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz,
  confirmation_token text, recovery_token text, email_change_token_new text, email_change text, email_change_token_current text,
  phone_change text, phone_change_token text, reauthentication_token text, last_sign_in_at timestamptz);
create table auth.mfa_factors (id uuid primary key, user_id uuid, status text);
-- Same definitions Supabase uses: claims come from PostgREST's request.jwt.claims.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated;
