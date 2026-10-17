-- Bò Mỹ Đen: chạy một lần trong SQL Editor của dự án bomyden-pos-thu (lvwxotfkoiehvkcybakk), sau khi đã có 0001–0006.
-- 0007 phần 2: bỏ quyền chạy hàm của vai trò anon (chưa đăng nhập). Phần 1 của 0007 đã được áp dụng.

-- ---------------------------------------------------------------- part 2 (REVOKE only)

-- Functions run through PUBLIC's default execute right, which anon inherits. Each function that authenticated may run
-- today gets an explicit grant to authenticated, then PUBLIC and anon lose it. Functions already closed to authenticated
-- (the _internal ones, admin_*) stay closed. service_role and the owner keep theirs.
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' loop
    if has_function_privilege('authenticated', f, 'execute') then
      execute format('grant execute on function %s to authenticated', f);
    end if;
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end $$;
-- Functions added later by Supabase's default grants: not to anon. (New migrations still revoke PUBLIC themselves,
-- as 0006 does.)
alter default privileges in schema public revoke execute on functions from anon;
