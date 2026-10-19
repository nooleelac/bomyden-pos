-- Bò Mỹ Đen POS 0010: Xoá vĩnh viễn (quản trị viên), on top of 0001–0009.
-- Same rules as adminDelete in src/floor/engine.ts, src/menu/repo.ts and src/auth/memoryRepo.ts (the sample
-- engines); keep them in step.
--
-- Before: nothing that was ever used could be deleted, only hidden: món "Ngừng kinh doanh", nhóm món ẩn, khu
-- "Tạm đóng", bàn "Ngừng dùng", nhân viên "Ngừng làm", máy "Khoá máy"; orders, bills and shifts stayed forever.
-- After:
--   * New permission `admin.delete` (Xoá vĩnh viễn). The owner (quản trị viên) has it; no other role has it until
--     the owner ticks it in Nhân viên → Phân quyền.
--   * admin_delete(kind, id) removes one thing for good, with everything that cannot exist without it:
--       category  the group, its sub-groups and their dishes
--       item      the dish with its sizes, components and links
--       group     the option / add-on group with its options
--       area      the area, its tables, and the orders still open on them
--       table     the table and the orders still open on it
--       order     the order (open, paid or void) with its dishes, bill, payments, notices; orders merged into it
--       shift     the shift (its bills stay, without a shift)
--       staff     the person, their PIN and sessions (not oneself, not the last owner)
--       device    the device and its sessions (not the device in use)
--     Old bills keep their dishes: names and prices are snapshots, so a deleted dish / option / table only leaves
--     the link empty (order_items.menu_item_id, order_item_modifiers.option_id, orders.table_id …).
--   * Every delete is written to the audit log ('delete', kind, name). The audit log itself is never deleted.

-- ---------------------------------------------------------------- permission

insert into permissions (id, label, sort) values ('admin.delete', 'Xoá vĩnh viễn', 19) on conflict (id) do nothing;

-- ---------------------------------------------------------------- links that may now be empty

alter table order_items alter column menu_item_id drop not null;   -- the dish was deleted; the line keeps its name
alter table shifts alter column opened_by drop not null;            -- the cashier was deleted; the shift keeps its money

-- A dine-in order whose table was deleted keeps its bill with no table (takeaway orders still never have one).
alter table orders drop constraint orders_kind_table;
alter table orders add constraint orders_kind_table check (kind = 'dine_in' or table_id is null);

-- An option or removed component that was deleted leaves the modifier row with its snapshot name only.
do $$
declare v text;
begin
  select conname into v from pg_constraint
   where conrelid = 'order_item_modifiers'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%removal%';
  if v is not null then execute format('alter table order_item_modifiers drop constraint %I', v); end if;
end $$;
alter table order_item_modifiers add constraint order_item_modifiers_kind_check
  check (case when kind = 'removal' then option_id is null and unit_delta <= 0 else component_id is null and unit_delta >= 0 end);

-- ---------------------------------------------------------------- helpers

