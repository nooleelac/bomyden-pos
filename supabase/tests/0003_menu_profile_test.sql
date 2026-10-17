-- Test for 0003 on plain Postgres 16 after all migrations (0001–0006), with the Supabase stand-ins (auth.uid via test.uid, roles). Not part of the migrations.
-- Test for 0002 on plain Postgres 16. Runs as the API role `authenticated` (RLS on) except where marked.
\set ON_ERROR_STOP 1
\pset footer off

-- helpers (test only)
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

-- ---------------------------------------------------------------- seed (superuser): staff, tables
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'),
                              ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000004');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000002', 'Lan', 'cashier'),
  ('00000000-0000-0000-0000-000000000003', 'Chủ quán', 'manager'),
  ('00000000-0000-0000-0000-000000000004', 'Bếp nướng', 'kitchen');
insert into tables (name, sort) values ('3', 3), ('4', 4), ('5', 5), ('6', 6), ('7', 7);
select id as t3 from tables where name = '3' \gset
select id as t4 from tables where name = '4' \gset
select id as t5 from tables where name = '5' \gset
select id as t6 from tables where name = '6' \gset
select id as t7 from tables where name = '7' \gset


-- ---------------------------------------------------------------- 0003: categories, item profile (as manager, RLS on)
set role authenticated;
set test.uid = '00000000-0000-0000-0000-000000000003';
insert into menu_categories (name, color, default_station_id) select 'Đồ uống', '#1565c0', id from stations where code = 'bar' returning id as drink \gset
insert into menu_categories (name, parent_id, color, vat_group) values ('Bia', :'drink', '#f9a825', 'alcohol') returning id as beer \gset
insert into menu_categories (name, color, default_station_id) select 'Steak', '#c62828', id from stations where code = 'grill' returning id as steakcat \gset
select t_err(format($$insert into menu_categories (name, parent_id) values ('Bia lon', %L)$$, :'beer'), '%2 cấp%', 'no third level');
select t_err(format($$update menu_categories set parent_id = %L where id = %L$$, :'steakcat', :'drink'), '%có nhóm con%', 'a parent cannot become a child');
select t_err(format($$update menu_categories set parent_id = id where id = %L$$, :'steakcat'), '%chính nó%', 'not its own parent');
select t_err($$insert into menu_categories (name, color) values ('X', 'red')$$, '%check%', 'colour must be #rrggbb');
select t_err(format($$delete from menu_categories where id = %L$$, :'drink'), '%foreign key%', 'parent with children cannot be deleted');
select t_ok((select visible from menu_categories where id = :'drink'), 'visible by default');

insert into menu_items (category_id, name, short_name, code, unit, prep_minutes, price, has_sizes, status)
  values (:'steakcat', 'Steak bò nướng', 'STEAK BÒ', '101', 'phần', 15, 0, true, 'draft') returning id as steak \gset
select t_ok(not (select available from menu_items where id = :'steak'), 'draft is not available');
insert into menu_item_variants (item_id, name, code, price, sort) values (:'steak', '300g', '101-300', 279000, 1);
update menu_items set status = 'active' where id = :'steak';
select t_ok((select available from menu_items where id = :'steak'), 'Mở bán makes it available');
update menu_items set available = false where id = :'steak';
select t_ok((select available from menu_items where id = :'steak'), 'available follows status, not direct writes');
select t_err(format($$insert into menu_items (category_id, name, short_name, code, price) values (%L, 'Steak khác', 'X', ' 101 ', 1)$$, :'steakcat'),
             '%menu_items_code%', 'item code unique (spaces ignored)');
insert into menu_items (category_id, name, short_name, code, price) values (:'steakcat', 'Steak thăn', 'THĂN', 'stb', 1);
select t_err(format($$insert into menu_items (category_id, name, short_name, code, price) values (%L, 'Steak thăn 2', 'THĂN', 'STB', 1)$$, :'steakcat'),
             '%menu_items_code%', 'item code unique ignoring case');
select t_err(format($$insert into menu_items (category_id, name, short_name, price) values (%L, repeat('a', 41), 'A', 1)$$, :'steakcat'),
             '%menu_items_name_len%', 'full name at most 40');
select t_err(format($$insert into menu_items (category_id, name, short_name, price) values (%L, 'Món', repeat('A', 21), 1)$$, :'steakcat'),
             '%short_name_len%', 'short name at most 20');
select t_err(format($$insert into menu_items (category_id, name, short_name, price, unit) values (%L, 'Món', 'A', 1, 'cái')$$, :'steakcat'),
             '%check%', 'unit from the list');
select t_err(format($$insert into menu_item_variants (item_id, name, code, price) values (%L, '400g', '101-300', 359000)$$, :'steak'),
             '%menu_item_variants_code%', 'size code unique');
select t_ok((select min_price_ratio from shop_settings) = 0.50, 'removal floor 50% by default');

-- send_order_lines refuses a draft (available follows status)
reset role;
insert into orders (table_id) values (:'t3') returning id as o1 \gset
insert into menu_items (category_id, name, short_name, code, price, status) values (:'steakcat', 'Bò cuộn nấm', 'BÒ CUỘN', '203', 119000, 'draft') returning id as draft \gset
set role authenticated;
set test.uid = '00000000-0000-0000-0000-000000000001';
select t_err(format($$select send_order_lines(%L, '[{"menu_item_id": "%s", "qty": 1}]')$$, :'o1', :'draft'), '%không có trong thực đơn%', 'draft cannot be sent');
update menu_items set name = 'Hack' where id = :'draft';
reset role;
select t_ok((select name from menu_items where id = :'draft') = 'Bò cuộn nấm', 'waiter cannot edit items (RLS)');
select t_ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'menu_categories'), 'categories in realtime');
select 'ALL 0003 TESTS PASSED';
