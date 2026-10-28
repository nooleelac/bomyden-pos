-- Bò Mỹ Đen POS 0018: in qua WiFi/LAN bằng app cầu nối (Cài đặt → Máy in).
--
-- A browser cannot open a connection to a printer on the shop network, so a small bridge app runs on a shop computer
-- (public/cau-noi-may-in.mjs): it finds printers on the network (port 9100), reports them here, and prints the jobs
-- any device (iPad included) queues here.
--
--   print_agents   one row per bridge: name, hash of its secret token, printers it found, last time it checked in
--   print_jobs     ESC/POS bytes (base64) for one printer of one bridge; queued → printing → done / failed
--
-- Staff use the print_* functions (signed-in device, permissions below); the bridge uses the agent_* functions with
-- its token only (anon key, no device, no staff). Neither table is readable through the API.

create table print_agents (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique,
  printers jsonb not null default '[]'::jsonb,
  rescan boolean not null default false,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);
alter table print_agents enable row level security;
revoke all on print_agents from anon, authenticated;

create table print_jobs (
  id bigserial primary key,
  agent_id uuid not null references print_agents on delete cascade,
  host text not null check (host ~ '^[0-9A-Za-z.:-]{1,100}$'),
  port int not null default 9100 check (port between 1 and 65535),
  data text not null check (char_length(data) between 4 and 3000000),
  title text not null default '' check (char_length(title) <= 100),
  status text not null default 'queued' check (status in ('queued', 'printing', 'done', 'failed')),
  error text not null default '',
  staff_id uuid,
  device_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index print_jobs_queue on print_jobs (agent_id, id) where status = 'queued';
alter table print_jobs enable row level security;
revoke all on print_jobs from anon, authenticated;

-- ---------------------------------------------------------------- staff side

-- whoever may print a receipt: waiters (pre-bill), cashiers, shift managers, settings
create function _need_print() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if my_staff_id() is null then raise exception 'Đăng nhập trước khi làm việc này'; end if;
  if not (has_perm('order.take') or has_perm('pay.collect') or has_perm('shift.manage') or has_perm('settings.edit')) then
    raise exception 'Chưa có quyền in';
  end if;
end $$;

-- bridges with the printers they found; online = checked in within the last 30 seconds
create function print_agents_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _need_print();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'printers', printers, 'lastSeen', last_seen,
                                        'online', coalesce(last_seen > now() - interval '30 seconds', false)) order by name)
    from print_agents), '[]'::jsonb);
end $$;

-- a new bridge: returns its token once (only the hash is kept)
create function print_agent_create(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_token text := _token();
begin
  perform _need('settings.edit');
  insert into print_agents (name, token_hash) values (trim(p_name), _hash(v_token));
  perform _audit('print_agent_create', jsonb_build_object('name', trim(p_name)));
  return v_token;
end $$;

create function print_agent_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('settings.edit');
  delete from print_agents where id = p_id;
  perform _audit('print_agent_delete', jsonb_build_object('id', p_id));
end $$;

-- ask the bridge to look for printers again at its next check-in
create function print_agent_rescan(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need_print();
  update print_agents set rescan = true where id = p_id;
end $$;

create function print_submit(p_agent uuid, p_host text, p_port int, p_data text, p_title text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform _need_print();
  if not exists (select 1 from print_agents where id = p_agent) then raise exception 'Không tìm thấy app cầu nối máy in'; end if;
  insert into print_jobs (agent_id, host, port, data, title, staff_id, device_id)
  values (p_agent, p_host, p_port, p_data, coalesce(p_title, ''), my_staff_id(), my_device_id())
  returning id into v_id;
  return v_id;
end $$;

create function print_job_status(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _need_print();
  return (select jsonb_build_object('status', status, 'error', error) from print_jobs where id = p_id);
end $$;

-- ---------------------------------------------------------------- bridge side (token only)

-- Check in: saves the printers found (when given), hands out up to 5 queued jobs and says whether to rescan.
-- Jobs nobody picked up within 2 minutes fail; finished jobs are kept a day.
create function agent_poll(p_token text, p_printers jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_agent print_agents;
  v_jobs jsonb;
begin
  select * into v_agent from print_agents where token_hash = _hash(coalesce(p_token, ''));
  if v_agent.id is null then raise exception 'Mã kết nối không đúng hoặc cầu nối đã bị xoá'; end if;
  update print_agents set last_seen = now(),
         printers = case when jsonb_typeof(p_printers) = 'array' then p_printers else printers end,
         rescan = case when p_printers is not null then false else rescan end
   where id = v_agent.id;
  update print_jobs set status = 'failed', error = 'Cầu nối không nhận lệnh in kịp', finished_at = now()
   where status in ('queued', 'printing') and created_at < now() - interval '2 minutes';
  delete from print_jobs where finished_at < now() - interval '1 day';
  with picked as (
    select id from print_jobs where agent_id = v_agent.id and status = 'queued' order by id limit 5 for update skip locked
  ), upd as (
    update print_jobs j set status = 'printing' from picked where j.id = picked.id returning j.id, j.host, j.port, j.data
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'host', host, 'port', port, 'data', data) order by id), '[]'::jsonb) into v_jobs from upd;
  return jsonb_build_object('name', v_agent.name, 'rescan', v_agent.rescan, 'jobs', v_jobs);
end $$;

create function agent_done(p_token text, p_id bigint, p_error text default '') returns void
language plpgsql security definer set search_path = public as $$
declare v_agent uuid;
begin
  select id into v_agent from print_agents where token_hash = _hash(coalesce(p_token, ''));
  if v_agent is null then raise exception 'Mã kết nối không đúng hoặc cầu nối đã bị xoá'; end if;
  update print_jobs set status = case when coalesce(p_error, '') = '' then 'done' else 'failed' end,
         error = left(coalesce(p_error, ''), 300), finished_at = now()
   where id = p_id and agent_id = v_agent;
end $$;

revoke execute on function _need_print() from public, anon, authenticated;
revoke execute on function print_agents_list(), print_agent_create(text), print_agent_delete(uuid), print_agent_rescan(uuid),
  print_submit(uuid, text, int, text, text), print_job_status(bigint) from public, anon;
grant execute on function print_agents_list(), print_agent_create(text), print_agent_delete(uuid), print_agent_rescan(uuid),
  print_submit(uuid, text, int, text, text), print_job_status(bigint) to authenticated;
revoke execute on function agent_poll(text, jsonb), agent_done(text, bigint, text) from public;
grant execute on function agent_poll(text, jsonb), agent_done(text, bigint, text) to anon, authenticated;
