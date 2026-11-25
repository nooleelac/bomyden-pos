-- 0034: apply only AFTER the app that signs in with tên đăng nhập + PIN (0033) is deployed everywhere.
-- The old name list and the by-id sign-in / approval calls stay for SQL tests and the admin only:
-- a device that nobody signed in on can no longer read the staff list.

revoke execute on function signin_roster(), staff_sign_in(uuid, text), verify_manager_pin(uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;
