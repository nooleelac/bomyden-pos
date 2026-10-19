-- Bò Mỹ Đen POS 0012: one dish, several stations (phần đi kèm).
--
-- A dish still goes to its own station (Beefsteak -> Bếp nóng) and stays one line on the bill. A component or an
-- option group may now name its own quầy làm (Salad, Bánh mì, Nước sốt -> Quầy rau). At Gửi bếp each other prep
-- station gets a side part of the line with its own kitchen state, shown as its own ticket on that station's screen.
-- Same rules as src/menu/routing.ts and priceLine / setPartStatus in src/floor/engine.ts; keep both in step.
--
--   item_components.station_id     null = the dish's station
--   modifier_groups.station_id     null = the dish's station; an add-on matching a component ("Thêm bánh mì" ↔
--                                  Bánh mì) goes where that component is made
--   order_item_modifiers.station_id  snapshot at send: the side part the option is printed on, null = the dish's ticket
--   order_items.side_parts         [{station_id, parts: ['SALAD', 'BÁNH MÌ x2'], status, started_at, ready_at, served_at}]
--                                  A column, not a table, so every row copy (tách, bớt, huỷ một phần, chuyển món) takes
--                                  it along with the line; status uses the item_status steps (new, cooking, ready, served).
--
-- A side part's ticket key has the line's format with the part's station: 'send_batch|station|order|delivery_table'.
-- set_part_status works like set_item_status; bump_ticket, recall_ticket and chase_order now take side parts too.
-- "KHÔNG SALAD" alone makes no ticket at Quầy rau: the removal stays on the dish's own ticket.

-- ---------------------------------------------------------------- columns

alter table item_components add column station_id uuid references stations on delete set null;
alter table modifier_groups add column station_id uuid references stations on delete set null;
alter table order_item_modifiers add column station_id uuid references stations on delete set null;
alter table order_items add column side_parts jsonb not null default '[]' check (jsonb_typeof(side_parts) = 'array');

-- ---------------------------------------------------------------- one step of one side part

create function _part_step(p_parts jsonb, p_station uuid, p_to item_status, p_now timestamptz) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(
    case when (p ->> 'station_id')::uuid = p_station and p ->> 'status' is distinct from p_to::text then
      p || case p_to
        when 'cooking' then jsonb_build_object('status', 'cooking', 'ready_at', null,
                              'started_at', case when p ->> 'status' = 'new' then to_jsonb(p_now) else p -> 'started_at' end)
        when 'ready' then jsonb_build_object('status', 'ready', 'ready_at', to_jsonb(p_now),
                            'started_at', case when p ->> 'started_at' is null then to_jsonb(p_now) else p -> 'started_at' end)
        when 'served' then jsonb_build_object('status', 'served', 'served_at', to_jsonb(p_now))
        else jsonb_build_object('status', p_to::text, 'started_at', null)
      end
    else p end order by n), '[]')
  from jsonb_array_elements(p_parts) with ordinality e(p, n)
$$;
revoke execute on function _part_step(jsonb, uuid, item_status, timestamptz) from public, anon, authenticated;

-- Lines of a ticket that carry a side part at the ticket's station (void ones too, like ticket_key for lines).
create function _part_lines(p_key text) returns setof order_items
language sql stable set search_path = public as $$
  select i.* from order_items i
  where i.send_batch::text = split_part(p_key, '|', 1) and i.order_id::text = split_part(p_key, '|', 3)
    and coalesce(i.delivery_table_id::text, '') = split_part(p_key, '|', 4) and i.replaced_by is null
    and exists (select 1 from jsonb_array_elements(i.side_parts) p where p ->> 'station_id' = split_part(p_key, '|', 2))
$$;
revoke execute on function _part_lines(text) from public, anon, authenticated;

