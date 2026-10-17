-- Bò Mỹ Đen POS 0005: cashier (thu ngân) and shifts (ca) on top of 0001–0004.
-- Same rules as src/floor/engine.ts (payOrder, printBill, openShift, closeShift) and src/cashier/shift.ts
-- (shiftSummary); bill maths stay in calc_bill (0002) = billTotals in src/lib/pricing.ts. Keep them in step.
--
-- How clients write after this migration (all RPCs, security definer, role-checked):
--   open_shift(float, register)                       Mở ca: one open shift per register, opening float
--   pay_order(order, discount, payments, reason, register)
--                                                     one bill, any mix of cash / bank / card; amounts add up to
--                                                     calc_bill's total exactly; only cash carries `tendered`
--                                                     (change); transfer + card never above the total;
--                                                     a bill discount needs a reason; money goes into the open shift
--   print_bill(bill)                                  counts receipt prints; the 2nd+ print says IN LẠI
--   shift_summary(shift)                              totals by method, expected cash (read-only)
--   close_shift(shift, count by note, note)           expected vs counted; a difference needs a note
-- Left for later: verify_manager_pin (a bill discount is allowed for cashiers here; the PIN is checked on the
-- device only), petty cash in/out (phiếu thu/chi), deposits, e-invoice, refunds and reopening a bill.

-- ---------------------------------------------------------------- settings

alter table shop_settings add column bank_name text not null default '';   -- printed under the VietQR

-- ---------------------------------------------------------------- shifts

create table shifts (
  id uuid primary key default gen_random_uuid(),
  register text not null default 'Quầy 1' check (char_length(register) between 1 and 30),
  opened_by uuid not null references staff,
  opened_at timestamptz not null default now(),
  opening_float int not null check (opening_float >= 0),               -- tiền lẻ đầu ca
  closed_at timestamptz,
  closed_by uuid references staff,
  counted_cash int check (counted_cash >= 0),
  counted_detail jsonb not null default '{}',                           -- {"500000": 3, "10000": 2}
  expected_cash int,                                                    -- float + cash taken, at close
  note text not null default '' check (char_length(note) <= 200),
  check ((closed_at is null) = (counted_cash is null) and (closed_at is null) = (expected_cash is null))
);
create unique index shifts_one_open on shifts (register) where closed_at is null;
create index shifts_opened on shifts (opened_at);

alter table bills
  add column shift_id uuid references shifts,
  add column discount_reason text not null default '',
  add column print_count int not null default 0 check (print_count >= 0),
  add column last_print_at timestamptz,
  add column last_print_by uuid references staff;
create index bills_shift on bills (shift_id);
create index bills_paid_at on bills (paid_at);

alter table payments
  add column shift_id uuid references shifts,
  add column ref text not null default '' check (char_length(ref) <= 40),   -- card last 4 / slip no., bank ref
  add column received_by uuid references staff,
  add column received_at timestamptz not null default now();
create index payments_bill on payments (bill_id);

-- ---------------------------------------------------------------- pay

drop function pay_order(uuid, int, jsonb);

create function pay_order(p_order uuid, p_discount int, p_payments jsonb, p_discount_reason text default null,
                          p_register text default 'Quầy 1')
