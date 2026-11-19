-- Worker login (password set out of band; never in a migration). studio schema only; RideLink's tables are refused.
-- create role studio_worker login password '...' connection limit 10;
grant usage on schema studio to studio_worker;
grant select on studio.models, studio.series, studio.characters, studio.locations, studio.scenes, studio.shots,
               studio.generations, studio.accounts to studio_worker;
grant update on studio.generations, studio.shots to studio_worker;
grant insert on studio.qc_runs to studio_worker;
grant execute on function studio.claim_generations(text, int, int), studio.settle_generation(uuid, text),
  studio.enqueue_free_retry(uuid) to studio_worker;
alter role studio_worker set search_path = studio, public;
create policy worker_all_generations on studio.generations for all to studio_worker using (true) with check (true);
create policy worker_all_shots on studio.shots for all to studio_worker using (true) with check (true);
create policy worker_read_series on studio.series for select to studio_worker using (true);
create policy worker_read_characters on studio.characters for select to studio_worker using (true);
create policy worker_read_locations on studio.locations for select to studio_worker using (true);
create policy worker_read_scenes on studio.scenes for select to studio_worker using (true);
create policy worker_read_models on studio.models for select to studio_worker using (true);
create policy worker_read_accounts on studio.accounts for select to studio_worker using (true);
create policy worker_insert_qc on studio.qc_runs for insert to studio_worker with check (true);
