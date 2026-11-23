-- No default look (2026-11-23, Londi: "make sure that there's no default of cartoon for all projects"). @anlim
-- "Kijan (photoreal test)" was saved as cartoon although every image in it is photoreal: a project made without an
-- explicit look silently became cartoon (the column default, create_series' default, and the 6-argument
-- motion_create that always passed 'cartoon'). From now on a new project needs the creator's choice, and code that
-- reads a project's look no longer falls back to cartoon. Existing projects keep the look they have.
-- Order: deploy studio-api and studio-mcp first (they pass the look); this migration then drops the old motion_create.

-- 1. The column: no default (it stays NOT NULL with its cartoon/photoreal check, so a missing look is an error).
alter table studio.series alter column look drop default;

-- 2. create_series: the look is required. Its default changes from 'cartoon' to null, which needs a drop and create;
--    the grants are put back as they were (authenticated, service_role).
drop function studio.create_series(text, text, text);
create function studio.create_series(p_name text, p_style text default null, p_look text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the series a name'; end if;
  if p_look is null then raise exception 'Choose a look for the project: cartoon or photoreal.'; end if;
  if p_look not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
  insert into studio.series(owner, name, style_prompt, look)
    values (auth.uid(), left(trim(p_name), 200), nullif(left(trim(coalesce(p_style, '')), 1000), ''), p_look)
    returning id into v_id;
  return v_id;
end $$;
revoke execute on function studio.create_series(text, text, text) from public, anon;
grant execute on function studio.create_series(text, text, text) to authenticated, service_role;

-- 3. The 6-argument motion_create always made a cartoon project; the app and the connector now call the 7-argument one.
drop function if exists studio.motion_create(text, text[], text, numeric, text, uuid);

-- 4. The 7-argument motion_create: no cartoon fallback; a new project needs the look (an existing one keeps its own).
do $$
declare d text;
  a text := 'v_look text := coalesce(p_look, ''cartoon'');';
  b text := '  if v_look not in (''cartoon'', ''photoreal'') then raise exception ''look must be cartoon or photoreal''; end if;';
begin
  d := pg_get_functiondef('studio.motion_create(text, text[], text, numeric, text, uuid, text)'::regprocedure);
  if position(a in d) = 0 or position(b in d) = 0 then raise exception 'motion_create: expected text not found'; end if;
  d := replace(d, a, 'v_look text := p_look;');
  d := replace(d, b, '  if p_series is null and v_look is null then raise exception ''Choose a look for the project: cartoon or photoreal.''; end if;' ||
                     E'\n  if v_look is not null and v_look not in (''cartoon'', ''photoreal'') then raise exception ''look must be cartoon or photoreal''; end if;');
  execute d;
end $$;

-- 5. route_model: no cartoon fallback for the look, and no fallback to a cartoon route (both looks have an 'other' route).
do $$
declare d text;
  a text := 'v_look := coalesce(v_look, ''cartoon'');';
  b text := '  if not found then select * into r from studio.model_routes where model_routes.look = ''cartoon'' and model_routes.kind = ''other''; end if;';
begin
  d := pg_get_functiondef('studio.route_model(uuid)'::regprocedure);
  if position(a in d) = 0 or position(b in d) = 0 then raise exception 'route_model: expected text not found'; end if;
  d := replace(d, a, 'if v_look is null then raise exception ''project not found''; end if;');
  d := replace(d, b, '  if not found then raise exception ''No model route for % clips'', v_look; end if;');
  execute d;
end $$;

-- 6. enqueue_generation: compares the model's looks with the project's own look (no cartoon fallback).
do $$
declare d text; a text := 'coalesce(v_look, ''cartoon'') = any(v_model.looks)';
begin
  d := pg_get_functiondef('studio.enqueue_generation(uuid, text)'::regprocedure);
  if position(a in d) = 0 then raise exception 'enqueue_generation: expected text not found'; end if;
  execute replace(d, a, 'v_look = any(v_model.looks)');
end $$;