returns bills language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_order orders;
  v_shift shifts;
  v_calc jsonb;
  v_total int;
  v_paid numeric;
  v_noncash numeric;
  v_bill bills;
  v_reason text := btrim(coalesce(p_discount_reason, ''));
  p jsonb;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_order.paying_at is not null and v_order.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán ở máy khác'; end if;
  -- share lock: payments run side by side, close_shift waits for them
  select * into v_shift from shifts where register = p_register and closed_at is null for share;
  if not found then raise exception 'Chưa mở ca thu ngân: mở ca trước khi thu tiền'; end if;
  if not exists (select 1 from order_items where order_id = p_order and status <> 'void') then raise exception 'Đơn chưa có món'; end if;
  if coalesce(p_discount, 0) > 0 and v_reason = '' then raise exception 'Chọn lý do giảm giá'; end if;
  -- TODO(manager PIN): require an approval token from verify_manager_pin for a cashier's discount.

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Danh sách thanh toán không hợp lệ'; end if;
  for p in select value from jsonb_array_elements(p_payments) loop
    if coalesce(p ->> 'method', '') not in ('cash', 'bank', 'card') then raise exception 'Cách trả không hợp lệ'; end if;
    if jsonb_typeof(p -> 'amount') is distinct from 'number' or (p ->> 'amount')::numeric <= 0
       or (p ->> 'amount')::numeric <> trunc((p ->> 'amount')::numeric) then
      raise exception 'Số tiền mỗi khoản phải là số đồng dương';
    end if;
    if jsonb_typeof(p -> 'tendered') = 'number'
       and (p ->> 'method' <> 'cash' or (p ->> 'tendered')::numeric < (p ->> 'amount')::numeric
            or (p ->> 'tendered')::numeric <> trunc((p ->> 'tendered')::numeric)) then
      raise exception 'Tiền khách đưa chỉ ghi cho tiền mặt và không nhỏ hơn số thu';
    end if;
  end loop;

  v_calc := calc_bill(p_order, coalesce(p_discount, 0));
  v_total := (v_calc ->> 'total')::int;
  select coalesce(sum((value ->> 'amount')::numeric), 0), coalesce(sum((value ->> 'amount')::numeric) filter (where value ->> 'method' <> 'cash'), 0)
  into v_paid, v_noncash from jsonb_array_elements(p_payments);
  if v_noncash > v_total then raise exception 'Chuyển khoản và thẻ không được vượt số phải thu'; end if;
  if v_paid <> v_total then raise exception 'Tổng thanh toán % khác số phải trả %', v_paid, v_total; end if;

  insert into bills (order_id, subtotal, discount, service_charge, vat_added, vat_total, rounding, total, vat_lines,
                     table_label, cashier_id, shift_id, discount_reason)
  values (p_order, (v_calc ->> 'subtotal')::int, coalesce(p_discount, 0), (v_calc ->> 'service_charge')::int,
          (v_calc ->> 'vat_added')::int, (v_calc ->> 'vat_total')::int, (v_calc ->> 'rounding')::int, v_total,
          v_calc -> 'vat', coalesce(order_group_label(p_order), order_label(p_order), ''), v_staff, v_shift.id,
          case when coalesce(p_discount, 0) > 0 then left(v_reason, 60) else '' end)
  returning * into v_bill;
  insert into payments (bill_id, method, amount, tendered, ref, shift_id, received_by)
  select v_bill.id, (value ->> 'method')::pay_method, (value ->> 'amount')::int,
         case when value ->> 'method' = 'cash' and jsonb_typeof(value -> 'tendered') = 'number'
                   and (value ->> 'tendered')::int > (value ->> 'amount')::int then (value ->> 'tendered')::int end,
         left(coalesce(value ->> 'ref', ''), 40), v_shift.id, v_staff
  from jsonb_array_elements(p_payments) with ordinality;

  update orders set status = 'paid', closed_at = now(), paying_at = null, paying_by = null where id = p_order;
  if coalesce(p_discount, 0) > 0 then
    insert into audit_log (staff_id, action, detail)
    values (v_staff, 'discount', jsonb_build_object('bill', v_bill.bill_no, 'amount', p_discount, 'reason', v_bill.discount_reason));
  end if;
  return v_bill;
end $$;

-- In hoá đơn: one more print. Reprints are logged.
create function print_bill(p_bill uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_b bills;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được in hoá đơn'; end if;
  update bills set print_count = print_count + 1, last_print_at = now(), last_print_by = v_staff where id = p_bill returning * into v_b;
  if not found then raise exception 'Không tìm thấy hoá đơn'; end if;
  if v_b.print_count > 1 then
    insert into audit_log (staff_id, action, detail) values (v_staff, 'reprint', jsonb_build_object('bill', v_b.bill_no, 'print', v_b.print_count));
  end if;
  return v_b.print_count;
end $$;

-- ---------------------------------------------------------------- shifts

create function open_shift(p_float int, p_register text default 'Quầy 1')
returns shifts language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_s shifts;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được mở ca'; end if;
  if p_float is null or p_float < 0 then raise exception 'Tiền đầu ca phải là số đồng không âm'; end if;
  if exists (select 1 from shifts where register = p_register and closed_at is null) then
    raise exception '% đang có ca mở: chốt ca cũ trước', p_register;
  end if;
  insert into shifts (register, opened_by, opening_float) values (p_register, v_staff, p_float) returning * into v_s;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'open_shift', jsonb_build_object('shift', v_s.id, 'float', p_float));
  return v_s;
