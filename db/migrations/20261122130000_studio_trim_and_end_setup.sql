-- 2026-11-22 (Londi's promo test of the MCP connector): two things the app could not do, found while making a short from
-- chat. @anlim
-- 1. Trim: a 10 s clip ended on 3.5 s of empty beach and nothing could shorten it. Each shot now keeps how much to cut
--    off its kept clip's start and end; the scene cut honours it (worker/src/assemble.js).
-- 2. An end frame with the cast placed from their reference photos: request_end_frame only edits the start frame, so a
--    character who is not in the start frame (re-forming from particles, walking in) gets a face the model invents. A
--    "new setup" end frame places the shot's characters onto the approved start frame, exactly as a new-setup start
--    frame places them onto the location's empty plate (the worker already handles kind 'end' + mode 'new_setup').

alter table studio.shots
  add column if not exists trim_start_s numeric not null default 0 check (trim_start_s >= 0 and trim_start_s <= 60),
  add column if not exists trim_end_s numeric not null default 0 check (trim_end_s >= 0 and trim_end_s <= 60);

create or replace function studio.set_shot_trim(p_shot uuid, p_start numeric, p_end numeric)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_len numeric;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  if coalesce(p_start, 0) < 0 or coalesce(p_end, 0) < 0 then raise exception 'trims are seconds to cut off, 0 or more'; end if;
  select sh.duration_s into v_len from studio.shots sh where sh.id = p_shot;
  if coalesce(p_start, 0) + coalesce(p_end, 0) > greatest(coalesce(v_len, 0) - 1, 0) then
    raise exception 'that leaves less than 1 second of a % s clip', round(coalesce(v_len, 0), 1); end if;
  update studio.shots set trim_start_s = round(coalesce(p_start, 0), 2), trim_end_s = round(coalesce(p_end, 0), 2) where id = p_shot;
end $$;

create or replace function studio.request_end_setup(p_shot uuid, p_instruction text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_shot studio.shots; v_cost int := 20; v_ins text := nullif(trim(coalesce(p_instruction, '')), '');
        v_refs text[]; v_names text[]; v_heights numeric[]; v_missing text; v_n int; v_endpoint text := 'fal-ai/nano-banana-2/edit';
        v_look text; v_id uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  if v_ins is null then raise exception 'say where everyone is and what they are doing at the end'; end if;
  if length(v_ins) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then raise exception 'approve the start frame first'; end if;
  if studio.shot_busy(p_shot) or exists (select 1 from studio.frame_jobs where shot_id = p_shot and status in ('queued','running','composing')) then
    raise exception 'wait until the render or frame in progress is done'; end if;
  select se.look into v_look from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = v_shot.scene_id;
  select array_agg(c.ref_front_path order by c.height_units desc nulls last, c.name), array_agg(c.name order by c.height_units desc nulls last, c.name),
         array_agg(c.height_units order by c.height_units desc nulls last, c.name), count(*),
         string_agg(c.name, ', ') filter (where c.ref_front_path is null)
    into v_refs, v_names, v_heights, v_n, v_missing
    from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
   where sc.id = v_shot.scene_id and (cardinality(v_shot.cast_ids) = 0 or c.id = any(v_shot.cast_ids));
  if coalesce(v_n, 0) = 0 then raise exception 'the shot has nobody in it: add characters to the series or the shot'; end if;
  if v_missing is not null then raise exception 'add a reference image for %', v_missing; end if;
  if v_n > 6 then raise exception 'at most 6 characters in a new setup (this shot has %)', v_n; end if;
  if v_look = 'photoreal' then v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 17 + 3 * v_n; end if;
  perform studio.reserve_frame_credits(v_owner, v_cost);
  insert into studio.frame_jobs(owner, shot_id, kind, mode, instruction, source_path, ref_paths, ref_names, ref_heights,
                                endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'end', 'new_setup', v_ins, v_shot.start_frame_path, v_refs, v_names, coalesce(v_heights, '{}'),
            v_endpoint, case when v_endpoint like 'openai/gpt-image%' then 0.068 + 0.012 * v_n else 0.08 end, v_cost)
    returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id);
  update studio.shots set end_instruction = v_ins where id = p_shot;
  return v_id;
end $$;

-- the scene cut carries each shot's trims to the worker
create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_format not in ('16x9', '9x16', '4x5', '1x1', '4x3', '3x4', '21x9') then
    raise exception 'format must be 16x9, 9x16, 4x5, 1x1, 4x3, 3x4 or 21x9'; end if;
  if exists (select 1 from studio.assemblies where owner = v_owner and status in ('queued', 'running')) then
    raise exception 'a cut is already being made; wait for it to finish';
  end if;
  v_music := nullif(trim(coalesce(p_options->>'music_path', '')), '');
  if v_music is not null and (left(v_music, 37) <> v_owner::text || '/' or v_music like '%..%') then
    raise exception 'music must be a file you uploaded or a score made for you';
  end if;
  v_opts := jsonb_build_object('fade', coalesce((p_options->>'fade')::boolean, true),
                               'end_card', coalesce((p_options->>'end_card')::boolean, false),
                               'music_path', v_music,
                               'voice', coalesce((p_options->>'voice')::boolean, true),
                               'sfx', coalesce((p_options->>'sfx')::boolean, true));
  select coalesce(jsonb_agg(jsonb_build_object('shot_id', sh.id, 'ord', sh.ord, 'generation_id', g.id, 'path', g.output_path,
           'trim_start', sh.trim_start_s, 'trim_end', sh.trim_end_s,
           'vo', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.in_cut and a.status = 'done' limit 1),
           'sfx', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'sfx' and a.in_cut and a.status = 'done' limit 1))
                            order by sh.ord), '[]'::jsonb)
    into v_items
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null;
  if jsonb_array_length(v_items) = 0 then raise exception 'approve at least one clip in this scene first'; end if;
  select coalesce(jsonb_agg(sh.ord order by sh.ord), '[]'::jsonb) into v_skipped
    from studio.shots sh left join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and (sh.approved_generation_id is null or g.output_path is null);
  insert into studio.assemblies(owner, scene_id, format, options, items, skipped)
  values (v_owner, p_scene, p_format, v_opts, v_items, v_skipped) returning id into v_id;
  return v_id;
end $$;

revoke all on function studio.set_shot_trim(uuid, numeric, numeric) from public;
revoke all on function studio.request_end_setup(uuid, text) from public;
grant execute on function studio.set_shot_trim(uuid, numeric, numeric) to authenticated;
grant execute on function studio.request_end_setup(uuid, text) to authenticated;
