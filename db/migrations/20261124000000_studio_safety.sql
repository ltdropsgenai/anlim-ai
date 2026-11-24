-- Safety (2026-11-23, Londi: "all of the above need to be fixed"). @anlim
-- 1. Likeness consent. Before a photo of a person becomes a character's reference, an uploaded start still, or the
--    source or references of a motion transfer, the creator confirms that any real person in it is them or agreed to
--    it. The confirmation is kept per file (studio.likeness_consents). Triggers on characters and shots enforce it, so
--    no route (app, connector, a future one) can skip it. Files saved before this migration keep working.
-- 2. Content check log. The worker asks the checker (frame_check/moderate.py) before every paid image, video or audio
--    job; each answer is kept in studio.moderation_log (server only).

create table if not exists studio.likeness_consents (
  id bigint generated always as identity primary key,
  owner uuid not null,
  at timestamptz not null default now(),
  kind text not null check (kind in ('character', 'start_still', 'motion', 'upload')),
  path text not null,
  statement text not null,
  via text not null check (via in ('app', 'connector'))
);
create index if not exists likeness_consents_owner_path on studio.likeness_consents(owner, path);
alter table studio.likeness_consents enable row level security;
revoke all on studio.likeness_consents from public, anon, authenticated;
grant select on studio.likeness_consents to authenticated;
create policy consents_own on studio.likeness_consents for select to authenticated using (owner = auth.uid());

-- The words the creator agrees to (shown next to the checkbox in the app and on the upload page).
create or replace function studio.likeness_statement() returns text language sql immutable set search_path = '' as $$
  select 'Any real person in this picture or video is me, or has agreed that I may use their likeness here.'::text $$;
grant execute on function studio.likeness_statement() to authenticated;

-- Record the creator's confirmation for their own files (at most 20 at a time).
create or replace function studio.record_likeness_consent(p_paths text[], p_kind text, p_via text default 'app')
returns int language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); p text; n int := 0;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if p_kind not in ('character', 'start_still', 'motion', 'upload') then raise exception 'unknown consent kind'; end if;
  if p_via not in ('app', 'connector') then raise exception 'unknown consent route'; end if;
  if coalesce(cardinality(p_paths), 0) not between 1 and 20 then raise exception 'confirm 1 to 20 files at a time'; end if;
  foreach p in array p_paths loop
    if p is null or p like '%..%' or split_part(p, '/', 1) <> v_uid::text then raise exception 'file not found'; end if;
    insert into studio.likeness_consents(owner, kind, path, statement, via) values (v_uid, p_kind, p, studio.likeness_statement(), p_via);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function studio.record_likeness_consent(text[], text, text) from public, anon;
grant execute on function studio.record_likeness_consent(text[], text, text) to authenticated;

create or replace function studio.has_likeness_consent(p_owner uuid, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from studio.likeness_consents where owner = p_owner and path = p_path) $$;
revoke execute on function studio.has_likeness_consent(uuid, text) from public, anon;
grant execute on function studio.has_likeness_consent(uuid, text) to authenticated;

-- A person's reference photo needs a confirmation when it is set or replaced (animals and objects do not).
create or replace function studio.trg_character_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if new.ref_front_path is null or coalesce(new.kind, 'person') <> 'person' then return new; end if;
  if tg_op = 'UPDATE' and new.ref_front_path is not distinct from old.ref_front_path then return new; end if;
  select owner into v_owner from studio.series where id = new.series_id;
  if not studio.has_likeness_consent(v_owner, new.ref_front_path) then
    raise exception 'Confirm that the person in this photo is you or agreed to it (likeness consent).'; end if;
  return new;
end $$;
drop trigger if exists character_consent on studio.characters;
create trigger character_consent before insert or update of ref_front_path, kind on studio.characters
  for each row execute function studio.trg_character_consent();

-- An uploaded start still (the creator's own stills/ folder) and a motion transfer's source and references.
-- Stills anlim made (frames/) are not uploads and need nothing.
create or replace function studio.trg_shot_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; r text;
begin
  v_owner := studio.shot_owner(new.id);
  if new.start_frame_path is distinct from old.start_frame_path and new.start_frame_path like v_owner::text || '/stills/%'
     and not studio.has_likeness_consent(v_owner, new.start_frame_path) then
    raise exception 'Confirm that any real person in this picture is you or agreed to it (likeness consent).'; end if;
  if new.motion_source_path is distinct from old.motion_source_path and new.motion_source_path is not null
     and not studio.has_likeness_consent(v_owner, new.motion_source_path) then
    raise exception 'Confirm that any real person in the source video is you or agreed to it (likeness consent).'; end if;
  if new.motion_ref_paths is distinct from old.motion_ref_paths and new.motion_ref_paths is not null then
    foreach r in array new.motion_ref_paths loop
      if not studio.has_likeness_consent(v_owner, r) then
        raise exception 'Confirm that any real person in the reference pictures is you or agreed to it (likeness consent).'; end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists shot_consent on studio.shots;
create trigger shot_consent before update of start_frame_path, motion_source_path, motion_ref_paths on studio.shots
  for each row execute function studio.trg_shot_consent();

-- Content check answers (worker writes, nobody else reads through the API)
create table if not exists studio.moderation_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('clip', 'frame', 'audio')),
  ref_id uuid not null,
  owner uuid,
  verdict text not null check (verdict in ('ALLOW', 'BLOCK')),
  category text,
  reason text,
  model text,
  usd numeric(10, 5) not null default 0,
  images int not null default 0
);
create index if not exists moderation_log_ref on studio.moderation_log(kind, ref_id);
alter table studio.moderation_log enable row level security;
revoke all on studio.moderation_log from public, anon, authenticated;
grant select, insert on studio.moderation_log to studio_worker;
create policy worker_moderation on studio.moderation_log for all to studio_worker using (true) with check (true);

-- A character cut out of a still in the creator's own project (use_cutout) is not a new upload: the still was made by
-- anlim (checked) or uploaded as a start still (which needs the consent above). It is recorded as derived, not asked again.
create or replace function studio.use_cutout(p_job uuid, p_index integer, p_character uuid)
returns text language plpgsql security definer set search_path = '' as $function$
declare j studio.frame_jobs; v_path text; v_job_series uuid; v_char_series uuid;
begin
  select * into j from studio.frame_jobs where id = p_job;
  if not found or j.kind <> 'cutout' or (auth.uid() is not null and j.owner <> auth.uid()) then raise exception 'not found'; end if;
  if j.status not in ('ready','approved') then raise exception 'the cut-outs are %', j.status; end if;
  select sc.series_id into v_job_series from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id where sh.id = j.shot_id;
  select series_id into v_char_series from studio.characters where id = p_character;
  if v_char_series is null or v_char_series <> v_job_series then raise exception 'character not found in this series'; end if;
  select c->>'path' into v_path from jsonb_array_elements(j.check_result->'cutouts') c where (c->>'index')::int = p_index;
  if v_path is null then raise exception 'no cut-out number %', p_index; end if;
  insert into studio.likeness_consents(owner, kind, path, statement, via)
    values (j.owner, 'character', v_path, 'Cut out of a still in the creator''s own project (no new upload).', 'app');
  perform studio.set_character_ref(p_character, v_path);
  return v_path;
end $function$;
