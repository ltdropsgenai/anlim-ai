-- 2026-11-18 (applied): a new shot's cast = the characters its action text names; only when it names nobody does it
-- start with the whole series. People and animals match as written (names are proper nouns: "her" is not Her);
-- objects match in any capitalisation ("the mug"). Londi's shot D got Him and the Mug with the whole-series default.
create or replace function studio.create_shot(p_scene uuid, p_action text, p_camera text default 'locked'::text, p_duration integer default 5)
 returns uuid language plpgsql security definer set search_path to ''
as $function$
declare v_owner uuid; v_id uuid; v_cast uuid[];
begin
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'scene not found'; end if;
  if coalesce(trim(p_action), '') = '' then raise exception 'say what happens in the shot'; end if;
  if p_duration not between 3 and 30 then raise exception 'a shot is 3 to 30 seconds'; end if;
  select array_agg(c.id order by c.name) into v_cast
    from studio.scenes sc join studio.characters c on c.series_id = sc.series_id
   where sc.id = p_scene and (case when c.kind = 'object' then p_action ~* ('(^|[^[:alnum:]_])' || regexp_replace(c.name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '($|[^[:alnum:]_])')
                                   else p_action ~ ('(^|[^[:alnum:]_])' || regexp_replace(c.name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '($|[^[:alnum:]_])') end);
  if v_cast is null then
    select array_agg(c.id order by c.name) into v_cast from studio.scenes sc join studio.characters c on c.series_id = sc.series_id where sc.id = p_scene;
  end if;
  insert into studio.shots(scene_id, ord, action, camera, duration_s, status, cast_ids)
    values (p_scene, coalesce((select max(ord) from studio.shots where scene_id = p_scene), 0) + 1,
            left(trim(p_action), 2000), nullif(left(trim(coalesce(p_camera, '')), 200), ''), p_duration, 'draft', coalesce(v_cast, '{}'))
    returning id into v_id;
  return v_id;
end $function$;
