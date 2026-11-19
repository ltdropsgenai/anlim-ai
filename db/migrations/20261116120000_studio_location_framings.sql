-- A location keeps the empty-room plate of every camera framing it was shot in. @anlim
-- Why (2026-11-16): one plate per location only fits stills taken in that plate's framing. The Playroom plate did not
-- fit the reposition test still (20.7 % of the room differed) nor the seated talking chain (34 %), so compose fell back
-- to the image model's repaint where a character had stood (the invented blue block). Making a plate from a still in a
-- new framing now ADDS it: layout_path stays the latest one (used by New setup), the earlier ones move to
-- other_plates. The worker sends them all; the checker uses layout_path when it fits the still, else the best-fitting
-- other plate, else none (and the area is shown dashed for the creator).

alter table studio.locations add column if not exists other_plates text[] not null default '{}';

create or replace function studio.locations_keep_plates()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.layout_path is distinct from old.layout_path and old.layout_path is not null then
    new.other_plates := array_remove(array_remove(coalesce(new.other_plates, '{}'::text[]), old.layout_path), new.layout_path)
                        || old.layout_path;
    -- the 8 most recent framings are kept
    if cardinality(new.other_plates) > 8 then
      new.other_plates := new.other_plates[cardinality(new.other_plates) - 7:];
    end if;
  end if;
  return new;
end $$;

drop trigger if exists locations_keep_plates on studio.locations;
create trigger locations_keep_plates before update of layout_path on studio.locations
  for each row execute function studio.locations_keep_plates();

-- cut-outs get every plate of the location (layout_path first); the checker picks the one that fits
create or replace function studio.request_cutouts(p_shot uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_src text; v_plates text[]; v_id uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  select sh.start_frame_path,
         case when l.layout_path is null then coalesce(l.other_plates, '{}'::text[])
              else array[l.layout_path] || coalesce(l.other_plates, '{}'::text[]) end
    into v_src, v_plates
    from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id left join studio.locations l on l.id = sc.location_id
   where sh.id = p_shot;
  if v_src is null then raise exception 'this shot has no start frame to cut characters out of'; end if;
  if exists (select 1 from studio.frame_jobs where shot_id = p_shot and kind = 'cutout' and status in ('queued','running','composing')) then
    raise exception 'cut-outs are already being made from this shot'; end if;
  insert into studio.frame_jobs(owner, shot_id, kind, instruction, source_path, ref_paths, endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'cutout', 'Cut each character out onto white.', v_src, coalesce(v_plates, '{}'::text[]),
            'local/cutout', 0, 0)
    returning id into v_id;
  return v_id;
end $$;

revoke execute on function studio.request_cutouts(uuid) from public, anon;
grant execute on function studio.request_cutouts(uuid) to authenticated, service_role;
revoke execute on function studio.locations_keep_plates() from public, anon, authenticated;
