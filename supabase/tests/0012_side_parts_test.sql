-- Test for 0012 (one dish, several stations: side parts) on plain Postgres 16 after all migrations, with the Supabase stand-ins.
\set ON_ERROR_STOP 1
\pset footer off

create function t_ok(p_cond boolean, p_msg text) returns text language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_msg; end if;
  return 'ok - ' || p_msg;
end $$;
create function t_err(p_sql text, p_like text, p_msg text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not ilike p_like then raise exception 'FAIL: % -> wrong error: % (wanted %)', p_msg, sqlerrm, p_like; end if;
    return 'ok - ' || p_msg || '  [' || sqlerrm || ']';
  end;
  raise exception 'FAIL: % -> no error raised', p_msg;
end $$;
grant execute on function t_ok(boolean, text), t_err(text, text, text) to authenticated;

-- ---------------------------------------------------------------- seed (superuser)
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000003'),
                              ('00000000-0000-0000-0000-000000000004');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000003', 'Chủ quán', 'manager'),
  ('00000000-0000-0000-0000-000000000004', 'Bếp', 'kitchen');
update shop_settings set void_approval = 'started';
insert into areas (name, sort) values ('Tầng 1', 1);
insert into tables (area_id, name, sort, seats) select a.id, n::text, n, 4 from areas a, generate_series(1, 4) n;
select id as t3 from tables where name = '3' \gset
select id as grill from stations where code = 'grill' \gset
insert into stations (code, name, kind, sort) values ('rau', 'Quầy rau – sốt', 'kitchen', 5) returning id as cold \gset

insert into menu_categories (name, default_station_id) values ('Steak', :'grill') returning id as c_steak \gset
insert into menu_items (category_id, name, short_name, price, has_sizes) values (:'c_steak', 'Beefsteak bánh mì', 'BEEFSTEAK', 0, true) returning id as steak \gset
insert into menu_item_variants (item_id, name, price, sort) values (:'steak', '300g', 279000, 1) returning id as v300 \gset
insert into modifier_groups (name, kind, min_select, max_select) values ('Độ chín', 'choice', 1, 1) returning id as g_dc \gset
insert into modifier_options (group_id, name, kitchen_name) values (:'g_dc', 'Medium', 'MEDIUM') returning id as o_m \gset
insert into modifier_groups (name, kind, min_select, max_select, station_id) values ('Nước sốt', 'choice', 0, 1, :'cold') returning id as g_sauce \gset
insert into modifier_options (group_id, name, kitchen_name) values (:'g_sauce', 'Sốt tiêu', 'TIÊU') returning id as o_pepper \gset
insert into modifier_groups (name, kind) values ('Món thêm', 'addon') returning id as g_add \gset
insert into modifier_options (group_id, name, kitchen_name, price_delta, max_qty) values (:'g_add', 'Thêm bánh mì', '+ BÁNH MÌ', 5000, 3) returning id as o_bread \gset
insert into item_modifier_groups (item_id, group_id, sort) values (:'steak', :'g_dc', 1), (:'steak', :'g_sauce', 2), (:'steak', :'g_add', 3);
insert into item_components (item_id, name, kitchen_name, removable, removal_discount, sort) values (:'steak', 'Trứng ốp la', 'TRỨNG', true, 3000, 1) returning id as c_egg \gset
insert into item_components (item_id, name, kitchen_name, removable, sort, station_id) values (:'steak', 'Salad trộn', 'SALAD', true, 2, :'cold') returning id as c_salad \gset
insert into item_components (item_id, name, kitchen_name, qty, removable, addon_option_id, sort, station_id)
  values (:'steak', 'Bánh mì', '', 2, true, :'o_bread', 3, :'cold') returning id as c_bread \gset

\set W '00000000-0000-0000-0000-000000000001'
\set M '00000000-0000-0000-0000-000000000003'
\set K '00000000-0000-0000-0000-000000000004'
select jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 2,
         'options', jsonb_build_array(jsonb_build_object('option_id', :'o_m'), jsonb_build_object('option_id', :'o_pepper'), jsonb_build_object('option_id', :'o_bread')),
         'removals', jsonb_build_array(:'c_egg')) as full_line \gset

set role authenticated;

-- ---------------------------------------------------------------- Gửi bếp: one line, a side part at the cold counter
set test.uid = :'W';
select id as o3 from open_table(:'t3', 2) \gset
select gen_random_uuid() as b1 \gset
select id as l1 from send_order_lines(:'o3', jsonb_build_array(:'full_line'::jsonb), :'b1') \gset
select t_ok((select count(*) from order_items where order_id = :'o3') = 1
            and (select station_id from order_items where id = :'l1') = :'grill'
            and (select price from order_items where id = :'l1') = 279000 - 3000 + 5000, 'one line on the bill, at the grill, priced as before') as check;
select t_ok((select side_parts from order_items where id = :'l1')
            = jsonb_build_array(jsonb_build_object('station_id', :'cold', 'parts', jsonb_build_array('SALAD', 'BÁNH MÌ x2'),
                                                   'status', 'new', 'started_at', null, 'ready_at', null, 'served_at', null)),
            'side part at Quầy rau with its components (kitchen name, else name; qty per portion)') as check;
select t_ok((select jsonb_object_agg(kitchen_name, coalesce(station_id::text, 'dish')) from order_item_modifiers where order_item_id = :'l1')
            = jsonb_build_object('MEDIUM', 'dish', 'TIÊU', :'cold', '+ BÁNH MÌ', :'cold', 'TRỨNG', 'dish'),
            'doneness and KHÔNG TRỨNG on the steak; sốt (group) and Thêm bánh mì (its component) at the cold counter') as check;