-- Every part of an order at every station with its state (the dish's own part and its side parts).
create function _kitchen_parts(p_order uuid) returns table (order_item_id uuid, station_id uuid, status text)
language sql stable set search_path = public as $$
  select i.id, i.station_id, i.status::text from order_items i where i.order_id = p_order
  union all
  select i.id, (p ->> 'station_id')::uuid, case when i.status = 'void' then 'void' else p ->> 'status' end
  from order_items i, jsonb_array_elements(i.side_parts) p where i.order_id = p_order
$$;
revoke execute on function _kitchen_parts(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- Gửi bếp: route options and build side parts

-- Exact-text edit of the latest _send_lines body (0004), the same way 0009 patched functions.
create or replace function pg_temp.patch(p_fn text, p_old text, p_new text) returns void
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
  if v_n = 0 then raise exception '0012: % does not contain: %', p_fn, p_old; end if;
end $$;

select pg_temp.patch('_send_lines',
  $x$    update order_items set price = greatest(0, base_price$x$,
  $x$    -- 0012 quầy làm: an option or a removal made at another active prep station is printed on that station's part
    update order_item_modifiers mo set station_id = x.st
    from (select m2.id,
                 case when m2.kind = 'removal' then c.station_id
                      else coalesce((select c2.station_id from item_components c2
                                     where c2.item_id = v_item.id and c2.addon_option_id = m2.option_id
                                       and c2.archived_at is null and c2.station_id is not null
                                     order by c2.sort, c2.id limit 1), g.station_id) end as st
          from order_item_modifiers m2
          left join item_components c on c.id = m2.component_id
          left join modifier_options o on o.id = m2.option_id
          left join modifier_groups g on g.id = o.group_id
          where m2.order_item_id = v_line) x
    join stations s on s.id = x.st and s.active and s.kind <> 'none' and s.id <> v_station.id
    where mo.id = x.id;
    -- one side part per other station that makes a kept component or a chosen option of this line
    update order_items set side_parts = coalesce((
      select jsonb_agg(jsonb_build_object(
               'station_id', s.id,
               'parts', coalesce((select jsonb_agg(upper(coalesce(nullif(btrim(c.kitchen_name), ''), btrim(c.name)))
                                                   || case when c.qty <> 1 then ' x' || trim_scale(c.qty)::text else '' end
                                                   order by c.sort, c.id)
                                  from item_components c
                                  where c.item_id = v_item.id and c.archived_at is null and c.station_id = s.id
                                    and not exists (select 1 from order_item_modifiers r where r.order_item_id = v_line and r.component_id = c.id)), '[]'),
               'status', 'new', 'started_at', null, 'ready_at', null, 'served_at', null) order by s.sort, s.id)
      from stations s
      where s.active and s.kind <> 'none' and s.id <> v_station.id
        and (exists (select 1 from item_components c
                     where c.item_id = v_item.id and c.archived_at is null and c.station_id = s.id
                       and not exists (select 1 from order_item_modifiers r where r.order_item_id = v_line and r.component_id = c.id))
             or exists (select 1 from order_item_modifiers m where m.order_item_id = v_line and m.kind <> 'removal' and m.station_id = s.id))), '[]')
    where id = v_line;
    -- "KHÔNG SALAD" alone makes no ticket at the cold counter: it stays on the dish's own ticket
    update order_item_modifiers m set station_id = null
    where m.order_item_id = v_line and m.station_id is not null
      and not exists (select 1 from order_items i, jsonb_array_elements(i.side_parts) p
                      where i.id = v_line and p ->> 'station_id' = m.station_id::text);

    update order_items set price = greatest(0, base_price$x$);

-- ---------------------------------------------------------------- trạng thái phần đi kèm

-- p_parts: [{line_id, station_id}]. Same steps and permissions as set_item_status (0004 + 0009).
create function set_part_status(p_parts jsonb, p_to item_status)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  r jsonb;
  v_l order_items;
  v_p jsonb;
  v_from item_status;
  v_back boolean;
  v_now timestamptz := now();
  v_ids uuid[] := '{}';
begin
  if my_role() is null then raise exception 'Không có quyền'; end if;
  if jsonb_typeof(p_parts) is distinct from 'array' or jsonb_array_length(p_parts) = 0 then raise exception 'Không tìm thấy phần món'; end if;
  for r in select * from jsonb_array_elements(p_parts) loop
    select * into v_l from order_items where id = (r ->> 'line_id')::uuid for update;
    if not found then raise exception 'Không tìm thấy phần món'; end if;
    v_p := (select p from jsonb_array_elements(v_l.side_parts) p where p ->> 'station_id' = r ->> 'station_id' limit 1);
    if v_p is null then raise exception 'Không tìm thấy phần món'; end if;
    if v_l.status = 'void' then raise exception 'Món đã huỷ'; end if;
    v_from := (v_p ->> 'status')::item_status;
    continue when v_from = p_to;
    if p_to = 'void' then raise exception 'Không đổi được trạng thái này'; end if;
    if p_to = 'served' then
      perform _need('order.take');
      if v_from <> 'ready' then raise exception 'Chỉ bưng món đã xong'; end if;
    else
      perform _need('kitchen.work');
      v_back := (v_from = 'cooking' and p_to = 'new') or (v_from = 'ready' and p_to = 'cooking');
      if not (v_back or (v_from = 'new' and p_to in ('cooking', 'ready')) or (v_from = 'cooking' and p_to = 'ready')) then
        raise exception 'Không đổi được trạng thái này';
      end if;
      if v_back and not has_perm('kitchen.override')
         and coalesce((case when v_from = 'ready' then v_p ->> 'ready_at' else v_p ->> 'started_at' end)::timestamptz, '-infinity') < v_now - interval '2 minutes' then
        raise exception 'Quá 2 phút: cần quyền lùi trạng thái';
      end if;
    end if;
    update order_items set side_parts = _part_step(side_parts, (r ->> 'station_id')::uuid, p_to, v_now) where id = v_l.id;
    v_ids := v_ids || v_l.id;
  end loop;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'part_status', jsonb_build_object('parts', p_parts, 'to', p_to));
  return query select * from order_items where id = any(v_ids);
end $$;
revoke execute on function set_part_status(jsonb, item_status) from public, anon;
grant execute on function set_part_status(jsonb, item_status) to authenticated;

-- ---------------------------------------------------------------- xong phiếu, gọi lại, giục: side parts too

create or replace function bump_ticket(p_key text)
returns ticket_states language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_kitchen_or_manager();
  v_ids uuid[];
  v_parts uuid[];
  v_order uuid := split_part(p_key, '|', 3)::uuid;
  v_station uuid := split_part(p_key, '|', 2)::uuid;
  v_now timestamptz := now();
  v_t ticket_states;
begin
  select array_agg(id) into v_ids from order_items i where ticket_key(i) = p_key and replaced_by is null;
  select array_agg(id) into v_parts from _part_lines(p_key);
  if v_ids is null and v_parts is null then raise exception 'Không tìm thấy phiếu'; end if;
  if exists (select 1 from kitchen_notices where order_item_id = any(coalesce(v_ids, '{}') || coalesce(v_parts, '{}'))
             and ack_at is null and kind in ('void', 'modify')) then
    raise exception 'Bấm Đã biết HUỶ / SỬA trước khi báo xong phiếu';
  end if;
  update order_items set status = 'ready', started_at = coalesce(started_at, v_now), ready_at = v_now
  where id = any(coalesce(v_ids, '{}')) and status in ('new', 'cooking');
  update order_items i set side_parts = _part_step(i.side_parts, v_station, 'ready', v_now)
  where i.id = any(coalesce(v_parts, '{}')) and i.status <> 'void'
    and exists (select 1 from jsonb_array_elements(i.side_parts) p
                where (p ->> 'station_id')::uuid = v_station and p ->> 'status' in ('new', 'cooking'));
  update kitchen_notices set ack_at = v_now, ack_by = v_staff
  where kind = 'chase' and ack_at is null and order_id = v_order and station_id = v_station;
  insert into ticket_states (key, bumped_at, bumped_by) values (p_key, v_now, v_staff)
  on conflict (key) do update set bumped_at = v_now, bumped_by = v_staff
  returning * into v_t;
  return v_t;
end $$;

create or replace function recall_ticket(p_key text)
returns ticket_states language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_kitchen_or_manager();
  v_station uuid := split_part(p_key, '|', 2)::uuid;
  v_done timestamptz;
  v_found boolean;
  v_t ticket_states;
begin
  select coalesce(t.bumped_at,
                  greatest((select max(ready_at) from order_items i where ticket_key(i) = p_key),
                           (select max((p ->> 'ready_at')::timestamptz) from _part_lines(p_key) i, jsonb_array_elements(i.side_parts) p
                            where (p ->> 'station_id')::uuid = v_station)))
    into v_done
  from (select 1) x left join ticket_states t on t.key = p_key;
  if v_done < now() - interval '30 minutes' and not has_perm('kitchen.override') then
    raise exception 'Phiếu xong quá 30 phút: cần quyền gọi lại phiếu cũ';
  end if;
  update order_items i set status = 'cooking', ready_at = null
  where ticket_key(i) = p_key and replaced_by is null and status = 'ready';
  v_found := found;
  update order_items i set side_parts = _part_step(i.side_parts, v_station, 'cooking', now())
  where i.id in (select id from _part_lines(p_key)) and i.status <> 'void'
    and exists (select 1 from jsonb_array_elements(i.side_parts) p where (p ->> 'station_id')::uuid = v_station and p ->> 'status' = 'ready');
  v_found := v_found or found;
  if not v_found then raise exception 'Món của phiếu đã bưng hết'; end if;
  insert into ticket_states (key, recalled_at, recall_count) values (p_key, now(), 1)
  on conflict (key) do update set recalled_at = now(), recall_count = ticket_states.recall_count + 1, bumped_at = null
  returning * into v_t;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'recall_ticket', jsonb_build_object('ticket', p_key));
  return v_t;
end $$;

create or replace function chase_order(p_order uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_o.chased_at > now() - interval '3 minutes' then raise exception 'Vừa giục xong: chờ 3 phút rồi giục lại'; end if;
  if not exists (select 1 from _kitchen_parts(p_order) where status in ('new', 'cooking')) then
    raise exception 'Không có món nào đang chờ bếp';
  end if;
  insert into kitchen_notices (kind, order_id, station_id, text, created_by)
  select distinct 'chase'::notice_kind, p_order, k.station_id, 'GIỤC lần ' || (v_o.chase_count + 1), v_staff
  from _kitchen_parts(p_order) k where k.status in ('new', 'cooking');
  update orders set chased_at = now(), chase_count = chase_count + 1 where id = p_order returning * into v_o;
  return v_o;
end $$;
