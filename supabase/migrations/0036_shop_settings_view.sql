-- Bò Mỹ Đen POS 0036: the shop_settings view shows every branch_settings column again.
--
-- 0022 made shop_settings a view, "select * from branch_settings where branch_id = my_branch_id()". Postgres fixes
-- the column list of a view when it is created, so the columns added later (guest_order 0023, guest_call_chips 0025,
-- guest_geo_* 0026, online_order and online_ship 0027) never showed in it. get_floor_state reads the shop from this
-- view, so the staff screens read them as missing: Đặt hàng online looked off (with the default shipping prices,
-- which a save there would have written over the real ones), the QR page had no shop position or guest-call buttons.
--
-- Recreating the view picks up today's columns (new ones only go at the end, so "create or replace" keeps the old
-- ones and their grants). A migration that adds a column to branch_settings must run this statement again.

create or replace view shop_settings with (security_invoker = true) as
  select * from branch_settings where branch_id = my_branch_id();
grant select, update on shop_settings to authenticated;
