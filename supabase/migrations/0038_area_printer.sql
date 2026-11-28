-- Máy in theo khu: phiếu của bàn trong khu (tạm tính, phiếu chuyển khoản, hoá đơn) in ra máy in WiFi/LAN của khu,
-- qua app cầu nối của khu đó (0018). null = mỗi máy in ra máy in của chính nó (Cài đặt → Máy in).
-- Shape: {"agentId": uuid, "agentName": text, "host": text, "port": int, "name": text}.
-- The floor snapshot (0008) reads areas with to_jsonb, so the column reaches every device without other changes;
-- editing follows the areas policy (tables.edit, 0009).

alter table areas add column if not exists printer jsonb;

alter table areas add constraint areas_printer_shape check (
  printer is null or (
    jsonb_typeof(printer) = 'object'
    and printer ? 'agentId' and printer ? 'host'
    and octet_length(printer::text) < 1000
  )
);
