-- Bò Mỹ Đen POS 0011: Xoá vĩnh viễn on Supabase, on top of 0010.
-- 0010 emptied links (orders.table_id, order_items.created_by …) with session_replication_role = replica so the
-- business triggers (a closed order refuses any update …) stay out of the way. Supabase refuses that setting
-- ("permission denied to set parameter"), so there the update ran with the triggers and deleting a table that had
-- paid orders, or a person who had served orders, failed.
-- Now, where replica is refused, the table's own triggers that are on are switched off for that one UPDATE and on
-- again right after, inside the same transaction (ALTER TABLE locks the table until commit, so no other session
-- ever writes while they are off; an error rolls the switch back too). Foreign-key checks are internal triggers and
-- keep running.

drop function _update_untriggered(text);

create function _update_untriggered(p_rel regclass, p_set text, p_where text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prev text := current_setting('session_replication_role');
  v_sql text := format('update %s set %s where %s', p_rel, p_set, p_where);
  v_replica boolean := false;
  v_trigs text[];
  t text;
begin
  begin
    perform set_config('session_replication_role', 'replica', true);
    v_replica := true;
  exception when insufficient_privilege then
    null;
  end;
  if v_replica then
    execute v_sql;
    perform set_config('session_replication_role', v_prev, true);
    return;
  end if;
  select array_agg(tgname) into v_trigs from pg_trigger where tgrelid = p_rel and not tgisinternal and tgenabled = 'O';
  foreach t in array coalesce(v_trigs, '{}') loop
    execute format('alter table %s disable trigger %I', p_rel, t);
  end loop;
  execute v_sql;
  foreach t in array coalesce(v_trigs, '{}') loop
    execute format('alter table %s enable trigger %I', p_rel, t);
  end loop;
end $$;

create or replace function _purge(p_rel regclass, p_where text, p_depth int default 0) returns void
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
      perform _update_untriggered(r.child, r.set_null, v_cond);
    end if;
  end loop;
  execute format('delete from %s where %s', p_rel, v_where);
end $$;

revoke execute on function _update_untriggered(regclass, text, text) from public, anon, authenticated;
