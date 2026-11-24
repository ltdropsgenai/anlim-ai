-- Duplicate a project or a scene, and referrals (2026-11-23, Londi: "all of the above"). @anlim
--
-- 1. Duplicates share files: a copied project points at the same cast pictures, places and start frames as the one it
--    came from (no second copy in storage). So a file is now removed only when nothing points at it any more:
--    studio.still_used lists the paths, of those a delete returned, that another row still uses (studio-api removeFiles).
-- 2. studio.duplicate_series: a new project with the same look, style, shape, cast, places, scenes and shots (words,
--    camera, length, who is in them, approved start and end frames), without clips, cuts or audio: ready to render a
--    new version or the next episode. studio.duplicate_scene: the same for one scene, inside its project.
-- 3. Referrals: each account has a code; a creator who signs up from an invite link and buys credits or a plan earns
--    credits for both of them. The amount is studio.settings 'referral_credits' and starts at 0 (off) until Londi sets it.

create or replace function studio.still_used(p_paths text[]) returns setof text
language sql stable security definer set search_path = '' as $$
  select p from unnest(p_paths) p where
       exists (select 1 from studio.characters c where c.ref_front_path = p or p = any(c.ref_angle_paths))
    or exists (select 1 from studio.locations l where l.layout_path = p or p = any(l.other_plates))
    or exists (select 1 from studio.shots s where s.start_frame_path = p or s.end_frame_path = p or s.motion_source_path = p or p = any(s.motion_ref_paths))
    or exists (select 1 from studio.generations g where g.output_path = p or g.preview_path = p)
    or exists (select 1 from studio.assemblies a where a.output_path = p or a.preview_path = p)
    or exists (select 1 from studio.audio_jobs a where a.output_path = p)
    or exists (select 1 from studio.frame_jobs f where f.composed_path = p or f.raw_path = p or f.source_path = p) $$;
revoke execute on function studio.still_used(text[]) from public, anon, authenticated;
grant execute on function studio.still_used(text[]) to service_role;

