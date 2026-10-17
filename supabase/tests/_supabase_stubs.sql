-- Supabase stand-ins for plain Postgres (tests only, not a migration): auth schema, auth.uid() from the test.uid setting,
-- the anon/authenticated roles, default grants and the supabase_realtime publication. Used by run.sh.
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to anon, authenticated;
grant select on auth.users to authenticated;
-- Supabase grants table/sequence privileges in public to the API roles by default.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
set client_min_messages = error;
create publication supabase_realtime;
