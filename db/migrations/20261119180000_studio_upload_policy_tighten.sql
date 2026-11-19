-- Security review 2026-11-19: creators could upload any file, of any type, anywhere under their own folder (the app's
-- type and size checks run in the browser only). Uploads are now limited to the folders the app uses and to image or
-- audio extensions. The worker and Edge Functions upload with signed URLs made by the service role, not this policy.
drop policy if exists studio_files_write on storage.objects;
create policy studio_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'studio'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 2
  and (
    ((storage.foldername(name))[2] in ('stills', 'characters', 'locations') and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp'))
    or ((storage.foldername(name))[2] = 'music' and lower(storage.extension(name)) in ('mp3', 'wav', 'm4a', 'aac', 'mp4'))
  )
);
