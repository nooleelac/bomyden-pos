-- Bò Mỹ Đen POS 0031: the webhook token comes from Pay2S, on top of 0030.
-- Pay2S makes the token itself when a webhook is added (Token riêng), so the owner pastes it into
-- Cài đặt → Thanh toán → Tự xác nhận chuyển khoản instead of the app making one. The feed cannot be turned on without it.

drop function if exists bank_feed_setup(boolean, boolean);
create or replace function bank_feed_setup(p_on boolean, p_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tok text := btrim(coalesce(p_token, ''));
begin
  perform _need_owner();
  if p_token is not null then
    if length(v_tok) < 16 or v_tok ~ '\s' then raise exception 'Token Pay2S không hợp lệ: chép lại đủ cả chuỗi'; end if;
    update bank_feed_config set token = v_tok where id = 1;
  end if;
  if coalesce(p_on, false) and (select token from bank_feed_config where id = 1) = '' then
    raise exception 'Dán token webhook của Pay2S trước khi bật';
  end if;
  update bank_feed_config set enabled = coalesce(p_on, false) where id = 1;
  perform _audit('bank_feed', jsonb_build_object('on', coalesce(p_on, false), 'new_token', p_token is not null));
  return bank_feed_status();
end $$;
revoke execute on function bank_feed_setup(boolean, text) from public, anon;
grant execute on function bank_feed_setup(boolean, text) to authenticated;
