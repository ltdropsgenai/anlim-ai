-- Fix (2026-11-23, live test of lip sync): the likeness-consent triggers treated every picture in <owner>/stills/ as
-- an upload, but anlim saves the start images it makes there too (sf-<job>.png). Approving or rendering any anlim-made
-- start image was refused with "Confirm that any real person in this picture is you...". A picture anlim made is one
-- that a frame job of the same creator produced (composed_path or raw_path; never source_path, which can be an
-- upload); those need no consent. Checked on the live data: all 121 sf- start images match their frame job. @anlim

create or replace function studio.made_by_anlim(p_owner uuid, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from studio.frame_jobs f where f.owner = p_owner and (f.composed_path = p_path or f.raw_path = p_path)) $$;
revoke execute on function studio.made_by_anlim(uuid, text) from public, anon, authenticated;

create or replace function studio.trg_shot_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; r text;
begin
  v_owner := studio.shot_owner(new.id);
  if new.start_frame_path is distinct from old.start_frame_path and new.start_frame_path like v_owner::text || '/stills/%'
     and not studio.made_by_anlim(v_owner, new.start_frame_path)
     and not studio.has_likeness_consent(v_owner, new.start_frame_path) then
    raise exception 'Confirm that any real person in this picture is you or agreed to it (likeness consent).'; end if;
  if new.motion_source_path is distinct from old.motion_source_path and new.motion_source_path is not null
     and not studio.has_likeness_consent(v_owner, new.motion_source_path) then
    raise exception 'Confirm that any real person in the source video is you or agreed to it (likeness consent).'; end if;
  if new.motion_ref_paths is distinct from old.motion_ref_paths and new.motion_ref_paths is not null then
    foreach r in array new.motion_ref_paths loop
      if not studio.made_by_anlim(v_owner, r) and not studio.has_likeness_consent(v_owner, r) then
        raise exception 'Confirm that any real person in the reference pictures is you or agreed to it (likeness consent).'; end if;
    end loop;
  end if;
  return new;
end $$;

create or replace function studio.trg_character_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if new.ref_front_path is null or coalesce(new.kind, 'person') <> 'person' then return new; end if;
  if tg_op = 'UPDATE' and new.ref_front_path is not distinct from old.ref_front_path then return new; end if;
  select owner into v_owner from studio.series where id = new.series_id;
  if not studio.made_by_anlim(v_owner, new.ref_front_path) and not studio.has_likeness_consent(v_owner, new.ref_front_path) then
    raise exception 'Confirm that the person in this photo is you or agreed to it (likeness consent).'; end if;
  return new;
end $$;