-- One UPDATE that only empties links, without the business triggers (closed orders refuse any update, lines of
-- an order being paid refuse edits …). Setting a link to null never breaks a foreign key. Where the role may not
-- switch triggers off, the update runs with them.
create function _update_untriggered(p_sql text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prev text := current_setting('session_replication_role');
begin
  begin
    perform set_config('session_replication_role', 'replica', true);
  exception when insufficient_privilege then
    null;
  end;
  execute p_sql;
  perform set_config('session_replication_role', v_prev, true);
end $$;

-- Delete the rows of p_rel matching p_where and everything that points at them, following every foreign key:
-- rows that cannot exist without them (ON DELETE CASCADE or a NOT NULL link) are deleted the same way first, then
-- links that may be empty are set to null, then the rows themselves go (the foreign keys still check the result).
create function _purge(p_rel regclass, p_where text, p_depth int default 0) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
  v_where text := p_where;
  v_cond text;
  r record;
begin
  if p_depth > 15 then raise exception 'Dữ liệu liên quan lồng quá sâu: không xoá được'; end if;
  -- fix the rows by id first: emptying a self-link (nhóm con → nhóm cha) must not change which rows go
  if exists (select 1 from pg_attribute where attrelid = p_rel and attname = 'id' and atttypid = 'uuid'::regtype and not attisdropped) then
    execute format('select array_agg(id) from %s where %s', p_rel, p_where) into v_ids;
    if v_ids is null then return; end if;
    v_where := format('id = any(%L::uuid[])', v_ids);
  end if;
  for r in
    select * from (
      select c.conrelid::regclass as child,
        (select string_agg(quote_ident(a.attname), ', ' order by k.i)
           from unnest(c.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
        (select string_agg(quote_ident(a.attname), ', ' order by k.i)
           from unnest(c.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as refs,
        (select string_agg(format('%I = null', a.attname), ', ')
           from unnest(c.conkey) k(n) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n where not a.attnotnull) as set_null,
        c.confdeltype = 'c' or (select bool_or(a.attnotnull)
           from unnest(c.conkey) k(n) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as must_go
      from pg_constraint c
      where c.contype = 'f' and c.confrelid = p_rel
    ) fk
    order by must_go desc, child::text
  loop
    v_cond := format('(%s) in (select %s from %s where %s)', r.cols, r.refs, p_rel, v_where);
    if r.must_go then
      if r.child = p_rel then raise exception 'Không xoá được: % trỏ vào chính nó', p_rel; end if;
      perform _purge(r.child, v_cond, p_depth + 1);
    else
      perform _update_untriggered(format('update %s set %s where %s', r.child, r.set_null, v_cond));
    end if;
  end loop;
  execute format('delete from %s where %s', p_rel, v_where);
end $$;

-- Orders go with the orders merged into them (their dishes moved over; they have nothing left of their own).
create function _purge_orders(p_where text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _purge('orders', format('(%1$s) or merged_into in (select id from orders where %1$s)', p_where));
end $$;

-- Tables go with the orders still open on them; closed orders keep their bills and lose the table.
create function _purge_tables(p_where text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _purge_orders(format(
    'status = ''open'' and (table_id in (select id from tables where %1$s)'
    ' or id in (select order_id from order_tables where left_at is null and table_id in (select id from tables where %1$s)))', p_where));
  perform _purge('tables', p_where);
end $$;

-- ---------------------------------------------------------------- Xoá vĩnh viễn

create function admin_delete(p_kind text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_role text;
begin
  perform _need('admin.delete');
  if p_id is null then raise exception 'Chưa chọn mục cần xoá'; end if;
  case p_kind
    when 'category' then
      select name into v_name from menu_categories where id = p_id;
      if not found then raise exception 'Không tìm thấy nhóm món'; end if;
      perform _purge('menu_categories', format('id = %1$L or parent_id = %1$L', p_id));
    when 'item' then
      select name into v_name from menu_items where id = p_id;
      if not found then raise exception 'Không tìm thấy món'; end if;
      perform _purge('menu_items', format('id = %L', p_id));
    when 'group' then
      select name into v_name from modifier_groups where id = p_id;
      if not found then raise exception 'Không tìm thấy nhóm tuỳ chọn'; end if;
      perform _purge('modifier_groups', format('id = %L', p_id));
    when 'area' then
      select name into v_name from areas where id = p_id;
      if not found then raise exception 'Không tìm thấy khu'; end if;
      perform _purge_tables(format('area_id = %L', p_id));
      perform _purge('areas', format('id = %L', p_id));
    when 'table' then
      select name into v_name from tables where id = p_id;
      if not found then raise exception 'Không tìm thấy bàn'; end if;
      perform _purge_tables(format('id = %L', p_id));
    when 'order' then
      select coalesce((select bill_no from bills where order_id = o.id), case when o.kind = 'takeaway' then 'Mang về' else 'Bàn ' || t.name end, 'Đơn')
        into v_name from orders o left join tables t on t.id = o.table_id where o.id = p_id;
      if not found then raise exception 'Không tìm thấy đơn'; end if;
      perform _purge_orders(format('id = %L', p_id));
    when 'shift' then
      select register || ' ' || to_char(opened_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') into v_name from shifts where id = p_id;
      if not found then raise exception 'Không tìm thấy ca'; end if;
      perform _purge('shifts', format('id = %L', p_id));
    when 'staff' then
      select name, role::text into v_name, v_role from staff where id = p_id;
      if not found then raise exception 'Không tìm thấy nhân viên'; end if;
      if p_id = my_staff_id() then raise exception 'Không tự xoá tài khoản của mình'; end if;
      if v_role in ('manager', 'owner') and my_real_role() is distinct from 'owner' then
        raise exception 'Chỉ chủ quán được xoá quản lý hoặc chủ quán';
      end if;
      if v_role = 'owner' and not exists (select 1 from staff where role = 'owner' and active and id <> p_id) then
        raise exception 'Phải còn ít nhất một chủ quán';
      end if;
      perform _purge('staff', format('id = %L', p_id));
    when 'device' then
      select name into v_name from devices where id = p_id;
      if not found then raise exception 'Không tìm thấy máy'; end if;
      if p_id = my_device_id() then raise exception 'Đang dùng máy này: xoá từ máy khác'; end if;
      perform _purge('devices', format('id = %L', p_id));
    else
      raise exception 'Loại cần xoá không hợp lệ: %', p_kind;
  end case;
  perform _audit('delete', jsonb_build_object('kind', p_kind, 'name', v_name));
end $$;

revoke execute on function _update_untriggered(text), _purge(regclass, text, int), _purge_orders(text), _purge_tables(text) from public, anon, authenticated;
revoke execute on function admin_delete(text, uuid) from public, anon;
grant execute on function admin_delete(text, uuid) to authenticated;
