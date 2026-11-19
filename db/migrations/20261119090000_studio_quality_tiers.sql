-- Model choice per series (2026-11-19, agreed with Londi 2026-11-18): auto-pick with a visible reason.
-- series.quality: best | balanced | economy. Balanced = the tested routes in studio.model_routes (unchanged).
-- studio.model_routes_tier holds best / economy picks; a row goes in only when a route test backs it.
-- Until then route_model falls back to the balanced pick and says so in the reason.
alter table studio.series add column if not exists quality text not null default 'balanced'
  check (quality in ('best', 'balanced', 'economy'));

alter table studio.models add column if not exists label text;
update studio.models set label = case id when 'kling-v4-i2v-720p' then 'Kling 4.0'
                                         when 'minimax-h3-i2v-768p' then 'MiniMax H3'
                                         when 'mock-i2v' then 'Test model' else id end
 where label is null;

create table if not exists studio.model_routes_tier (
  look       text not null check (look in ('cartoon', 'photoreal')),
  kind       text not null check (kind in ('walking', 'sit_stand', 'handling', 'talking', 'other')),
  tier       text not null check (tier in ('best', 'economy')),
  model_id   text not null references studio.models(id),
  reason     text not null,
  evidence   text not null,
  updated_at timestamptz not null default now(),
  primary key (look, kind, tier)
);
alter table studio.model_routes_tier enable row level security;   -- read through route_model only
revoke all on studio.model_routes_tier from public, anon, authenticated;

create or replace function studio.set_series_quality(p_series uuid, p_quality text) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_quality not in ('best', 'balanced', 'economy') then raise exception 'quality must be best, balanced or economy'; end if;
  update studio.series set quality = p_quality where id = p_series and owner = auth.uid();
  if not found then raise exception 'series not found'; end if;
end $$;
revoke all on function studio.set_series_quality(uuid, text) from public, anon;
grant execute on function studio.set_series_quality(uuid, text) to authenticated;

-- Same signature and columns as before (enqueue_generation calls it); now reads the series' quality.
create or replace function studio.route_model(p_shot uuid)
 returns table(kind text, model_id text, reason text, evidence text)
 language plpgsql stable security definer set search_path to ''
as $function$
declare v_shot studio.shots; v_kind text; v_look text; v_tier text; r studio.model_routes; t studio.model_routes_tier;
        m studio.models; v_model text; v_reason text; v_evidence text;
begin
  if studio.shot_owner(p_shot) is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot) then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot;
  select se.look, se.quality into v_look, v_tier from studio.scenes sc join studio.series se on se.id = sc.series_id
   where sc.id = v_shot.scene_id;
  v_look := coalesce(v_look, 'cartoon'); v_tier := coalesce(v_tier, 'balanced');
  v_kind := studio.shot_kind(v_shot.action);

  select * into r from studio.model_routes where model_routes.look = v_look and model_routes.kind = v_kind;
  if not found then select * into r from studio.model_routes where model_routes.look = v_look and model_routes.kind = 'other'; end if;
  if not found then select * into r from studio.model_routes where model_routes.look = 'cartoon' and model_routes.kind = 'other'; end if;
  v_model := r.model_id; v_reason := r.reason; v_evidence := r.evidence;

  if v_tier <> 'balanced' then
    select * into t from studio.model_routes_tier x where x.look = v_look and x.kind = v_kind and x.tier = v_tier;
    if not found then select * into t from studio.model_routes_tier x where x.look = v_look and x.kind = 'other' and x.tier = v_tier; end if;
    if found then
      v_model := t.model_id; v_reason := t.reason; v_evidence := t.evidence;
    else
      v_reason := format('No %s pick has been tested for this kind of shot yet, so Auto uses the balanced pick. ',
                         case v_tier when 'best' then '"best quality"' else '"lowest cost"' end) || v_reason;
    end if;
  end if;

  select * into m from studio.models where id = v_model and active;
  if found and v_shot.duration_s between m.min_duration_s and m.max_duration_s then
    return query select v_kind, v_model, v_reason, v_evidence; return;
  end if;
  select * into m from studio.models where active and provider <> 'mock'
     and v_shot.duration_s between min_duration_s and max_duration_s order by usd_per_second limit 1;
  if not found then raise exception 'no model can make a % s clip', v_shot.duration_s; end if;
  return query select v_kind, m.id, format('%s cannot make a %s s clip; using %s instead.', v_model, v_shot.duration_s, m.id),
                      v_evidence;
end $function$;
