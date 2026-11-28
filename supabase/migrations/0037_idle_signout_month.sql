-- 0037: "Tự đăng xuất khi để yên" up to a month (44 640 phút = 31 ngày) instead of 4 hours, for a till that one
-- person keeps signed in. touch_session / staff_sign_in already read the minutes from the settings.

alter table branch_settings drop constraint shop_settings_idle_signout_min_check;
alter table branch_settings add constraint shop_settings_idle_signout_min_check check (idle_signout_min between 1 and 44640);