-- shots of one scene copied into another (cast ids mapped through p_map: old character id -> new, or kept as they are)
create or replace function studio.copy_shots(p_from uuid, p_to uuid, p_map jsonb default '{}'::jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into studio.shots(scene_id, ord, action, camera, duration_s, start_frame_path, end_frame_path, start_frame_approved,
                           end_frame_approved, end_instruction, motion_complexity, status, cast_ids, words)
  select p_to, s.ord, s.action, s.camera, s.duration_s,
         case when s.start_frame_approved then s.start_frame_path end, case when s.end_frame_approved then s.end_frame_path end,
         s.start_frame_approved and s.start_frame_path is not null, s.end_frame_approved and s.end_frame_path is not null,
         s.end_instruction, s.motion_complexity, 'draft',
         coalesce((select array_agg(coalesce((p_map ->> c::text)::uuid, c)) from unnest(s.cast_ids) c), '{}'), s.words
    from studio.shots s where s.scene_id = p_from and s.motion_source_path is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function studio.copy_shots(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function studio.duplicate_series(p_series uuid, p_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); se studio.series; v_new uuid; v_name text; v_map jsonb := '{}'; v_lmap jsonb := '{}';
        c studio.characters; l studio.locations; sc studio.scenes; v_id uuid; v_sc uuid; k int := 1;
begin
  select * into se from studio.series where id = p_series and owner = v_uid;
  if not found then raise exception 'project not found'; end if;
  v_name := left(coalesce(nullif(trim(p_name), ''), se.name || ' (copy)'), 200);
  while exists (select 1 from studio.series where owner = v_uid and name = v_name) loop
    k := k + 1; v_name := left(coalesce(nullif(trim(p_name), ''), se.name || ' (copy)'), 190) || ' ' || k;
  end loop;
  insert into studio.series(owner, name, style_prompt, look, quality, genre, aspect)
    values (v_uid, v_name, se.style_prompt, se.look, se.quality, se.genre, se.aspect) returning id into v_new;
  for c in select * from studio.characters where series_id = p_series loop
    -- the copy points at the same photo; it was in the creator's own project already
    if c.ref_front_path is not null and coalesce(c.kind, 'person') = 'person' and not studio.has_likeness_consent(v_uid, c.ref_front_path) then
      insert into studio.likeness_consents(owner, kind, path, statement, via)
        values (v_uid, 'character', c.ref_front_path, 'Copied from the creator''s own project (no new upload).', 'app');
    end if;
    insert into studio.characters(series_id, name, ref_front_path, ref_angle_paths, height_units, build, palette, wardrobe, voice_id, kind, what)
      values (v_new, c.name, c.ref_front_path, c.ref_angle_paths, c.height_units, c.build, c.palette, c.wardrobe, c.voice_id, c.kind, c.what)
      returning id into v_id;
    v_map := v_map || jsonb_build_object(c.id::text, v_id);
  end loop;
  for l in select * from studio.locations where series_id = p_series loop
    insert into studio.locations(series_id, name, description, layout_path, other_plates)
      values (v_new, l.name, l.description, l.layout_path, l.other_plates) returning id into v_id;
    v_lmap := v_lmap || jsonb_build_object(l.id::text, v_id);
  end loop;
  for sc in select * from studio.scenes where series_id = p_series order by ord loop
    insert into studio.scenes(series_id, location_id, ord, title, blocking)
      values (v_new, (v_lmap ->> sc.location_id::text)::uuid, sc.ord, sc.title, sc.blocking) returning id into v_sc;
    perform studio.copy_shots(sc.id, v_sc, v_map);
  end loop;
  return v_new;
end $$;
revoke execute on function studio.duplicate_series(uuid, text) from public, anon;
grant execute on function studio.duplicate_series(uuid, text) to authenticated;

create or replace function studio.duplicate_scene(p_scene uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare sc studio.scenes; v_new uuid;
begin
  select s.* into sc from studio.scenes s join studio.series se on se.id = s.series_id where s.id = p_scene and se.owner = auth.uid();
  if not found then raise exception 'scene not found'; end if;
  insert into studio.scenes(series_id, location_id, ord, title, blocking)
    values (sc.series_id, sc.location_id, coalesce((select max(ord) from studio.scenes where series_id = sc.series_id), 0) + 1,
            left(sc.title || ' (copy)', 200), sc.blocking) returning id into v_new;
  perform studio.copy_shots(p_scene, v_new);
  return v_new;
end $$;
revoke execute on function studio.duplicate_scene(uuid) from public, anon;
grant execute on function studio.duplicate_scene(uuid) to authenticated;

-- ---- referrals
insert into studio.settings(key, value, note) values ('referral_credits', '0'::jsonb,
  'credits for both the inviter and the invited creator when the invited one first buys credits or a plan; 0 = off (2026-11-23)')
on conflict (key) do nothing;
insert into studio.settings(key, value, note) values ('referral_monthly_cap', '20'::jsonb,
  'most referral rewards one inviter can earn in 30 days (2026-11-23)')
on conflict (key) do nothing;

alter table studio.accounts add column if not exists referral_code text unique;
create table if not exists studio.referrals (
  referred uuid primary key references auth.users(id) on delete cascade,
  referrer uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  rewarded_at timestamptz,
  credits int
);
create index if not exists referrals_referrer on studio.referrals(referrer);
alter table studio.referrals enable row level security;
revoke all on studio.referrals from public, anon, authenticated;

-- The creator's own invite code (made on first ask) and how many they invited.
create or replace function studio.my_referral() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_code text; v_amount int;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  insert into studio.accounts(owner) values (v_uid) on conflict do nothing;
  select referral_code into v_code from studio.accounts where owner = v_uid;
  while v_code is null loop
    v_code := substr(md5(random()::text || clock_timestamp()::text || v_uid::text), 1, 8);
    begin update studio.accounts set referral_code = v_code where owner = v_uid and referral_code is null;
    exception when unique_violation then v_code := null; end;
  end loop;
  select (value #>> '{}')::int into v_amount from studio.settings where key = 'referral_credits';
  return jsonb_build_object('code', v_code, 'credits', coalesce(v_amount, 0),
    'invited', (select count(*) from studio.referrals where referrer = v_uid),
    'rewarded', (select count(*) from studio.referrals where referrer = v_uid and rewarded_at is not null));
end $$;
revoke execute on function studio.my_referral() from public, anon;
grant execute on function studio.my_referral() to authenticated;

-- A new creator who came from an invite link: within 7 days of sign-up, before any purchase, once, not themselves.
create or replace function studio.claim_referral(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_ref uuid; v_joined timestamptz;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  select owner into v_ref from studio.accounts where referral_code = lower(trim(p_code));
  select created_at into v_joined from auth.users where id = v_uid;
  if v_ref is null or v_ref = v_uid or v_joined < now() - interval '7 days'
     or exists (select 1 from studio.referrals where referred = v_uid)
     or exists (select 1 from studio.payments where owner = v_uid) then return false; end if;
  insert into studio.referrals(referred, referrer) values (v_uid, v_ref) on conflict do nothing;
  return true;
end $$;
revoke execute on function studio.claim_referral(text) from public, anon;
grant execute on function studio.claim_referral(text) to authenticated;

-- First purchase of an invited creator: both get the credits (when referral_credits > 0 and the inviter is under the cap).
create or replace function studio.trg_referral_reward() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r studio.referrals; v_amount int; v_cap int; who uuid;
begin
  select * into r from studio.referrals where referred = new.owner and rewarded_at is null for update;
  if not found then return new; end if;
  select (value #>> '{}')::int into v_amount from studio.settings where key = 'referral_credits';
  select (value #>> '{}')::int into v_cap from studio.settings where key = 'referral_monthly_cap';
  if coalesce(v_amount, 0) <= 0 then return new; end if;
  if (select count(*) from studio.referrals where referrer = r.referrer and rewarded_at > now() - interval '30 days') >= coalesce(v_cap, 20) then
    return new; end if;
  foreach who in array array[r.referrer, r.referred] loop
    insert into studio.accounts(owner) values (who) on conflict do nothing;
    update studio.accounts set balance = balance + v_amount, updated_at = now() where owner = who;
    insert into studio.credit_ledger(owner, kind, credits) values (who, 'grant', v_amount);
    insert into studio.notifications(owner, kind, title, body, link)
      values (who, 'referral', 'Referral credits',
              case when who = r.referrer then format('%s credits were added: a creator you invited bought credits or a plan.', v_amount)
                   else format('%s credits were added for joining from an invite and making your first purchase.', v_amount) end, '/billing');
  end loop;
  update studio.referrals set rewarded_at = now(), credits = v_amount where referred = r.referred;
  return new;
end $$;
drop trigger if exists referral_reward on studio.payments;
create trigger referral_reward after insert on studio.payments for each row execute function studio.trg_referral_reward();
