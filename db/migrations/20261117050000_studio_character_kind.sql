-- A cast member is a person, an animal or an object, in either look (Londi 2026-11-16: "Cartoon, photoreal (animals,
-- people, objects). That's the rule"). @anlim
-- kind picks how the checker finds them in a frame (people / animals / the object's own class) and how prompts
-- describe them; "what" is a short plain description used for both (e.g. "golden retriever", "red toy dump truck").
-- wardrobe stays the column for how they look: clothes for people, fur and markings for animals, colours for objects.
alter table studio.characters add column if not exists kind text not null default 'person';
alter table studio.characters add column if not exists what text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'characters_kind_check') then
    alter table studio.characters add constraint characters_kind_check check (kind in ('person', 'animal', 'object'));
  end if;
end $$;

drop function if exists studio.create_character(uuid, text, numeric, text);
create or replace function studio.create_character(p_series uuid, p_name text, p_height numeric default null,
                                                   p_wardrobe text default null, p_kind text default 'person', p_what text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := studio.series_of_owner(p_series); v_id uuid;
begin
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'series not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the character a name'; end if;
  if coalesce(p_kind, 'person') not in ('person', 'animal', 'object') then raise exception 'kind must be person, animal or object'; end if;
  if p_height is not null and p_height not between 0.1 and 1000 then raise exception 'height is a relative number, e.g. 10'; end if;
  if exists (select 1 from studio.characters where series_id = p_series and lower(name) = lower(trim(p_name))) then
    raise exception 'there is already a character called %', trim(p_name); end if;
  insert into studio.characters(series_id, name, height_units, wardrobe, kind, what)
    values (p_series, left(trim(p_name), 100), p_height, nullif(left(trim(coalesce(p_wardrobe, '')), 500), ''),
            coalesce(p_kind, 'person'), nullif(left(trim(coalesce(p_what, '')), 200), ''))
    returning id into v_id;
  return v_id;
end $$;
revoke execute on function studio.create_character(uuid, text, numeric, text, text, text) from public, anon;
grant execute on function studio.create_character(uuid, text, numeric, text, text, text) to authenticated, service_role;
