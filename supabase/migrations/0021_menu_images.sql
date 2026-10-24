-- Bò Mỹ Đen POS 0021: a photo per dish, shown on the order screen tiles.
--
--   menu_items.image_url   public URL in the menu-images bucket; null = no photo (the tile shows the name only)
--
-- The editor shrinks the photo to a small webp before upload, so the bucket stays tiny. Anyone may read (the
-- order screen loads them as plain <img>); only menu.edit may write. Storage requests carry no x-staff-session
-- header, so writes use reader_can (the device's current session), like the read policies.

alter table menu_items add column image_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy menu_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and (select public.reader_can('menu.edit')));
create policy menu_images_update on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and (select public.reader_can('menu.edit')));
create policy menu_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'menu-images' and (select public.reader_can('menu.edit')));
