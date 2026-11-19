-- Start stills made in the app, plus the pieces they need (locations with an empty-room plate, character reference
-- images, who is in a shot). @anlim
-- Three ways to get a shot's start still (frame_jobs kind 'start'):
--   continue   : the last frame of the previous shot's approved clip. Free (no image model).
--   reposition : same room, new positions: Nano Banana 2 edits a still (this shot's start, the previous shot's start,
--                or the previous clip's last frame), then frame_check compose keeps the room pixel-for-pixel.
--   new_setup  : the scene's location plate (empty room) + each cast member's reference image -> Nano Banana 2
--                (multi-image edit) -> compose onto the plate.
-- And kind 'plate': remove every character from a shot's start still -> the location's empty-room plate.
-- Feasibility (2026-11-13, Phase 0 S4 still, 2 edits ~$0.16): plate from S4 -> compose PASS (no drift, align 0);
-- new_setup from plate + 2 crops -> compose PASS; identity, clothes and seating held on visual review. One sample.
-- Cost: one Nano Banana 2 edit, $0.08 -> 20 credits, as end frames. "continue" costs nothing.
-- Every job snapshots its inputs (source_path, ref_paths) when it is requested, so later edits do not change it.

alter table studio.frame_jobs drop constraint if exists frame_jobs_kind_check;
alter table studio.frame_jobs add constraint frame_jobs_kind_check check (kind in ('end','start','plate'));
alter table studio.frame_jobs alter column shot_id drop not null;
alter table studio.frame_jobs
  add column if not exists mode text check (mode in ('continue','reposition','new_setup')),
  add column if not exists source_path text,             -- the still (or clip) the job starts from; the compose base
  add column if not exists ref_paths text[] not null default '{}',   -- new_setup: character reference images, in order
  add column if not exists ref_names text[] not null default '{}',
  add column if not exists ref_heights numeric[] not null default '{}',
  add column if not exists location_id uuid references studio.locations(id) on delete cascade;
alter table studio.frame_jobs drop constraint if exists frame_jobs_target;
alter table studio.frame_jobs add constraint frame_jobs_target check (
  (kind = 'plate' and location_id is not null) or (kind <> 'plate' and shot_id is not null));
alter table studio.frame_jobs drop constraint if exists frame_jobs_mode;
alter table studio.frame_jobs add constraint frame_jobs_mode check ((kind = 'start') = (mode is not null));
create index if not exists frame_jobs_location on studio.frame_jobs (location_id, created_at desc);

-- ---------- helpers ----------
create or replace function studio.series_of_owner(p_series uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select owner from studio.series where id = p_series $$;

-- the file exists in the bucket and sits in the owner's <folder>
create or replace function studio.owned_file(p_owner uuid, p_folder text, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_path is not null and p_path not like '%..%'
     and p_path ~ ('^' || p_owner::text || '/' || p_folder || '/[A-Za-z0-9._-]{1,120}\.(png|jpg|jpeg|webp)$')
     and exists (select 1 from storage.objects where bucket_id = 'studio' and name = p_path) $$;

create or replace function studio.reserve_frame_credits(p_owner uuid, p_cost int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_acc studio.accounts;
begin
  if p_cost <= 0 then return; end if;
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = p_owner for update;
  if v_acc.balance - v_acc.reserved < p_cost then
    raise exception 'not enough credits: need %, available %', p_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + p_cost, updated_at = now() where owner = p_owner;
end $$;

-- ---------- series, characters, locations, cast ----------
create or replace function studio.create_series(p_name text, p_style text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the series a name'; end if;
  insert into studio.series(owner, name, style_prompt) values (auth.uid(), left(trim(p_name), 200), nullif(left(trim(coalesce(p_style, '')), 1000), ''))
    returning id into v_id;
  return v_id;
end $$;

create or replace function studio.create_character(p_series uuid, p_name text, p_height numeric default null, p_wardrobe text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := studio.series_of_owner(p_series); v_id uuid;
begin
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'series not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the character a name'; end if;
  if p_height is not null and p_height not between 0.1 and 1000 then raise exception 'height is a relative number, e.g. 10'; end if;
  if exists (select 1 from studio.characters where series_id = p_series and lower(name) = lower(trim(p_name))) then
    raise exception 'there is already a character called %', trim(p_name); end if;
  insert into studio.characters(series_id, name, height_units, wardrobe)
    values (p_series, left(trim(p_name), 100), p_height, nullif(left(trim(coalesce(p_wardrobe, '')), 500), '')) returning id into v_id;
  return v_id;
end $$;

-- Reference image: one picture of the character, whole body, front on (uploaded to <owner>/characters/).
create or replace function studio.set_character_ref(p_character uuid, p_path text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select se.owner into v_owner from studio.characters c join studio.series se on se.id = c.series_id where c.id = p_character;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'character not found'; end if;
  if not studio.owned_file(v_owner, 'characters', p_path) then raise exception 'upload the image first (bad file path)'; end if;
  update studio.characters set ref_front_path = p_path where id = p_character;
end $$;

create or replace function studio.create_location(p_series uuid, p_name text, p_description text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := studio.series_of_owner(p_series); v_id uuid;
begin
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'series not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the location a name'; end if;
  insert into studio.locations(series_id, name, description)
    values (p_series, left(trim(p_name), 200), nullif(left(trim(coalesce(p_description, '')), 1000), '')) returning id into v_id;
  return v_id;
end $$;

-- Plate: the location as an empty room (uploaded to <owner>/locations/, or made by a 'plate' job).
create or replace function studio.set_location_plate(p_location uuid, p_path text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select se.owner into v_owner from studio.locations l join studio.series se on se.id = l.series_id where l.id = p_location;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'location not found'; end if;
  if not studio.owned_file(v_owner, 'locations', p_path) then raise exception 'upload the image first (bad file path)'; end if;
  update studio.frame_jobs set status = 'discarded', updated_at = now() where location_id = p_location and status in ('ready','approved');
  update studio.locations set layout_path = p_path where id = p_location;
end $$;

create or replace function studio.set_scene_location(p_scene uuid, p_location uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_series uuid;
begin
  select se.owner, se.id into v_owner, v_series from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'scene not found'; end if;
  if p_location is not null and not exists (select 1 from studio.locations where id = p_location and series_id = v_series) then
    raise exception 'location not found in this series'; end if;
  update studio.scenes set location_id = p_location where id = p_scene;
end $$;

-- Who is in the shot (empty = every character of the series).
create or replace function studio.set_shot_cast(p_shot uuid, p_cast uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_series uuid;
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'shot not found'; end if;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or frame in progress is done'; end if;
  select sc.series_id into v_series from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id where sh.id = p_shot;
  if exists (select 1 from unnest(coalesce(p_cast, '{}')) x where x not in (select id from studio.characters where series_id = v_series)) then
    raise exception 'character not found in this series'; end if;
  update studio.shots set cast_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_cast, '{}')) x) where id = p_shot;
end $$;

-- ---------- start-still jobs ----------
-- p_source (reposition only): 'prev_last' (previous clip's last frame), 'this_start', 'prev_start'; null = first that exists.
create or replace function studio.request_start_frame(p_shot uuid, p_mode text, p_instruction text default null, p_source text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_shot studio.shots; v_prev studio.shots; v_prev_clip text; v_src text; v_cost int := 20;
        v_ins text := nullif(trim(coalesce(p_instruction, '')), ''); v_id uuid; v_plate text;
        v_refs text[]; v_names text[]; v_heights numeric[]; v_missing text; v_n int; v_endpoint text := 'fal-ai/nano-banana-2/edit';
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  if p_mode not in ('continue','reposition','new_setup') then raise exception 'mode must be continue, reposition or new_setup'; end if;
  if length(coalesce(v_ins, '')) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or frame in progress is done'; end if;
  select * into v_prev from studio.shots where scene_id = v_shot.scene_id and ord < v_shot.ord order by ord desc limit 1;
  if v_prev.id is not null and v_prev.approved_generation_id is not null then
    select output_path into v_prev_clip from studio.generations where id = v_prev.approved_generation_id;
  end if;

  if p_mode = 'continue' then
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
  else  -- new_setup
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
  end if;

  perform studio.reserve_frame_credits(v_owner, v_cost);
  insert into studio.frame_jobs(owner, shot_id, kind, mode, instruction, source_path, ref_paths, ref_names, ref_heights,
                                endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'start', p_mode, v_ins, v_src, coalesce(v_refs, '{}'), coalesce(v_names, '{}'), coalesce(v_heights, '{}'),
            v_endpoint, case when v_cost = 0 then 0 else 0.08 end, v_cost)
    returning id into v_id;
  if v_cost > 0 then insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id); end if;
  return v_id;
end $$;

-- Plate from a shot's start still: every character removed, the room kept (compose keeps it pixel-for-pixel).
create or replace function studio.request_plate(p_location uuid, p_shot uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_series uuid; v_src text; v_id uuid; v_cost int := 20;
begin
  select se.owner, se.id into v_owner, v_series from studio.locations l join studio.series se on se.id = l.series_id where l.id = p_location;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'location not found'; end if;
  select sh.start_frame_path into v_src from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id
   where sh.id = p_shot and sc.series_id = v_series;
  if v_src is null then raise exception 'pick a shot of this series that has a start frame'; end if;
  if exists (select 1 from studio.frame_jobs where location_id = p_location and status in ('queued','running','composing')) then
    raise exception 'a plate is already being made for this location'; end if;
  perform studio.reserve_frame_credits(v_owner, v_cost);
  insert into studio.frame_jobs(owner, location_id, kind, instruction, source_path, credits_reserved)
    values (v_owner, p_location, 'plate', 'Remove every character; keep the empty room.', v_src, v_cost) returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id);
  return v_id;
end $$;

-- ---------- approve / discard any made frame ----------
create or replace function studio.decide_frame(p_job uuid, p_decision text)
returns text language plpgsql security definer set search_path = '' as $$
declare j studio.frame_jobs;
begin
  if p_decision not in ('approve','discard') then raise exception 'decision must be approve or discard'; end if;
  select * into j from studio.frame_jobs where id = p_job for update;
  if not found or (auth.uid() is not null and j.owner <> auth.uid()) then raise exception 'not found'; end if;
  if j.status <> 'ready' then raise exception 'frame is %', j.status; end if;
  if p_decision = 'discard' then
    update studio.frame_jobs set status = 'discarded', updated_at = now() where id = p_job;
    return p_decision;
  end if;
  if j.kind = 'end' then
    update studio.frame_jobs set status = 'discarded', updated_at = now() where shot_id = j.shot_id and kind = 'end' and status = 'approved';
    update studio.shots set end_frame_path = j.composed_path, end_frame_approved = true where id = j.shot_id;
  elsif j.kind = 'start' then
    if exists (select 1 from studio.generations where shot_id = j.shot_id and status in ('queued','running','checking'))
       or exists (select 1 from studio.frame_jobs where shot_id = j.shot_id and id <> j.id and status in ('queued','running','composing')) then
      raise exception 'wait until the render or frame in progress is done'; end if;
    -- a new start still: the end frame was drawn from the old one, so it goes (as set_start_frame)
    update studio.frame_jobs set status = 'discarded', updated_at = now()
     where shot_id = j.shot_id and id <> j.id and status in ('ready','approved') and (kind = 'end' or status = 'approved');
    update studio.shots set start_frame_path = j.composed_path, start_frame_approved = true, end_frame_path = null,
           end_frame_approved = false, status = case when status in ('draft','ready') then 'ready' else status end
     where id = j.shot_id;
  else  -- plate
    update studio.frame_jobs set status = 'discarded', updated_at = now() where location_id = j.location_id and status = 'approved';
    update studio.locations set layout_path = j.composed_path where id = j.location_id;
  end if;
  update studio.frame_jobs set status = 'approved', updated_at = now() where id = p_job;
  return p_decision;
end $$;

create or replace function studio.decide_end_frame(p_job uuid, p_decision text)
returns text language sql security definer set search_path = '' as $$ select studio.decide_frame(p_job, p_decision) $$;

-- clear_end_frame: only end-frame jobs lose their "approved" mark
create or replace function studio.clear_end_frame(p_shot uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'not found'; end if;
  update studio.frame_jobs set status = 'discarded', updated_at = now() where shot_id = p_shot and kind = 'end' and status = 'approved';
  update studio.shots set end_frame_path = null, end_frame_approved = false where id = p_shot;
end $$;

-- delete_shot: a paid frame of any kind keeps the shot
create or replace function studio.delete_shot(p_shot uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'shot not found'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot) then raise exception 'this shot has renders; it is kept'; end if;
  if exists (select 1 from studio.frame_jobs where shot_id = p_shot and settled = 'charged') then
    raise exception 'this shot has a paid frame; it is kept'; end if;
  delete from studio.frame_jobs where shot_id = p_shot;
  delete from studio.shots where id = p_shot;
end $$;

revoke execute on all functions in schema studio from public, anon;
grant execute on function studio.create_series(text, text), studio.create_character(uuid, text, numeric, text),
  studio.set_character_ref(uuid, text), studio.create_location(uuid, text, text), studio.set_location_plate(uuid, text),
  studio.set_scene_location(uuid, uuid), studio.set_shot_cast(uuid, uuid[]),
  studio.request_start_frame(uuid, text, text, text), studio.request_plate(uuid, uuid),
  studio.decide_frame(uuid, text), studio.decide_end_frame(uuid, text), studio.clear_end_frame(uuid),
  studio.delete_shot(uuid) to authenticated;
-- internal helpers: called only from the functions above (security definer)
revoke execute on function studio.series_of_owner(uuid), studio.owned_file(uuid, text, text),
  studio.reserve_frame_credits(uuid, int) from authenticated;
