-- Start frame from the description (2026-11-19, Londi: the home prompt should produce an actual image). A new
-- project has no location or characters, so continue / reposition / new_setup are all unavailable for its first
-- shot. Mode 'prompt' makes the start still straight from the shot's description (text to image, Nano Banana 2,
-- 16:9, 20 credits like the other frames). The creator can then cut character references out of it. @anlim
alter table studio.frame_jobs drop constraint frame_jobs_mode_check;
alter table studio.frame_jobs add constraint frame_jobs_mode_check
  check (mode = any (array['continue','reposition','new_setup','prompt']));

create or replace function studio.request_start_frame(p_shot uuid, p_mode text, p_instruction text default null, p_source text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_owner uuid; v_shot studio.shots; v_prev studio.shots; v_prev_clip text; v_src text; v_cost int := 20;
        v_ins text := nullif(trim(coalesce(p_instruction, '')), ''); v_id uuid; v_plate text;
        v_refs text[]; v_names text[]; v_heights numeric[]; v_missing text; v_n int; v_endpoint text := 'fal-ai/nano-banana-2/edit';
        v_look text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  if p_mode not in ('continue','reposition','new_setup','prompt') then raise exception 'mode must be continue, reposition, new_setup or prompt'; end if;
  if length(coalesce(v_ins, '')) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or frame in progress is done'; end if;
  select se.look into v_look from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = v_shot.scene_id;
  select * into v_prev from studio.shots where scene_id = v_shot.scene_id and ord < v_shot.ord order by ord desc limit 1;
  if v_prev.id is not null and v_prev.approved_generation_id is not null then
    select output_path into v_prev_clip from studio.generations where id = v_prev.approved_generation_id;
  end if;

  if p_mode = 'prompt' then
    -- no source image: the description is the whole input
    v_ins := coalesce(v_ins, left(v_shot.action, 1000));
    if v_ins is null then raise exception 'say what happens in the shot first'; end if;
    v_src := null; v_endpoint := 'fal-ai/nano-banana-2';
  elsif p_mode = 'continue' then
    if v_prev.id is null then raise exception 'this is the first shot of the scene: there is no previous clip to continue from'; end if;
    if v_prev_clip is null then raise exception 'approve a clip of the previous shot first'; end if;
    v_src := v_prev_clip; v_cost := 0; v_endpoint := 'local/last-frame';
    v_ins := coalesce(v_ins, 'Continue from the last frame of the previous shot.');
  elsif p_mode = 'reposition' then
    if v_ins is null then raise exception 'say where everyone is and what they are doing'; end if;
    if p_source is not null and p_source not in ('prev_last','this_start','prev_start') then
      raise exception 'source must be prev_last, this_start or prev_start'; end if;
    v_src := case coalesce(p_source, case when v_prev_clip is not null then 'prev_last'
                                          when v_shot.start_frame_path is not null then 'this_start' else 'prev_start' end)
               when 'prev_last' then v_prev_clip when 'this_start' then v_shot.start_frame_path
               when 'prev_start' then case when v_prev.start_frame_approved then v_prev.start_frame_path end end;
    if v_src is null then raise exception 'no still to start from: add a start frame, or approve the previous shot''s start frame or clip'; end if;
  else
    if v_ins is null then raise exception 'say where everyone is and what they are doing'; end if;
    select l.layout_path into v_plate from studio.scenes sc left join studio.locations l on l.id = sc.location_id where sc.id = v_shot.scene_id;
    if v_plate is null then raise exception 'give the scene a location with an empty-room plate first'; end if;
    select array_agg(c.ref_front_path order by c.height_units desc nulls last, c.name), array_agg(c.name order by c.height_units desc nulls last, c.name),
           array_agg(c.height_units order by c.height_units desc nulls last, c.name), count(*),
           string_agg(c.name, ', ') filter (where c.ref_front_path is null)
      into v_refs, v_names, v_heights, v_n, v_missing
      from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
     where sc.id = v_shot.scene_id and (cardinality(v_shot.cast_ids) = 0 or c.id = any(v_shot.cast_ids));
    if coalesce(v_n, 0) = 0 then raise exception 'the shot has nobody in it: add characters to the series or the shot'; end if;
    if v_missing is not null then raise exception 'add a reference image for %', v_missing; end if;
    if v_n > 6 then raise exception 'at most 6 characters in a new setup (this shot has %)', v_n; end if;
    v_src := v_plate;
    if v_look = 'photoreal' then v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 17 + 3 * v_n; end if;
  end if;

  perform studio.reserve_frame_credits(v_owner, v_cost);
  insert into studio.frame_jobs(owner, shot_id, kind, mode, instruction, source_path, ref_paths, ref_names, ref_heights,
                                endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'start', p_mode, v_ins, v_src, coalesce(v_refs, '{}'), coalesce(v_names, '{}'), coalesce(v_heights, '{}'),
            v_endpoint, case when v_cost = 0 then 0 when v_endpoint like 'openai/gpt-image%' then 0.068 + 0.012 * coalesce(v_n, 2) else 0.08 end, v_cost)
    returning id into v_id;
  if v_cost > 0 then insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id); end if;
  return v_id;
end $function$;
