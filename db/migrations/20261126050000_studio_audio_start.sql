-- A start delay for a shot's sound (2026-11-25, Londi): a sound effect or a shot's voiceover can start partway into its
-- shot in the cut. start_offset_s is seconds after the shot starts in the cut (after trims and speed changes); the
-- worker (assemble.js mix) places the take there and fades it out over 0.15 s at the shot's end if it would run past.
-- set_audio_start changes an existing take's start without making it again (no ElevenLabs credits). The check against
-- the shot's length in the cut is made by studio-mcp (it has the cut's frame maths) and again by the worker. @anlim

alter table studio.audio_jobs add column if not exists start_offset_s numeric default 0;
alter table studio.audio_jobs drop constraint if exists audio_jobs_start_offset_range;
alter table studio.audio_jobs add constraint audio_jobs_start_offset_range
  check (start_offset_s is null or (start_offset_s >= 0 and start_offset_s <= 30));

create or replace function studio.set_audio_start(p_id uuid, p_s numeric)
returns void language plpgsql security definer set search_path to '' as $$
declare j studio.audio_jobs;
begin
  select * into j from studio.audio_jobs where id = p_id and owner = auth.uid();
  if j.id is null then raise exception 'not found'; end if;
  if j.shot_id is null or j.kind not in ('sfx', 'voiceover') then
    raise exception 'only a shot''s sound effect or voiceover has a start delay (the narration has its own start: set_narration_start)';
  end if;
  if p_s is null or p_s < 0 or p_s > 30 then raise exception 'start_s must be from 0 to 30 seconds'; end if;
  update studio.audio_jobs set start_offset_s = round(p_s, 2), updated_at = now() where id = p_id;
end $$;

revoke all on function studio.set_audio_start(uuid, numeric) from public, anon;
grant execute on function studio.set_audio_start(uuid, numeric) to authenticated;