end $$;

-- Totals of a shift (shiftSummary in src/cashier/shift.ts).
create function shift_summary(p_shift uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with b as (select * from bills where shift_id = p_shift),
       p as (select pm.* from payments pm join b on b.id = pm.bill_id)
  select jsonb_build_object(
    'bills', (select count(*) from b),
    'subtotal', (select coalesce(sum(subtotal), 0) from b),
    'discount', (select coalesce(sum(discount), 0) from b),
    'service_charge', (select coalesce(sum(service_charge), 0) from b),
    'rounding', (select coalesce(sum(rounding), 0) from b),
    'sales', (select coalesce(sum(total), 0) from b),
    'vat_total', (select coalesce(sum(vat_total), 0) from b),
    'by_method', jsonb_build_object(
      'cash', (select coalesce(sum(amount), 0) from p where method = 'cash'),
      'bank', (select coalesce(sum(amount), 0) from p where method = 'bank'),
      'card', (select coalesce(sum(amount), 0) from p where method = 'card')),
    'cash_tendered', (select coalesce(sum(coalesce(tendered, amount)), 0) from p where method = 'cash'),
    'change_given', (select coalesce(sum(coalesce(tendered, amount) - amount), 0) from p where method = 'cash'),
    'opening_float', s.opening_float,
    'expected_cash', s.opening_float + (select coalesce(sum(amount), 0) from p where method = 'cash'))
  from shifts s where s.id = p_shift
$$;

-- Chốt ca: count by note, compare with float + cash taken; a difference needs a note.
create function close_shift(p_shift uuid, p_detail jsonb, p_note text default '')
returns shifts language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_s shifts;
  v_counted bigint := 0;
  v_expected int;
  v_note text := btrim(coalesce(p_note, ''));
  k text;
  v jsonb;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được chốt ca'; end if;
  select * into v_s from shifts where id = p_shift for update;   -- waits for payments still running
  if not found then raise exception 'Không tìm thấy ca'; end if;
  if v_s.closed_at is not null then raise exception 'Ca đã chốt'; end if;
  if exists (select 1 from orders where status = 'open' and paying_at is not null) then
    raise exception 'Còn đơn đang thanh toán: thu xong hoặc huỷ thanh toán trước khi chốt ca';
  end if;
  if p_detail is null or jsonb_typeof(p_detail) <> 'object' then raise exception 'Số tờ không hợp lệ'; end if;
  for k, v in select key, value from jsonb_each(p_detail) loop
    if k not in ('500000', '200000', '100000', '50000', '20000', '10000', '5000', '2000', '1000') then
      raise exception 'Mệnh giá không hợp lệ: %', k;
    end if;
    if jsonb_typeof(v) <> 'number' or v::numeric < 0 or v::numeric <> trunc(v::numeric) then raise exception 'Số tờ không hợp lệ: %', v; end if;
    v_counted := v_counted + k::bigint * v::bigint;
  end loop;
  v_expected := (shift_summary(p_shift) ->> 'expected_cash')::int;
  if v_counted <> v_expected and v_note = '' then raise exception 'Két lệch so với dự kiến: ghi lý do'; end if;
  update shifts set closed_at = now(), closed_by = v_staff, counted_cash = v_counted, expected_cash = v_expected, note = v_note,
                    counted_detail = coalesce((select jsonb_object_agg(key, value) from jsonb_each(p_detail) where value::numeric > 0), '{}')
  where id = p_shift returning * into v_s;
  insert into audit_log (staff_id, action, detail)
  values (v_staff, 'close_shift', jsonb_build_object('shift', p_shift, 'counted', v_counted, 'expected', v_expected, 'difference', v_counted - v_expected));
  return v_s;
end $$;

-- ---------------------------------------------------------------- security and realtime

alter table shifts enable row level security;
create policy read_all on shifts for select using (my_role() is not null);
-- shifts, bills and payments are only written through the RPCs above (no insert/update policies).

alter publication supabase_realtime add table bills, shifts;
