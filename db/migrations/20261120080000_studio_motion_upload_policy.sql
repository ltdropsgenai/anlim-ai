-- Motion transfer uploads (2026-11-20): the creator's source clip and reference images go to <owner>/motion/.
-- Same rule as the 2026-11-19 tightening: one folder level under the owner, known extensions only. @anlim
drop policy if exists studio_files_write on storage.objects;
create policy studio_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'studio'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 2
  and (
    ((storage.foldername(name))[2] in ('stills', 'characters', 'locations') and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp'))
    or ((storage.foldername(name))[2] = 'music' and lower(storage.extension(name)) in ('mp3', 'wav', 'm4a', 'aac', 'mp4'))
    or ((storage.foldername(name))[2] = 'motion' and lower(storage.extension(name)) in ('mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg', 'webp'))
  )
);
