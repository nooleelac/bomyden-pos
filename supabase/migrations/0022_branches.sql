-- Bò Mỹ Đen POS 0022: chi nhánh. Each branch has its own menu, tables, orders, bills, shifts, staff, devices,
-- printers, settings (receipt, payment, business day) and opening hours; the owner sees and runs every branch.
--
--   branches            id, name, active, sort. The data so far becomes the first branch.
--   branch_id           on every table of a branch (menu, floor, money, devices, printers, log), default my_branch_id(),
--                       and a restrictive RLS policy branch_only: a device reads and writes its branch's rows only
--   my_branch_id()      the branch the caller works in: the owner's choice for this session (switch_branch), else the
--                       device's branch (fixed by the code it was registered with). SQL editor: the first branch
--   staff.branch_id     everyone but the owner works at one branch; owners (branch_id null) sign in on any device
--   branch_settings     shop_settings renamed, one row per branch, plus opening_hours and enforce_hours. A view named
--                       shop_settings shows the caller's branch row, so the functions and screens reading
--                       shop_settings keep working unchanged
--   opening_hours       {"1": {"open": "07:00", "close": "22:00"}, …} by ISO weekday (1 = Monday); a missing day is
--                       closed, close <= open runs past midnight, {} = no hours set (always open)
--   enforce_hours       outside the hours only quản lý / chủ quán open tables or takeaway orders
--   business_day_start  (0004, now per branch) where reports and takeaway numbers start a day
--
-- RPCs: my_branch, branches_list, switch_branch, branch_save (owner: add, copying another branch's menu, rename, close),
-- branch_is_open; create_device_code takes the branch (owner). Uniques that were shop-wide are now per branch
-- (table names, station codes, dish and size codes, one open shift per register).

create table branches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create unique index branches_name on branches (lower(btrim(name)));
insert into branches (name) values ('Chi nhánh chính');

create function default_branch_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from branches order by sort, created_at, id limit 1
$$;

alter table staff_sessions add column branch_id uuid references branches on delete set null;   -- owner's switch_branch
alter table devices add column branch_id uuid references branches;
alter table device_codes add column branch_id uuid references branches;
update devices set branch_id = default_branch_id();
update device_codes set branch_id = default_branch_id();
alter table devices alter column branch_id set not null;
alter table device_codes alter column branch_id set not null;
alter table staff add column branch_id uuid references branches;
update staff set branch_id = default_branch_id() where role::text <> 'owner';
alter table staff add constraint staff_branch check ((role::text = 'owner') = (branch_id is null));

-- The caller's branch. app.branch_override is set (transaction-local) only inside branch_save while it fills a new
-- branch; PostgREST callers cannot set it.
create function my_branch_id() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_over text := nullif(current_setting('app.branch_override', true), '');
  v_d devices;
  v_tok text;
  v_b uuid;
begin
  if v_over is not null then return v_over::uuid; end if;
  if auth.uid() is null then
    return case when session_user <> 'authenticator' then default_branch_id() end;   -- SQL editor, migrations
  end if;
  select * into v_d from devices where user_id = auth.uid() and active;
  if found then
    -- this request's session (header), else the device's latest one (Realtime sends no header)
    v_tok := session_token_hash();
    select s.branch_id into v_b from staff_sessions s
     where s.device_id = v_d.id and s.ended_at is null and (s.expires_at is null or s.expires_at > now())
       and (v_tok is null or s.token_hash = v_tok)
     order by s.started_at desc limit 1;
    return coalesce(v_b, v_d.branch_id);
  end if;
  return (select coalesce(branch_id, default_branch_id()) from staff where user_id = auth.uid() and active);
end $$;

-- staff: the owner belongs to no branch; anyone else added or changed from owner joins the caller's branch
create function staff_branch_fill() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.role::text = 'owner' then
    new.branch_id := null;
  elsif new.branch_id is null then
    new.branch_id := my_branch_id();
  end if;
  return new;
end $$;
create trigger staff_branch_fill before insert or update of role, branch_id on staff for each row execute function staff_branch_fill();

-- ---------------------------------------------------------------- settings per branch

alter table shop_settings rename to branch_settings;
alter table branch_settings
  add column branch_id uuid not null default default_branch_id() references branches on delete cascade,
  add column opening_hours jsonb not null default '{}'::jsonb check (jsonb_typeof(opening_hours) = 'object'),
  add column enforce_hours boolean not null default false;
alter table branch_settings alter column branch_id set default my_branch_id();
alter table branch_settings drop constraint shop_settings_pkey, drop constraint if exists shop_settings_id_check,
  add primary key (branch_id);

-- id stays 1 on every row: screens update shop_settings where id = 1, which is the caller's branch through the view
create view shop_settings with (security_invoker = true) as
  select * from branch_settings where branch_id = my_branch_id();
grant select, update on shop_settings to authenticated;

-- ---------------------------------------------------------------- branch_id on every branch table

do $$
declare
  t text;
  v uuid := default_branch_id();
begin
  foreach t in array array[
    'areas', 'tables', 'stations', 'menu_categories', 'menu_items', 'menu_item_variants', 'modifier_groups', 'modifier_options',
    'item_modifier_groups', 'item_option_overrides', 'item_components', 'item_component_variant_qty', 'price_history',
    'orders', 'order_items', 'order_item_modifiers', 'order_tables', 'kitchen_notices', 'ticket_states',
    'bills', 'payments', 'shifts', 'approvals', 'audit_log', 'print_agents', 'print_jobs', 'push_outbox']
  loop
    -- a constant default fills the existing rows without a rewrite; new rows take the caller's branch
    execute format('alter table %I add column branch_id uuid not null default %L references branches', t, v);
    execute format('alter table %I alter column branch_id set default my_branch_id()', t);
    execute format('create index %I on %I (branch_id)', t || '_branch', t);
  end loop;
  alter table devices alter column branch_id set default my_branch_id();
  alter table device_codes alter column branch_id set default my_branch_id();

  foreach t in array array[
    'areas', 'tables', 'stations', 'menu_categories', 'menu_items', 'menu_item_variants', 'modifier_groups', 'modifier_options',
    'item_modifier_groups', 'item_option_overrides', 'item_components', 'item_component_variant_qty', 'price_history',
    'orders', 'order_items', 'order_item_modifiers', 'order_tables', 'kitchen_notices', 'ticket_states',
    'bills', 'payments', 'shifts', 'approvals', 'audit_log', 'print_agents', 'print_jobs', 'devices', 'device_codes', 'branch_settings']
  loop
    execute format('create policy branch_only on %I as restrictive for all using (branch_id = (select my_branch_id())) '
                   'with check (branch_id = (select my_branch_id()))', t);
  end loop;
end $$;
create index orders_branch_open on orders (branch_id, status);
create index bills_branch_paid on bills (branch_id, paid_at);

-- staff of this branch plus the owners
create policy branch_only on staff as restrictive for all
  using (branch_id is null or branch_id = (select my_branch_id()))
  with check (branch_id is null or branch_id = (select my_branch_id()));

alter table branches enable row level security;
create policy read_all on branches for select using ((select reader_role()) is not null);

-- uniques that were shop-wide
alter table tables drop constraint tables_name_key;
create unique index tables_name_key on tables (branch_id, name);
alter table stations drop constraint stations_code_key;
create unique index stations_code_key on stations (branch_id, code);
drop index menu_items_code;
create unique index menu_items_code on menu_items (branch_id, lower(btrim(code))) where coalesce(btrim(code), '') <> '';
drop index menu_item_variants_code;
create unique index menu_item_variants_code on menu_item_variants (branch_id, lower(btrim(code))) where coalesce(btrim(code), '') <> '';
drop index shifts_one_open;
create unique index shifts_one_open on shifts (branch_id, register) where closed_at is null;

alter publication supabase_realtime add table branches;

-- ---------------------------------------------------------------- opening hours

create function branch_is_open(p_at timestamptz default now()) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_h jsonb := (select opening_hours from shop_settings);
  v_local timestamp := p_at at time zone 'Asia/Ho_Chi_Minh';
  v_t time := v_local::time;
  v_dow int := extract(isodow from v_local)::int;
  v_today jsonb;
  v_prev jsonb;
begin
  if v_h is null or v_h = '{}'::jsonb then return true; end if;
  v_today := v_h -> v_dow::text;
  v_prev := v_h -> (case when v_dow = 1 then 7 else v_dow - 1 end)::text;
  if jsonb_typeof(v_today) = 'object' then
    if (v_today ->> 'open')::time < (v_today ->> 'close')::time then
      if v_t >= (v_today ->> 'open')::time and v_t < (v_today ->> 'close')::time then return true; end if;
    elsif v_t >= (v_today ->> 'open')::time then
      return true;                                                   -- runs past midnight
    end if;
  end if;
  -- yesterday's hours running past midnight
  if jsonb_typeof(v_prev) = 'object' and (v_prev ->> 'close')::time <= (v_prev ->> 'open')::time
     and v_t < (v_prev ->> 'close')::time then
    return true;
  end if;
  return false;
end $$;

create function _require_open() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce((select enforce_hours from shop_settings), false) and not branch_is_open() and my_role() is distinct from 'manager' then
    raise exception 'Ngoài giờ làm việc của chi nhánh: cần quản lý hoặc chủ quán mở bàn';
  end if;
end $$;

-- opening_hours shape: ISO weekday keys, each {open, close} as HH:MM
create function opening_hours_ok(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
     where e.key not in ('1', '2', '3', '4', '5', '6', '7')
        or jsonb_typeof(e.value) <> 'object'
        or coalesce(e.value ->> 'open', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or coalesce(e.value ->> 'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
$$;
alter table branch_settings add constraint branch_settings_hours check (opening_hours_ok(opening_hours));

-- ---------------------------------------------------------------- functions that read the whole shop

create function pg_temp.patch(p_fn text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  r record;
  v_def text;
  v_n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_fn loop
    v_def := replace(pg_get_functiondef(r.oid), E'\r\n', E'\n');
    if position(p_old in v_def) > 0 then
      execute replace(v_def, p_old, p_new);
      v_n := v_n + 1;
    end if;
  end loop;
  if v_n = 0 then raise exception '0022: % does not contain: %', p_fn, p_old; end if;
end $$;

-- one open shift per register of this branch
select pg_temp.patch('pay_order', $x$from shifts where register = p_register and closed_at is null$x$,
                                  $x$from shifts where register = p_register and closed_at is null and branch_id = my_branch_id()$x$);
select pg_temp.patch('open_shift', $x$from shifts where register = p_register and closed_at is null$x$,
                                   $x$from shifts where register = p_register and closed_at is null and branch_id = my_branch_id()$x$);
select pg_temp.patch('close_shift', $x$from orders where status = 'open' and paying_at is not null$x$,
                                    $x$from orders where status = 'open' and paying_at is not null and branch_id = v_s.branch_id$x$);

-- takeaway numbers count per branch
select pg_temp.patch('orders_before_insert', $x$from orders where kind = 'takeaway' and opened_at >= v_from$x$,
                                             $x$from orders where kind = 'takeaway' and opened_at >= v_from and branch_id = new.branch_id$x$);

-- opening hours: only a new table or takeaway order is refused (an order already open on the table is returned first)
select pg_temp.patch('open_table', $x$  if found then return v_o; end if;$x$, $x$  if found then return v_o; end if;
  perform _require_open();$x$);
select pg_temp.patch('open_takeaway', $x$begin
  insert into orders$x$, $x$begin
  perform _require_open();
  insert into orders$x$);
select pg_temp.patch('add_shared_order', $x$  if p_guests is null or p_guests < 1 or p_guests > 99$x$, $x$  perform _require_open();
  if p_guests is null or p_guests < 1 or p_guests > 99$x$);

-- sign-in: names of this device's branch (and the owners); a closed branch signs in owners only
select pg_temp.patch('signin_roster', $x$where s.active and (v_d.kind = 'pos'$x$,
  $x$where s.active and (s.branch_id is null or (s.branch_id = v_d.branch_id and (select b.active from branches b where b.id = v_d.branch_id)))
       and (v_d.kind = 'pos'$x$);
select pg_temp.patch('staff_sign_in', $x$  if v_d.kind = 'kitchen' and$x$,
  $x$  if v_s.branch_id is not null and v_s.branch_id <> v_d.branch_id then
    return jsonb_build_object('ok', false, 'error', 'Nhân viên này làm ở chi nhánh khác');
  end if;
  if v_s.branch_id is not null and not (select b.active from branches b where b.id = v_d.branch_id) then
    return jsonb_build_object('ok', false, 'error', 'Chi nhánh này đã tạm đóng');
  end if;
  if v_d.kind = 'kitchen' and$x$);

-- Nhân viên: this branch's people and the owners; names only clash within a branch
select pg_temp.patch('staff_admin_list', $x$from staff s left join staff_secrets sec on sec.staff_id = s.id
     order by$x$, $x$from staff s left join staff_secrets sec on sec.staff_id = s.id
     where s.branch_id is null or s.branch_id = my_branch_id()
     order by$x$);
select pg_temp.patch('staff_save', $x$from staff where lower(name) = lower(v_name) and active and id is distinct from p_id$x$,
  $x$from staff where lower(name) = lower(v_name) and active and id is distinct from p_id and (branch_id is null or branch_id = my_branch_id())$x$);

-- a device joins the branch its code was made for
select pg_temp.patch('register_device', $x$insert into devices (user_id, name, kind, registered_by) values (auth.uid(), v_c.name, v_c.kind, v_c.created_by)$x$,
  $x$insert into devices (user_id, name, kind, registered_by, branch_id) values (auth.uid(), v_c.name, v_c.kind, v_c.created_by, v_c.branch_id)$x$);
select pg_temp.patch('my_device', $x$'idle_min', (select idle_signout_min from shop_settings))$x$,
  $x$'idle_min', (select idle_signout_min from shop_settings),
                            'branch_id', branch_id, 'branch_name', (select b.name from branches b where b.id = devices.branch_id))$x$);

-- printers and push stay inside the branch
select pg_temp.patch('print_agents_list', $x$from print_agents), '[]'::jsonb);$x$,
  $x$from print_agents where branch_id = my_branch_id()), '[]'::jsonb);$x$);
select pg_temp.patch('push_outbox_flush', $x$'exclude_device', r.exclude_device, 'only_device', r.only_device)$x$,
  $x$'exclude_device', r.exclude_device, 'only_device', r.only_device, 'branch_id', r.branch_id)$x$);

