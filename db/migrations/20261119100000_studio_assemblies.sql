-- Scene assembly (2026-11-19, Londi: "add into the app the same engine you use to assemble video clips").
-- A creator asks for a scene's cut; the worker joins the approved clips in shot order with the methods proven on
-- the content projects (frame-exact cuts at one frame rate, conform per format, constant music bed, -14 LUFS,
-- libx264 crf 18 + faststart, length/black-frame checks). No credits are charged: it runs on the worker's CPU.
-- Unpaid accounts get a watermarked copy, the clean one goes to the vault (same rule as clips, has_paid).
create table if not exists studio.assemblies (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null,
  scene_id     uuid not null references studio.scenes(id) on delete cascade,
  format       text not null check (format in ('16x9', '9x16', '4x5')),
  options      jsonb not null default '{}'::jsonb,     -- fade (bool), end_card (bool), music_path (text)
  items        jsonb not null,                         -- [{shot_id, ord, generation_id, path}] in edit order
  skipped      jsonb not null default '[]'::jsonb,     -- shot numbers with no approved clip
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  output_path  text,
  preview_path text,
  duration_s   numeric,
  report       jsonb,
  error        text,
  tries        int not null default 0,
  locked_by    text,
  locked_until timestamptz,
  next_try_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists assemblies_owner_idx on studio.assemblies(owner, created_at desc);
alter table studio.assemblies enable row level security;
create policy assemblies_own on studio.assemblies for select to authenticated using (owner = (select auth.uid()));
create policy worker_all_assemblies on studio.assemblies for all to studio_worker using (true) with check (true);
revoke all on studio.assemblies from public, anon;
grant select on studio.assemblies to authenticated;
grant select, update on studio.assemblies to studio_worker;

create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_format not in ('16x9', '9x16', '4x5') then raise exception 'format must be 16x9, 9x16 or 4x5'; end if;
  if exists (select 1 from studio.assemblies where owner = v_owner and status in ('queued', 'running')) then
    raise exception 'a cut is already being made; wait for it to finish';
  end if;

  v_music := nullif(trim(coalesce(p_options->>'music_path', '')), '');
  if v_music is not null and (left(v_music, 37) <> v_owner::text || '/' or v_music like '%..%') then
    raise exception 'music must be a file you uploaded';
  end if;
  v_opts := jsonb_build_object('fade', coalesce((p_options->>'fade')::boolean, true),
                               'end_card', coalesce((p_options->>'end_card')::boolean, false),
                               'music_path', v_music);

  select coalesce(jsonb_agg(jsonb_build_object('shot_id', sh.id, 'ord', sh.ord, 'generation_id', g.id, 'path', g.output_path)
                            order by sh.ord), '[]'::jsonb)
    into v_items
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null;
  if jsonb_array_length(v_items) = 0 then raise exception 'approve at least one clip in this scene first'; end if;
  select coalesce(jsonb_agg(sh.ord order by sh.ord), '[]'::jsonb) into v_skipped
    from studio.shots sh left join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and (sh.approved_generation_id is null or g.output_path is null);

  insert into studio.assemblies(owner, scene_id, format, options, items, skipped)
  values (v_owner, p_scene, p_format, v_opts, v_items, v_skipped) returning id into v_id;
  return v_id;
end $$;
revoke all on function studio.request_assembly(uuid, text, jsonb) from public, anon;
grant execute on function studio.request_assembly(uuid, text, jsonb) to authenticated;

create or replace function studio.claim_assemblies(p_worker text, p_limit int default 1, p_lease_s int default 900)
returns setof studio.assemblies language plpgsql security definer set search_path to '' as $$
begin
  return query
  update studio.assemblies a set locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_s),
         status = 'running', updated_at = now()
   where a.id in (select id from studio.assemblies
                   where status in ('queued', 'running') and (locked_until is null or locked_until < now())
                     and next_try_at <= now()
                   order by created_at limit p_limit for update skip locked)
  returning a.*;
end $$;
revoke all on function studio.claim_assemblies(text, int, int) from public, anon, authenticated;
grant execute on function studio.claim_assemblies(text, int, int) to studio_worker;
