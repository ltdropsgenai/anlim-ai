-- Genre on a series + one list of everything a creator has made (2026-11-19, Londi: "an assets (storage) space where
-- the assets generated will be accessed (separated by type, genre, etc.)"). @anlim
-- Genre is optional and only used to file and filter work; it changes nothing about how frames or clips are made.
alter table studio.series add column if not exists genre text
  check (genre in ('drama', 'comedy', 'action', 'kids', 'horror', 'romance', 'documentary', 'music_video', 'ad', 'explainer', 'other'));

create or replace function studio.set_series_genre(p_series uuid, p_genre text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_genre is not null and p_genre not in ('drama', 'comedy', 'action', 'kids', 'horror', 'romance', 'documentary', 'music_video', 'ad', 'explainer', 'other')
    then raise exception 'unknown genre'; end if;
  update studio.series set genre = p_genre where id = p_series and owner = auth.uid();
  if not found then raise exception 'series not found'; end if;
end $$;
revoke all on function studio.set_series_genre(uuid, text) from public, anon;
grant execute on function studio.set_series_genre(uuid, text) to authenticated;

-- Everything made in the caller's series, one row per asset. security invoker: row-level security on each table
-- decides what the caller sees. kinds: clip (rendered video), cut (scene cut), still (start / end frame or plate made
-- by anlim), character (reference image), place (location plate). Music lives in storage only (studio-api lists it).
create or replace function studio.my_assets()
returns table (kind text, id uuid, created_at timestamptz, series_id uuid, series_name text, look text, genre text,
               scene_id uuid, scene_title text, shot_id uuid, shot_ord int, title text, subtitle text,
               path text, preview_path text, thumb_path text, model text, duration_s numeric, status text, verdict text)
language sql stable security invoker set search_path to '' as $$
  -- rendered clips that finished (failed renders have no file)
  select 'clip', g.id, g.created_at, se.id, se.name, se.look, se.genre, sc.id, sc.title, sh.id, sh.ord, sh.action,
         coalesce(m.label, g.model_id), g.output_path, g.preview_path, sh.start_frame_path, g.model_id, sh.duration_s::numeric,
         case when sh.approved_generation_id = g.id then 'kept'
              when r.decision = 'reject' then 'rejected' else 'to_review' end,
         q.verdict
    from studio.generations g
    join studio.shots sh on sh.id = g.shot_id join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
    left join studio.models m on m.id = g.model_id
    left join lateral (select decision from studio.reviews r where r.generation_id = g.id order by created_at desc limit 1) r on true
    left join lateral (select verdict from studio.qc_runs q where q.generation_id = g.id order by created_at desc limit 1) q on true
   where g.output_path is not null
  union all
  -- finished scene cuts
  select 'cut', a.id, a.created_at, se.id, se.name, se.look, se.genre, sc.id, sc.title, null, null, sc.title,
         a.format || ' · ' || jsonb_array_length(a.items) || ' shots', a.output_path, a.preview_path,
         (select sh.start_frame_path from studio.shots sh where sh.scene_id = sc.id and sh.start_frame_path is not null order by sh.ord limit 1),
         null, a.duration_s, 'kept', null
    from studio.assemblies a join studio.scenes sc on sc.id = a.scene_id join studio.series se on se.id = sc.series_id
   where a.status = 'done' and a.output_path is not null
  union all
  -- stills anlim made (start frames, end frames) that were kept or are waiting for a decision
  select 'still', f.id, f.created_at, se.id, se.name, se.look, se.genre, sc.id, sc.title, sh.id, sh.ord,
         case f.kind when 'end' then 'End frame' else 'Start frame' end || ' · shot ' || sh.ord,
         coalesce(f.instruction, sh.action), f.composed_path, null, f.composed_path,
         case when f.endpoint like 'openai/gpt-image%' then 'GPT Image 2.6' when f.endpoint like '%nano-banana%' then 'Nano Banana 2' else null end,
         null, case f.status when 'approved' then 'kept' else 'to_review' end, null
    from studio.frame_jobs f
    join studio.shots sh on sh.id = f.shot_id join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
   where f.kind in ('start', 'end') and f.status in ('approved', 'ready') and f.composed_path is not null
  union all
  -- empty-room plates (made or uploaded): the location's current plate
  select 'place', l.id, l.created_at, se.id, se.name, se.look, se.genre, null, null, null, null, l.name, l.description,
         l.layout_path, null, l.layout_path, null, null, 'kept', null
    from studio.locations l join studio.series se on se.id = l.series_id
   where l.layout_path is not null
  union all
  -- character reference images
  select 'character', ch.id, ch.created_at, se.id, se.name, se.look, se.genre, null, null, null, null, ch.name,
         coalesce(ch.what, ch.wardrobe), ch.ref_front_path, null, ch.ref_front_path, null, null, 'kept', null
    from studio.characters ch join studio.series se on se.id = ch.series_id
   where ch.ref_front_path is not null
$$;
revoke all on function studio.my_assets() from public, anon;
grant execute on function studio.my_assets() to authenticated;
