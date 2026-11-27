-- Ad scripts in anlim's three languages (2026-11-27, Londi: "make sure that every feature added is fully translated for
-- our multilanguage user base and, when we start generating ads, the ads will all specify and also be in the three
-- languages the app supports"). @anlim
-- The ad script writer now returns every spoken line, on-screen text, angle and caption as {"en", "es", "fr"}
-- (checker ad_script.py); the picture and camera notes stay in English for the video model. apply_ad_draft takes the
-- language the creator picks (p_lang, default 'en') and puts that language's lines and on-screen words on the shots.
-- Scripts written before this change (plain strings) still work: studio.ad_text returns the string for any language.
-- Everything else in apply_ad_draft is as in 20261127200000_studio_ad_drafts.

create or replace function studio.ad_text(p jsonb, p_lang text) returns text language sql immutable set search_path to '' as $$
  select case jsonb_typeof(p) when 'object' then coalesce(nullif(p->>p_lang, ''), p->>'en')
                              when 'string' then p #>> '{}' else null end $$;

drop function if exists studio.apply_ad_draft(uuid, int, uuid, text);

create or replace function studio.apply_ad_draft(p_draft uuid, p_variant int, p_series uuid default null, p_aspect text default '9:16',
                                                 p_lang text default 'en')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare d studio.ad_drafts; v jsonb; s jsonb; v_series uuid := p_series; v_scene uuid; v_shot uuid; v_shots jsonb := '[]'::jsonb;
        v_secs numeric; v_len int; v_text text; v_name text; k int := 0;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into d from studio.ad_drafts where id = p_draft and owner = auth.uid();
  if not found then raise exception 'ad script not found'; end if;
  if d.status <> 'done' or jsonb_typeof(d.variants) <> 'array' then raise exception 'the ad script is not ready yet'; end if;
  if p_variant is null or p_variant < 1 or p_variant > jsonb_array_length(d.variants) then
    raise exception 'pick script 1 to %', jsonb_array_length(d.variants); end if;
  v := d.variants -> (p_variant - 1);
  if jsonb_typeof(v->'shots') <> 'array' or jsonb_array_length(v->'shots') = 0 then raise exception 'this script has no shots'; end if;
  if p_aspect not in ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9') then raise exception 'unknown shape %', p_aspect; end if;
  if p_lang not in ('en', 'es', 'fr') then raise exception 'the language is en, es or fr'; end if;
  if v_series is null then
    v_name := left('Ad: ' || d.product, 200);
    v_series := studio.create_series(v_name, null, d.look);
    update studio.series set aspect = p_aspect where id = v_series;
  else
    select name into v_name from studio.series where id = v_series and owner = auth.uid();
    if v_name is null then raise exception 'project not found'; end if;
  end if;
  v_scene := studio.create_scene(v_series, left(coalesce(nullif(studio.ad_text(v->'angle', p_lang), ''), 'Ad'), 120));
  for s in select value from jsonb_array_elements(v->'shots') loop
    k := k + 1;
    exit when k > 8;
    v_secs := least(30, greatest(1, coalesce(nullif(s->>'seconds', '')::numeric, 3)));
    v_len := greatest(5, ceil(v_secs)::int);
    v_shot := studio.create_shot(v_scene, left(coalesce(nullif(btrim(s->>'picture'), ''), 'The product on a clean background'), 2000),
                                 nullif(left(coalesce(s->>'camera', ''), 200), ''), v_len);
    v_text := nullif(btrim(regexp_replace(coalesce(studio.ad_text(s->'on_screen', p_lang), ''), '[[:cntrl:]]+', ' ', 'g')), '');
    update studio.shots
       set line = nullif(left(btrim(regexp_replace(coalesce(studio.ad_text(s->'line', p_lang), ''), '[[:cntrl:]]+', ' ', 'g')), 600), ''),
           -- the cut plays the beat's length: the rest of the clip is trimmed off its end (at least 1 s is always kept)
           trim_end_s = round(greatest(0, v_len - v_secs), 2),
           fx = case when v_text is null then '{}'::jsonb
                     else jsonb_build_object('title', jsonb_build_object('text', left(v_text, 40), 'at_s', 0.2,
                            'dur_s', least(v_secs, 3.0), 'color', 'yellow', 'y', 0.3)) end
     where id = v_shot;
    v_shots := v_shots || jsonb_build_object('shot_id', v_shot, 'seconds', v_secs);
  end loop;
  update studio.ad_drafts set series_id = v_series, updated_at = now() where id = p_draft;
  return jsonb_build_object('series_id', v_series, 'series_name', v_name, 'scene_id', v_scene, 'shots', v_shots, 'language', p_lang);
end $$;
revoke all on function studio.apply_ad_draft(uuid, int, uuid, text, text) from public, anon;
grant execute on function studio.apply_ad_draft(uuid, int, uuid, text, text) to authenticated;
