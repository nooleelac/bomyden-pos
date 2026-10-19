-- Bò Mỹ Đen POS 0013: no more "Chờ dọn".
--
-- A table is Trống as soon as its last order is paid; nobody taps "Dọn xong" any more. Same rule as payOrder in
-- src/floor/engine.ts. The columns stay (always false) so open_table / chuyển bàn from 0004 keep working.

drop trigger if exists orders_set_cleaning on orders;
drop function if exists orders_set_cleaning();
drop function if exists mark_table_clean(uuid);

alter table shop_settings alter column require_table_cleaning set default false;
update shop_settings set require_table_cleaning = false where require_table_cleaning;
update tables set needs_cleaning = false where needs_cleaning;