-- Devices: the code carries the branch (the owner may pick any; others make codes for their own branch)
drop function create_device_code(text, text);
create function create_device_code(p_name text, p_kind text default 'pos', p_branch uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_b uuid := coalesce(p_branch, my_branch_id());
begin
  perform _need('devices.manage');
  if v_b <> my_branch_id() and my_real_role() <> 'owner' then raise exception 'Chỉ chủ quán thêm máy cho chi nhánh khác'; end if;
  if not exists (select 1 from branches where id = v_b and active) then raise exception 'Chi nhánh không tồn tại hoặc đã đóng'; end if;
  v := _new_device_code(p_name, p_kind, my_staff_id());
  update device_codes set branch_id = v_b where code_hash = _hash(v ->> 'code');
  perform _audit('device_code', jsonb_build_object('name', v ->> 'name', 'kind', p_kind, 'branch', v_b));
  return v || jsonb_build_object('branch_id', v_b);
end $$;

-- ---------------------------------------------------------------- branch RPCs

-- Where this session works, and whether it may switch (owners).
create function my_branch() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'name', b.name, 'active', b.active,
                            'device_branch_id', (select d.branch_id from devices d where d.user_id = auth.uid() and d.active),
                            'can_switch', coalesce(my_real_role() = 'owner', false),
                            'is_open', branch_is_open())
    from branches b where b.id = my_branch_id()
