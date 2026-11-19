-- 2026-11-18 (applied): characters can be edited after they are made (Londi: a wrong height on Rocco's card had to be
-- fixed by hand in the database). Same rules as create_character. Frames and renders already made keep what they were
-- given; new ones use the edited card. The reference image is changed with set_character_ref as before.
create or replace function studio.update_character(p_character uuid, p_name text, p_height numeric default null,
                                                   p_wardrobe text default null, p_kind text default 'person', p_what text default null)
 returns void language plpgsql security definer set search_path to ''
as $function$
declare v_owner uuid; v_series uuid;
begin
  select se.owner, c.series_id into v_owner, v_series from studio.characters c join studio.series se on se.id = c.series_id where c.id = p_character;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'character not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the character a name'; end if;
  if coalesce(p_kind, 'person') not in ('person', 'animal', 'object') then raise exception 'kind must be person, animal or object'; end if;
  if p_height is not null and p_height not between 0.1 and 1000 then raise exception 'height is a relative number, e.g. 10'; end if;
  if exists (select 1 from studio.characters where series_id = v_series and id <> p_character and lower(name) = lower(trim(p_name))) then
    raise exception 'there is already a character called %', trim(p_name); end if;
  update studio.characters set name = left(trim(p_name), 100), height_units = p_height,
         wardrobe = nullif(left(trim(coalesce(p_wardrobe, '')), 500), ''), kind = coalesce(p_kind, 'person'),
         what = nullif(left(trim(coalesce(p_what, '')), 200), '')
   where id = p_character;
end $function$;
revoke all on function studio.update_character(uuid, text, numeric, text, text, text) from public;
grant execute on function studio.update_character(uuid, text, numeric, text, text, text) to authenticated;
