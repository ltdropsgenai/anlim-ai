-- Review 2026-11-21: three tables from an old ride-app pilot shared this project, readable and writable by anyone with
-- the public key (policies "pilot read/write ..." with true). Londi approved dropping them. @anlim
drop table if exists public.driver_locations cascade;
drop table if exists public.ride_requests cascade;
drop table if exists public.drivers cascade;
