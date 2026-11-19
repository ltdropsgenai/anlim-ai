-- Security review 2026-11-19: a size limit on every file in bucket "studio" (300 MB: room for long scene cuts made
-- by the worker; the app itself limits uploads to 15 MB images and 30 MB music, and the worker refuses larger music).
update storage.buckets set file_size_limit = 314572800 where id = 'studio';
