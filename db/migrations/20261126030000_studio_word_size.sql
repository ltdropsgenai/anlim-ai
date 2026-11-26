-- Words over a shot get a size (2026-11-25, Londi: emojis "at any size to any project") and a style: "plain" or
-- "flames", letters made of fire (Londi: "the words themselves will be actual flames ... the flames form the letters"). @anlim
-- size: times the usual size (6% of the picture's width), 0.25 to 8; missing = 1. The worker (assemble.js) draws a line
-- that would not fit the picture smaller, so a large size never runs off the picture. Everything else is unchanged from
-- 20261123110000_studio_shot_words.
create or replace function studio.set_shot_words(p_shot uuid, p_words jsonb)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_w jsonb; v_out jsonb := '[]'::jsonb; v_text text; v_at numeric; v_x numeric; v_y numeric; v_d numeric; v_s numeric; v_st text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if p_words is null or jsonb_typeof(p_words) <> 'array' then raise exception 'words must be a list'; end if;
  if jsonb_array_length(p_words) > 12 then raise exception 'at most 12 words on a shot'; end if;
  for v_w in select value from jsonb_array_elements(p_words) loop
    v_text := trim(coalesce(v_w->>'text', ''));
    if v_text = '' or length(v_text) > 40 then raise exception 'each word is 1 to 40 characters'; end if;
    if v_text ~ '[[:cntrl:]]' then raise exception 'a word cannot contain line breaks or control characters'; end if;
    v_at := coalesce(nullif(v_w->>'at_s', '')::numeric, 0);
    v_x := coalesce(nullif(v_w->>'x', '')::numeric, 0.5);
    v_y := coalesce(nullif(v_w->>'y', '')::numeric, 0.4);
    v_d := coalesce(nullif(v_w->>'dur_s', '')::numeric, 2.6);
    v_s := coalesce(nullif(v_w->>'size', '')::numeric, 1);
    v_st := coalesce(nullif(v_w->>'style', ''), 'plain');
    if v_at < 0 or v_at > 600 then raise exception 'a word appears 0 to 600 seconds into the shot'; end if;
    if v_x < 0 or v_x > 1 or v_y < 0 or v_y > 1 then raise exception 'x and y are fractions of the frame, 0 to 1'; end if;
    if v_d < 1 or v_d > 6 then raise exception 'a word stays 1 to 6 seconds'; end if;
    if v_st not in ('plain', 'flames') then raise exception 'a word''s style is plain or flames'; end if;
    if v_s < 0.25 or v_s > 8 then raise exception 'a word''s size is 0.25 to 8 times the usual size (25 to 800%%)'; end if;
    v_out := v_out || jsonb_build_object('text', v_text, 'at_s', round(v_at, 2), 'x', round(v_x, 3), 'y', round(v_y, 3), 'dur_s', round(v_d, 2),
                                         'size', round(v_s, 2), 'style', v_st);
  end loop;
  update studio.shots set words = v_out where id = p_shot;
end $$;
revoke all on function studio.set_shot_words(uuid, jsonb) from public;
grant execute on function studio.set_shot_words(uuid, jsonb) to authenticated;