select t_ok((get_floor_state() -> 'items' -> 0 -> 'side_parts' -> 0 ->> 'station_id') = :'cold'
            and (get_floor_state() -> 'items' -> 0 -> 'mods') @> jsonb_build_array(jsonb_build_object('kitchen_name', 'TIÊU', 'station_id', :'cold')),
            'the floor state carries side parts and modifier stations') as check;

-- "KHÔNG SALAD, KHÔNG BÁNH MÌ" and no sốt: nothing for the cold counter, the removals stay on the steak's ticket
select id as l2 from send_order_lines(:'o3', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
         'options', jsonb_build_array(jsonb_build_object('option_id', :'o_m')), 'removals', jsonb_build_array(:'c_salad', :'c_bread')))) \gset
select t_ok((select side_parts from order_items where id = :'l2') = '[]'
            and not exists (select 1 from order_item_modifiers where order_item_id = :'l2' and station_id is not null),
            'no side part when everything made elsewhere is left out') as check;

-- ---------------------------------------------------------------- trạng thái phần đi kèm
select jsonb_build_array(jsonb_build_object('line_id', :'l1', 'station_id', :'cold')) as part \gset
select t_err(format('select set_part_status(%L, %L)', :'part', 'cooking'), 'Chưa có quyền%', 'a waiter cannot cook the part') as check;
set test.uid = :'K';
select t_err(format('select set_part_status(%L, %L)', jsonb_build_array(jsonb_build_object('line_id', :'l2', 'station_id', :'cold')), 'ready'),
             'Không tìm thấy phần món', 'a line without that side part') as check;
select count(*) from set_part_status(:'part', 'ready');
select t_ok((select side_parts -> 0 ->> 'status' from order_items where id = :'l1') = 'ready'
            and (select side_parts -> 0 ->> 'ready_at' from order_items where id = :'l1') is not null
            and (select side_parts -> 0 ->> 'started_at' from order_items where id = :'l1') is not null
            and (select status from order_items where id = :'l1') = 'new', 'the cold counter is done; the steak still waits') as check;
select t_err(format('select set_part_status(%L, %L)', :'part', 'served'), 'Chưa có quyền%', 'the kitchen does not carry out') as check;
select count(*) from set_part_status(:'part', 'cooking');
select t_ok((select side_parts -> 0 ->> 'status' from order_items where id = :'l1') = 'cooking'
            and (select side_parts -> 0 -> 'ready_at' from order_items where id = :'l1') = 'null', 'one step back within 2 minutes') as check;

-- ---------------------------------------------------------------- xong phiếu, gọi lại on the side ticket
select (select send_batch from order_items where id = :'l1') || '|' || :'cold' || '|' || :'o3' || '|' || :'t3' as cold_key \gset
select send_batch || '|' || station_id || '|' || order_id || '|' || delivery_table_id as grill_key from order_items where id = :'l1' \gset
select bumped_at is not null as bumped from bump_ticket(:'cold_key') \gset
select t_ok((select side_parts -> 0 ->> 'status' from order_items where id = :'l1') = 'ready'
            and (select status from order_items where id = :'l1') = 'new', 'Xong phiếu at the cold counter leaves the steak alone') as check;
select count(*) from recall_ticket(:'cold_key');
select t_ok((select side_parts -> 0 ->> 'status' from order_items where id = :'l1') = 'cooking', 'Gọi lại brings the part back') as check;
select count(*) from bump_ticket(:'grill_key');
select t_ok((select status from order_items where id = :'l1') = 'ready'
            and (select side_parts -> 0 ->> 'status' from order_items where id = :'l1') = 'cooking', 'Xong phiếu at the grill leaves the side part alone') as check;

-- ---------------------------------------------------------------- giục, bưng
set test.uid = :'W';
select count(*) from chase_order(:'o3');
select t_ok((select array_agg(distinct station_id) from kitchen_notices where order_id = :'o3' and kind = 'chase') = array[:'grill', :'cold']::uuid[]
            or (select array_agg(distinct station_id) from kitchen_notices where order_id = :'o3' and kind = 'chase') = array[:'cold', :'grill']::uuid[],
            'giục reaches the cold counter (part cooking) and the grill (l2 still new)') as check;
set test.uid = :'K';
select count(*) from set_part_status(:'part', 'ready');
set test.uid = :'W';
select count(*) from set_part_status(:'part', 'served');
select t_ok((select side_parts -> 0 ->> 'status' from order_items where id = :'l1') = 'served', 'the waiter carries the part out') as check;

-- ---------------------------------------------------------------- huỷ một phần: the copy keeps its side part
set test.uid = :'M';
select id as l3 from send_order_lines(:'o3', jsonb_build_array(:'full_line'::jsonb)) \gset
select count(*) from void_item(:'l3', 1, 'Khách đổi ý');
select t_ok((select count(*) from order_items where menu_item_id = :'steak' and side_parts <> '[]' and order_id = :'o3') = 3
            and (select bool_and(side_parts -> 0 ->> 'station_id' = :'cold') from order_items where order_id = :'o3' and side_parts <> '[]'),
            'bớt 1 of 2: the voided copy and the kept line both carry the side part') as check;
select t_err(format('select set_part_status(%L, %L)',
                    jsonb_build_array(jsonb_build_object('line_id', (select id from order_items where order_id = :'o3' and status = 'void' limit 1), 'station_id', :'cold')), 'ready'),
             'Món đã huỷ', 'a voided line''s part does not move') as check;
reset role;
