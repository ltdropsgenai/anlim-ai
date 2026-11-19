-- A series is drawn (cartoon) or filmed-looking (photoreal). @anlim
-- Why (2026-11-16): the app sent style "cartoon" to the checker for every clip and its image prompts said "drawing
-- style", although the app is for both looks from day one (Londi). The look picks the checker's rules (cartoon:
-- unconfirmed frame flags are notes, room drift on locked shots; photoreal: any flag holds the clip, no room drift),
-- the image-prompt wording, the matting model that cuts characters out, and the video model route.

alter table studio.series add column if not exists look text not null default 'cartoon';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'series_look_check') then
    alter table studio.series add constraint series_look_check check (look in ('cartoon', 'photoreal'));
  end if;
end $$;

drop function if exists studio.create_series(text, text);
create or replace function studio.create_series(p_name text, p_style text default null, p_look text default 'cartoon')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give the series a name'; end if;
  if coalesce(p_look, 'cartoon') not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
  insert into studio.series(owner, name, style_prompt, look)
    values (auth.uid(), left(trim(p_name), 200), nullif(left(trim(coalesce(p_style, '')), 1000), ''), coalesce(p_look, 'cartoon'))
    returning id into v_id;
  return v_id;
end $$;
revoke execute on function studio.create_series(text, text, text) from public, anon;
grant execute on function studio.create_series(text, text, text) to authenticated, service_role;

-- the look (and the free-text style) can change; it applies to frames and renders made after the change
create or replace function studio.update_series(p_series uuid, p_look text default null, p_style text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_look is not null and p_look not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
  update studio.series set look = coalesce(p_look, look),
                           style_prompt = case when p_style is null then style_prompt else nullif(left(trim(p_style), 1000), '') end
   where id = p_series and owner = auth.uid();
  if not found then raise exception 'series not found'; end if;
end $$;
revoke execute on function studio.update_series(uuid, text, text) from public, anon;
grant execute on function studio.update_series(uuid, text, text) to authenticated, service_role;

-- Video model routes per look. The cartoon routes come from the Layana & King tests; photoreal has had no test in the
-- app yet, so every photoreal kind starts on Kling 4.0 (fal) until the photoreal route test (planned 2026-11-17).
alter table studio.model_routes add column if not exists look text not null default 'cartoon';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'model_routes_look_check') then
    alter table studio.model_routes add constraint model_routes_look_check check (look in ('cartoon', 'photoreal'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'model_routes_pkey'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (kind)') then
    alter table studio.model_routes drop constraint model_routes_pkey;
    alter table studio.model_routes add constraint model_routes_pkey primary key (look, kind);
  end if;
end $$;
insert into studio.model_routes(look, kind, model_id, reason, evidence)
select 'photoreal', k, 'kling-v4-i2v-720p', 'Kling 4.0: the photoreal default until the photoreal route test.',
       'No photoreal test in the app yet (cartoon routes were chosen on the Layana & King tests).'
  from unnest(array['walking', 'sit_stand', 'handling', 'talking', 'other']) k
on conflict (look, kind) do nothing;

create or replace function studio.route_model(p_shot uuid)
returns table(kind text, model_id text, reason text, evidence text)
language plpgsql stable security definer set search_path = '' as $$
declare v_shot studio.shots; v_kind text; v_look text; r studio.model_routes; m studio.models;
begin
  if studio.shot_owner(p_shot) is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot) then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot;
  select se.look into v_look from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = v_shot.scene_id;
  v_look := coalesce(v_look, 'cartoon');
  v_kind := studio.shot_kind(v_shot.action);
  select * into r from studio.model_routes where model_routes.look = v_look and model_routes.kind = v_kind;
  if not found then select * into r from studio.model_routes where model_routes.look = v_look and model_routes.kind = 'other'; end if;
  if not found then select * into r from studio.model_routes where model_routes.look = 'cartoon' and model_routes.kind = 'other'; end if;
  select * into m from studio.models where id = r.model_id and active;
  if found and v_shot.duration_s between m.min_duration_s and m.max_duration_s then
    return query select v_kind, r.model_id, r.reason, r.evidence; return;
  end if;
  select * into m from studio.models where active and provider <> 'mock'
     and v_shot.duration_s between min_duration_s and max_duration_s order by usd_per_second limit 1;
  if not found then raise exception 'no model can make a % s clip', v_shot.duration_s; end if;
  return query select v_kind, m.id, format('%s cannot make a %s s clip; using %s instead.', r.model_id, v_shot.duration_s, m.id),
                      r.evidence;
end $$;
