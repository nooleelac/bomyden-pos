-- Bò Mỹ Đen POS 0035: Cài đặt → Giao diện, one set of colours per branch.
--
--   branches.theme     { preset, accent, bg, bar, card? } (lower-case #rrggbb; card = tables, orders, tickets, boxes,
--                      missing = worked out from bg; the colours worked out from them in src/theme/theme.ts);
--                      null = the default bright look
--   my_branch()        now also returns 'theme', so every device of the branch reads it when someone signs in, and
--                      again on any change of branches (realtime, already published; AuthGate re-reads my_branch)
--   set_branch_theme   settings.edit: set or clear (null) the caller's branch colours; written to the audit log
--
-- Each device also keeps the last theme it saw (localStorage), so the sign-in screen and a slow start are already in
-- the branch's colours.

alter table branches add column theme jsonb
  check (theme is null or (jsonb_typeof(theme) = 'object'
         and theme->>'accent' ~ '^#[0-9a-f]{6}$' and theme->>'bg' ~ '^#[0-9a-f]{6}$' and theme->>'bar' ~ '^#[0-9a-f]{6}$'
         and (theme->>'card' is null or theme->>'card' ~ '^#[0-9a-f]{6}$')
         and theme->>'preset' ~ '^[a-z-]{1,20}$'));

create or replace function my_branch() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'name', b.name, 'active', b.active,
                            'device_branch_id', (select d.branch_id from devices d where d.user_id = auth.uid() and d.active),
                            'can_switch', coalesce(my_real_role() = 'owner', false),
                            'is_open', branch_is_open(),
                            'theme', b.theme)
    from branches b where b.id = my_branch_id()
$$;

create function set_branch_theme(p_theme jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  perform _need('settings.edit');
  if p_theme is not null and jsonb_typeof(p_theme) <> 'null' then
    v := jsonb_strip_nulls(jsonb_build_object('preset', lower(p_theme->>'preset'), 'accent', lower(p_theme->>'accent'),
                                              'bg', lower(p_theme->>'bg'), 'bar', lower(p_theme->>'bar'),
                                              'card', lower(p_theme->>'card')));
    if not (coalesce(v->>'accent' ~ '^#[0-9a-f]{6}$' and v->>'bg' ~ '^#[0-9a-f]{6}$' and v->>'bar' ~ '^#[0-9a-f]{6}$'
                     and v->>'preset' ~ '^[a-z-]{1,20}$', false)
            and (v->>'card' is null or v->>'card' ~ '^#[0-9a-f]{6}$')) then
      raise exception 'Màu không hợp lệ (dạng #1a2b3c)';
    end if;
  end if;
  update branches set theme = v where id = my_branch_id();
  perform _audit('branch_theme', coalesce(v, '{}'::jsonb));
end $$;

revoke execute on function set_branch_theme(jsonb) from public, anon;
grant execute on function set_branch_theme(jsonb) to authenticated;