$$;

-- Owners: every branch with a few numbers; others: their own branch.
create function branches_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'name', b.name, 'active', b.active, 'sort', b.sort,
           'address', s.address, 'phone', s.phone, 'opening_hours', s.opening_hours, 'enforce_hours', s.enforce_hours,
           'business_day_start', to_char(s.business_day_start, 'HH24:MI'),
           'staff', (select count(*) from staff st where st.branch_id = b.id and st.active),
           'devices', (select count(*) from devices d where d.branch_id = b.id and d.active),
           'items', (select count(*) from menu_items i where i.branch_id = b.id and i.status::text <> 'archived'))
         order by b.sort, b.created_at), '[]'::jsonb)
    from branches b left join branch_settings s on s.branch_id = b.id
   where my_role() is not null and (my_real_role() = 'owner' or b.id = my_branch_id())
$$;

-- Owner: work in another branch on this device until sign-out (the device's own branch clears the choice).
create function switch_branch(p_branch uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_dev uuid := (select branch_id from devices where user_id = auth.uid() and active);
begin
  if my_real_role() is distinct from 'owner' then raise exception 'Chỉ chủ quán đổi chi nhánh'; end if;
  if not exists (select 1 from branches where id = p_branch and active) then raise exception 'Chi nhánh không tồn tại hoặc đã đóng'; end if;
  update staff_sessions set branch_id = case when p_branch = v_dev then null else p_branch end
   where token_hash = session_token_hash() and ended_at is null;
  if not found then raise exception 'Đăng nhập trước'; end if;
  perform _audit('switch_branch', jsonb_build_object('branch', p_branch));
  return my_branch();
end $$;

-- Copy a branch's menu (stations, groups, dishes, sizes, options, parts) into the branch app.branch_override names.
create function _copy_menu(p_from uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_to uuid := my_branch_id();
begin
  create temp table if not exists _menu_map (old uuid primary key, new uuid not null default gen_random_uuid()) on commit drop;
  truncate _menu_map;
  insert into _menu_map (old)
    select id from stations where branch_id = p_from union all
    select id from menu_categories where branch_id = p_from union all
    select id from modifier_groups where branch_id = p_from union all
    select id from modifier_options where branch_id = p_from union all
    select id from menu_items where branch_id = p_from union all
    select id from menu_item_variants where branch_id = p_from union all
    select id from item_components where branch_id = p_from;

  insert into stations (id, branch_id, code, name, kind, sort, active, sla_warn_min, sla_late_min)
    select m.new, v_to, x.code, x.name, x.kind, x.sort, x.active, x.sla_warn_min, x.sla_late_min
      from stations x join _menu_map m on m.old = x.id where x.branch_id = p_from;
  -- big groups first, then the groups inside them
  insert into menu_categories (id, branch_id, name, sort, default_station_id, vat_group, parent_id, color, visible)
    select m.new, v_to, x.name, x.sort, (select new from _menu_map where old = x.default_station_id), x.vat_group,
           (select new from _menu_map where old = x.parent_id), x.color, x.visible
      from menu_categories x join _menu_map m on m.old = x.id where x.branch_id = p_from
     order by x.parent_id nulls first;
  insert into modifier_groups (id, branch_id, name, kind, min_select, max_select, print_receipt, sort, archived_at, station_id)
    select m.new, v_to, x.name, x.kind, x.min_select, x.max_select, x.print_receipt, x.sort, x.archived_at,
           (select new from _menu_map where old = x.station_id)
      from modifier_groups x join _menu_map m on m.old = x.id where x.branch_id = p_from;
  insert into modifier_options (id, branch_id, group_id, name, kitchen_name, price_delta, max_qty, is_default, sort, archived_at)
    select m.new, v_to, (select new from _menu_map where old = x.group_id), x.name, x.kitchen_name, x.price_delta, x.max_qty,
           x.is_default, x.sort, x.archived_at
      from modifier_options x join _menu_map m on m.old = x.id where x.branch_id = p_from;
  insert into menu_items (id, branch_id, category_id, name, price, sort, station_id, has_sizes, vat_group, price_includes_vat,
                          discountable, service_charge, code, short_name, unit, prep_minutes, status, description, keywords, image_url)
    select m.new, v_to, (select new from _menu_map where old = x.category_id), x.name, x.price, x.sort,
           (select new from _menu_map where old = x.station_id), x.has_sizes, x.vat_group, x.price_includes_vat,
           x.discountable, x.service_charge, x.code, x.short_name, x.unit, x.prep_minutes, x.status, x.description, x.keywords, x.image_url
      from menu_items x join _menu_map m on m.old = x.id where x.branch_id = p_from;
  insert into menu_item_variants (id, branch_id, item_id, name, code, price, sort, archived_at)
    select m.new, v_to, (select new from _menu_map where old = x.item_id), x.name, x.code, x.price, x.sort, x.archived_at
      from menu_item_variants x join _menu_map m on m.old = x.id where x.branch_id = p_from;
  insert into item_components (id, branch_id, item_id, name, kitchen_name, qty, unit, removable, removal_discount,
                               addon_option_id, sort, archived_at, station_id)
    select m.new, v_to, (select new from _menu_map where old = x.item_id), x.name, x.kitchen_name, x.qty, x.unit, x.removable,
           x.removal_discount, (select new from _menu_map where old = x.addon_option_id), x.sort, x.archived_at,
           (select new from _menu_map where old = x.station_id)
      from item_components x join _menu_map m on m.old = x.id where x.branch_id = p_from;
  insert into item_component_variant_qty (branch_id, component_id, variant_id, qty)
    select v_to, (select new from _menu_map where old = x.component_id), (select new from _menu_map where old = x.variant_id), x.qty
      from item_component_variant_qty x where x.branch_id = p_from;
  insert into item_modifier_groups (branch_id, item_id, group_id, sort, min_override, max_override)
    select v_to, (select new from _menu_map where old = x.item_id), (select new from _menu_map where old = x.group_id), x.sort,
           x.min_override, x.max_override
      from item_modifier_groups x where x.branch_id = p_from;
  insert into item_option_overrides (branch_id, item_id, option_id, price_delta, hidden)
    select v_to, (select new from _menu_map where old = x.item_id), (select new from _menu_map where old = x.option_id), x.price_delta, x.hidden
      from item_option_overrides x where x.branch_id = p_from;
end $$;

-- Owner: add a branch (p_id null; settings copied from p_copy_from or the current branch, and its menu too when
-- p_copy_from is given), or rename / reorder / close (active false) / reopen one.
create function branch_save(p_id uuid, p_name text, p_active boolean default true, p_copy_from uuid default null, p_sort int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_b branches;
  v_src uuid := coalesce(p_copy_from, my_branch_id());
  v_set branch_settings;
begin
  if my_real_role() is distinct from 'owner' then raise exception 'Chỉ chủ quán quản lý chi nhánh'; end if;
  if char_length(v_name) not between 1 and 40 then raise exception 'Nhập tên chi nhánh (tối đa 40 ký tự)'; end if;
  if exists (select 1 from branches where lower(btrim(name)) = lower(v_name) and id is distinct from p_id) then
    raise exception 'Đã có chi nhánh tên "%"', v_name;
  end if;
  if p_id is not null then
    if not coalesce(p_active, true) and (select count(*) from branches where active and id <> p_id) = 0 then
      raise exception 'Phải còn ít nhất một chi nhánh mở';
    end if;
    update branches set name = v_name, active = coalesce(p_active, true), sort = coalesce(p_sort, sort) where id = p_id returning * into v_b;
    if not found then raise exception 'Không tìm thấy chi nhánh'; end if;
    if not v_b.active then
      update staff_sessions set branch_id = null where branch_id = v_b.id and ended_at is null;
    end if;
    perform _audit('branch_edit', jsonb_build_object('branch', v_b.id, 'name', v_b.name, 'active', v_b.active));
    return to_jsonb(v_b);
  end if;
  if p_copy_from is not null and not exists (select 1 from branches where id = p_copy_from) then
    raise exception 'Không tìm thấy chi nhánh để chép thực đơn';
  end if;
  insert into branches (name, sort) values (v_name, coalesce(p_sort, (select coalesce(max(sort), 0) + 1 from branches))) returning * into v_b;
  -- the receipt, payment and sign-in settings start as the source branch's; the hours start empty
  select * into v_set from branch_settings where branch_id = v_src;
  v_set.branch_id := v_b.id;
  v_set.opening_hours := '{}'::jsonb;
  v_set.enforce_hours := false;
  if v_set.id is null then
    insert into branch_settings (branch_id) values (v_b.id);
  else
    insert into branch_settings select v_set.*;
  end if;
  perform _audit('branch_add', jsonb_build_object('branch', v_b.id, 'name', v_b.name, 'menu_from', p_copy_from));
  if p_copy_from is not null then
    perform set_config('app.branch_override', v_b.id::text, true);
    perform _copy_menu(p_copy_from);
    perform set_config('app.branch_override', '', true);
  end if;
  return to_jsonb(v_b);
end $$;

-- Hours of the caller's branch (settings.edit).
create function save_opening_hours(p_hours jsonb, p_enforce boolean, p_day_start text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('settings.edit');
  if not opening_hours_ok(coalesce(p_hours, '{}'::jsonb)) then raise exception 'Giờ làm việc không hợp lệ (dạng 07:00)'; end if;
  if p_day_start is not null and p_day_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Giờ chốt ngày không hợp lệ (dạng 06:00)'; end if;
  update branch_settings set opening_hours = coalesce(p_hours, '{}'::jsonb), enforce_hours = coalesce(p_enforce, false),
                             business_day_start = coalesce(p_day_start::time, business_day_start)
   where branch_id = my_branch_id();
  perform _audit('opening_hours', jsonb_build_object('hours', p_hours, 'enforce', p_enforce, 'day_start', p_day_start));
end $$;

revoke execute on function _copy_menu(uuid), _require_open(), default_branch_id() from public, anon, authenticated;
revoke execute on function my_branch_id(), branch_is_open(timestamptz), opening_hours_ok(jsonb), my_branch(), branches_list(),
  switch_branch(uuid), branch_save(uuid, text, boolean, uuid, int), save_opening_hours(jsonb, boolean, text),
  create_device_code(text, text, uuid), staff_branch_fill() from public, anon;
grant execute on function my_branch_id(), branch_is_open(timestamptz), opening_hours_ok(jsonb), my_branch(), branches_list(),
  switch_branch(uuid), branch_save(uuid, text, boolean, uuid, int), save_opening_hours(jsonb, boolean, text),
  create_device_code(text, text, uuid) to authenticated;
