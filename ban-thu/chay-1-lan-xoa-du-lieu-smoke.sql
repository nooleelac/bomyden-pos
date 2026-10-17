-- Bò Mỹ Đen: chạy một lần trong SQL Editor của dự án bomyden-pos-thu (lvwxotfkoiehvkcybakk).
-- Xoá dữ liệu của lần chạy thử tự động (đơn Bàn 20, hoá đơn HD000001, ca "Quầy thử (smoke)"). Không đụng đơn, ca, máy của chủ quán.

begin;
delete from bills where order_id = 'b3be5b61-91c5-4a2a-b4d1-774325611fbb';          -- payments cascade
delete from kitchen_notices where order_id = 'b3be5b61-91c5-4a2a-b4d1-774325611fbb';
delete from ticket_states where key like '%b3be5b61-91c5-4a2a-b4d1-774325611fbb%';
delete from orders where id = 'b3be5b61-91c5-4a2a-b4d1-774325611fbb';                -- items, modifiers, order_tables, approvals cascade
delete from shifts where register = 'Quầy thử (smoke)' and not exists (select 1 from bills b where b.shift_id = shifts.id);
-- the three test devices (already switched off); their sessions go with them, codes/approvals/audit keep a null device
delete from devices where name like 'Smoke - %' and not active;
-- bill numbers start again at HD000001 when no other bill exists yet
select setval('bill_no_seq', greatest(1, coalesce((select max(substr(bill_no, 3)::int) from bills), 0)), (select count(*) > 0 from bills));
commit;
