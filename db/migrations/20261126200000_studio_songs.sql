-- Songs (2026-11-26, Londi: "a music composer ... akin to Suno", a feature inside anlim, all five items):
-- 1. The score can be a SONG: lyrics (with [Verse] / [Chorus] tags) sung by ElevenLabs Music on the creator's own
--    ElevenLabs account (as the score already is; anlim charges nothing).
-- 2. Or on anlim's own account through fal (provider 'anlim', no ElevenLabs needed), paid in anlim credits: a music
--    model row (studio.models kind 'music') gives credits per minute and a minimum per song. Reserved when asked,
--    charged when the song is delivered, released if it fails (studio.settle_audio_job), like clips and frames. The
--    model rows start INACTIVE: the price is Londi's decision (claude/anlim-songs-2026-11-26.md).
-- 3. Lyrics drafts: studio.lyrics_drafts + studio.request_lyrics; the worker asks the checker (/lyrics, Claude) for
--    original lyrics from the creator's description; the creator edits them before the song is made.
-- Everything else in request_audio is as it was (20261123*). @anlim

-- 2. music models and what a song costs
alter table studio.models add column if not exists credits_per_minute integer;
alter table studio.models add column if not exists min_credits integer;
-- a music model: priced per minute (credits_per_minute, min_credits); credits_per_second must be > 0 and is not used
alter table studio.models drop constraint if exists models_kind_check;
alter table studio.models add constraint models_kind_check check (kind in ('clip', 'motion', 'lipsync', 'music'));
insert into studio.models(id, provider, endpoint, resolution, credits_per_second, usd_per_second, active, min_duration_s, max_duration_s,
                          label, kind, bill_step_s, credits_per_minute, min_credits)
values ('minimax-music-3', 'fal', 'minimax/music-3', 'audio', 1, 0.0020, false, 10, 300, 'MiniMax Music 3', 'music', 1, 30, 15)
on conflict (id) do nothing;

alter table studio.audio_jobs add column if not exists model_id text references studio.models(id);
alter table studio.audio_jobs add column if not exists credits_reserved integer not null default 0;
alter table studio.audio_jobs add column if not exists settled text;
alter table studio.credit_ledger add column if not exists audio_job_id uuid references studio.audio_jobs(id) on delete set null;

create or replace function studio.song_credits(p_model text, p_len numeric)
returns integer language sql stable security definer set search_path to '' as $$
  select greatest(coalesce(m.min_credits, 0), ceil(p_len * coalesce(m.credits_per_minute, 0) / 60.0))::int
    from studio.models m where m.id = p_model and m.kind = 'music'
$$;
grant execute on function studio.song_credits(text, numeric) to authenticated;

create or replace function studio.settle_audio_job(p_job uuid, p_outcome text)
returns text language plpgsql security definer set search_path to '' as $$
declare j studio.audio_jobs;
begin
  if p_outcome not in ('charge', 'release') then raise exception 'bad outcome'; end if;
  select * into j from studio.audio_jobs where id = p_job for update;
  if not found then raise exception 'audio job not found'; end if;
  if j.settled is not null then return j.settled; end if;
  if j.credits_reserved > 0 then
    perform 1 from studio.accounts where owner = j.owner for update;
    update studio.accounts set reserved = reserved - j.credits_reserved,
           balance = balance - case when p_outcome = 'charge' then j.credits_reserved else 0 end, updated_at = now()
     where owner = j.owner;
    insert into studio.credit_ledger(owner, kind, credits, audio_job_id, note)
    values (j.owner, p_outcome, j.credits_reserved, j.id, 'song');
  end if;
  update studio.audio_jobs set settled = case p_outcome when 'charge' then 'charged' else 'released' end, updated_at = now()
   where id = p_job;
  return case p_outcome when 'charge' then 'charged' else 'released' end;
end $$;
revoke all on function studio.settle_audio_job(uuid, text) from public, anon, authenticated;  -- granted to studio_worker below

create or replace function studio.request_audio(p_scene uuid, p_shot uuid, p_kind text, p_input jsonb)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare v_owner uuid; v_id uuid; v_text text; v_in jsonb; n int; v_dur numeric; v_len numeric;
        v_secs jsonb := '[]'::jsonb; v_sec jsonb; v_label text; v_s numeric; v_total numeric := 0; v_styles text;
        v_lyrics text; v_prov text; v_xi boolean; v_model studio.models; v_cost int := 0;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_kind not in ('voiceover', 'sfx', 'music') then raise exception 'unknown kind of audio'; end if;
  if p_kind = 'music' then p_shot := null;
  elsif p_shot is null and p_kind = 'voiceover' then null;   -- 2026-11-23: scene narration, one line over the whole cut
  elsif p_shot is null or not exists (select 1 from studio.shots where id = p_shot and scene_id = p_scene) then
    raise exception 'pick a shot of this scene';
  end if;
  v_xi := exists (select 1 from studio.connections where owner = v_owner and provider = 'elevenlabs' and status = 'ok');
  -- 2026-11-26: a song may be made on anlim's account (credits) instead of the creator's ElevenLabs
  v_prov := case when p_kind = 'music' then coalesce(nullif(p_input->>'provider', ''), case when v_xi then 'elevenlabs' else 'anlim' end)
                 else 'elevenlabs' end;
  if v_prov not in ('elevenlabs', 'anlim') then raise exception 'provider must be elevenlabs or anlim'; end if;
  if v_prov = 'elevenlabs' and not v_xi then
    raise exception 'connect your ElevenLabs account first (Account > Connections)%',
      case when p_kind = 'music' then ', or make the song with anlim credits (provider anlim)' else '' end;
  end if;
  select count(*) into n from studio.audio_jobs where owner = v_owner and status in ('queued', 'running');
  if n >= 6 then raise exception 'six pieces of audio are already being made; wait for them to finish'; end if;
  -- 2026-11-23 (review): audio runs on the creator's own ElevenLabs credits; a looping tool must not drain them
  select count(*) into n from studio.audio_jobs where owner = v_owner and created_at > now() - interval '24 hours';
  if n >= 100 then raise exception 'you made 100 pieces of audio in the last 24 hours; try again later'; end if;

  v_text := trim(coalesce(p_input->>'text', ''));
  if p_kind = 'voiceover' then
    if v_text = '' then raise exception 'write what you want first'; end if;
    if length(v_text) > 3000 then raise exception 'a voiceover line can be up to 3,000 characters'; end if;
    if coalesce(p_input->>'voice_id', '') !~ '^[A-Za-z0-9]{8,40}$' then raise exception 'pick a voice'; end if;
    v_in := jsonb_build_object('text', v_text, 'voice_id', p_input->>'voice_id', 'voice_name', left(coalesce(p_input->>'voice_name', ''), 80),
                               'model', 'eleven_v3');
    if p_shot is null then                                      -- narration: where it starts in the cut, in seconds
      v_s := coalesce(nullif(p_input->>'at_s', '')::numeric, 0);
      if v_s < 0 or v_s > 600 then raise exception 'the narration starts 0 to 600 seconds into the cut'; end if;
      v_in := v_in || jsonb_build_object('at_s', round(v_s, 2));
    end if;
  elsif p_kind = 'sfx' then
    if v_text = '' then raise exception 'write what you want first'; end if;
    if length(v_text) > 450 then raise exception 'describe the sound in up to 450 characters'; end if;
    v_dur := nullif(p_input->>'duration_s', '')::numeric;
    if v_dur is not null and (v_dur < 0.5 or v_dur > 30) then raise exception 'a sound effect can be 0.5 to 30 seconds'; end if;
    v_in := jsonb_build_object('text', v_text, 'duration_s', v_dur);
  else
    v_styles := nullif(trim(coalesce(p_input->>'styles', '')), '');
    if length(coalesce(v_styles, '')) > 1000 then raise exception 'describe the score''s style in up to 1,000 characters'; end if;
    v_lyrics := nullif(trim(coalesce(p_input->>'lyrics', '')), '');
    if length(coalesce(v_lyrics, '')) > 3500 then raise exception 'lyrics can be up to 3,500 characters'; end if;
    if v_prov = 'anlim' then
      -- 2026-11-26: a song on anlim's account, paid in credits
      if v_lyrics is null then raise exception 'write the lyrics first (songs made with anlim credits are sung)'; end if;
      select * into v_model from studio.models where id = coalesce(nullif(p_input->>'model', ''), 'minimax-music-3') and kind = 'music';
      if v_model.id is null then raise exception 'unknown music model'; end if;
      if not v_model.active then raise exception 'songs with anlim credits are not open yet'; end if;
      if v_styles is null and v_text = '' then raise exception 'describe the song''s style first'; end if;
      v_len := coalesce(nullif(p_input->>'length_s', '')::numeric, 60);
      if v_len < v_model.min_duration_s or v_len > v_model.max_duration_s then
        raise exception 'a song with % can be % to % seconds', v_model.label, v_model.min_duration_s, v_model.max_duration_s; end if;
      v_cost := studio.song_credits(v_model.id, v_len);
      perform studio.reserve_frame_credits(v_owner, v_cost);
      v_in := jsonb_build_object('text', coalesce(v_styles, v_text), 'styles', coalesce(v_styles, v_text), 'lyrics', v_lyrics,
                                 'length_s', round(v_len, 1), 'instrumental', false, 'model', v_model.id);
    elsif v_lyrics is not null then
      -- 2026-11-26: a song on the creator's ElevenLabs (the worker turns the [Section] tags into the composition plan)
      if v_styles is null and v_text = '' then raise exception 'describe the song''s style first'; end if;
      v_len := coalesce(nullif(p_input->>'length_s', '')::numeric, 60);
      if v_len < 10 or v_len > 600 then raise exception 'a song can be 10 seconds to 10 minutes'; end if;
      v_in := jsonb_build_object('text', coalesce(v_styles, v_text), 'styles', coalesce(v_styles, v_text), 'lyrics', v_lyrics,
                                 'length_s', round(v_len, 1), 'instrumental', false, 'model', 'music_v2_5');
    elsif jsonb_typeof(p_input->'sections') = 'array' and jsonb_array_length(p_input->'sections') > 0 then
      -- a score shaped to the shots: one section per shot, in order
      if jsonb_array_length(p_input->'sections') > 30 then raise exception 'a score can have up to 30 sections'; end if;
      for v_sec in select value from jsonb_array_elements(p_input->'sections') loop
        v_label := left(trim(coalesce(v_sec->>'label', '')), 60);
        if v_label = '' then v_label := 'Section ' || (jsonb_array_length(v_secs) + 1); end if;
        v_s := nullif(v_sec->>'seconds', '')::numeric;
        if v_s is null or v_s < 3 or v_s > 120 then raise exception 'each section is 3 to 120 seconds (%: %)', v_label, coalesce(v_s::text, 'none'); end if;
        if length(coalesce(v_sec->>'styles', '')) > 500 then raise exception 'describe % in up to 500 characters', v_label; end if;
        if length(coalesce(v_sec->>'avoid', '')) > 300 then raise exception 'keep what % avoids under 300 characters', v_label; end if;
        v_secs := v_secs || jsonb_build_object('label', v_label, 'seconds', round(v_s, 1),
                    'styles', trim(coalesce(v_sec->>'styles', '')), 'avoid', trim(coalesce(v_sec->>'avoid', '')));
        v_total := v_total + round(v_s, 1);
      end loop;
      if v_total < 3 or v_total > 600 then raise exception 'a score can be 3 seconds to 10 minutes (this one is % s)', v_total; end if;
      if v_styles is null and v_text = '' then raise exception 'describe the score''s style first'; end if;
      v_in := jsonb_build_object('text', coalesce(v_styles, v_text), 'styles', coalesce(v_styles, v_text), 'sections', v_secs,
                                 'length_s', v_total, 'instrumental', true, 'model', 'music_v2_5');
    else
      if v_text = '' and v_styles is null then raise exception 'write what you want first'; end if;
      v_text := coalesce(nullif(v_text, ''), v_styles);
      if length(v_text) > 2000 then raise exception 'describe the score in up to 2,000 characters'; end if;
      v_len := coalesce(nullif(p_input->>'length_s', '')::numeric, 30);
      if v_len < 3 or v_len > 600 then raise exception 'a score can be 3 seconds to 10 minutes'; end if;
      v_in := jsonb_build_object('text', v_text, 'length_s', round(v_len, 1), 'instrumental', coalesce((p_input->>'instrumental')::boolean, true),
                                 'model', 'music_v2_5');
    end if;
  end if;
  insert into studio.audio_jobs(owner, scene_id, shot_id, kind, input, provider, model_id, credits_reserved)
  values (v_owner, p_scene, p_shot, p_kind, v_in, v_prov, case when v_prov = 'anlim' then v_model.id end, v_cost)
  returning id into v_id;
  return v_id;
end $function$;

-- 3. lyrics drafts
create table if not exists studio.lyrics_drafts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  scene_id uuid references studio.scenes(id) on delete set null,
  brief text not null,
  language text,
  styles text,
  length_s numeric,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  lyrics text,
  title text,
  error text,
  tries integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lyrics_drafts_queue on studio.lyrics_drafts(status, created_at) where status in ('queued', 'running');
alter table studio.lyrics_drafts enable row level security;
drop policy if exists lyrics_drafts_own on studio.lyrics_drafts;
create policy lyrics_drafts_own on studio.lyrics_drafts for select to authenticated using (owner = auth.uid());
grant select on studio.lyrics_drafts to authenticated;

create or replace function studio.request_lyrics(p_brief text, p_language text default null, p_styles text default null,
                                                 p_length_s numeric default null, p_scene uuid default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid; n int;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_brief is null or length(trim(p_brief)) < 3 then raise exception 'say what the song is about first'; end if;
  if length(p_brief) > 1500 then raise exception 'describe the song in up to 1,500 characters'; end if;
  if length(coalesce(p_styles, '')) > 500 then raise exception 'keep the style under 500 characters'; end if;
  if length(coalesce(p_language, '')) > 40 then raise exception 'name the language in a few words'; end if;
  if p_length_s is not null and (p_length_s < 10 or p_length_s > 600) then raise exception 'a song can be 10 seconds to 10 minutes'; end if;
  if p_scene is not null and not exists (select 1 from studio.scenes sc join studio.series se on se.id = sc.series_id
                                          where sc.id = p_scene and se.owner = auth.uid()) then raise exception 'scene not found'; end if;
  perform pg_advisory_xact_lock(hashtext('lyrics:' || auth.uid()::text));
  select count(*) into n from studio.lyrics_drafts where owner = auth.uid() and created_at > now() - interval '24 hours';
  if n >= 30 then raise exception 'you asked for 30 lyrics drafts in the last 24 hours; try again later'; end if;
  insert into studio.lyrics_drafts(owner, scene_id, brief, language, styles, length_s)
  values (auth.uid(), p_scene, trim(p_brief), nullif(trim(coalesce(p_language, '')), ''), nullif(trim(coalesce(p_styles, '')), ''), p_length_s)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function studio.request_lyrics(text, text, text, numeric, uuid) from public, anon;
grant execute on function studio.request_lyrics(text, text, text, numeric, uuid) to authenticated;

create or replace function studio.claim_lyrics(p_limit integer default 2, p_lease_s integer default 180)
returns setof studio.lyrics_drafts language plpgsql security definer set search_path to '' as $$
begin
  return query
  update studio.lyrics_drafts d set status = 'running', locked_until = now() + make_interval(secs => p_lease_s), updated_at = now()
   where d.id in (select id from studio.lyrics_drafts where status in ('queued', 'running') and (locked_until is null or locked_until < now())
                   order by created_at limit p_limit for update skip locked)
  returning d.*;
end $$;
revoke all on function studio.claim_lyrics(integer, integer) from public, anon, authenticated;

-- the worker (studio_worker) settles songs and writes the drafts
grant execute on function studio.settle_audio_job(uuid, text) to studio_worker;
grant execute on function studio.claim_lyrics(integer, integer) to studio_worker;
grant select, update on studio.lyrics_drafts to studio_worker;
drop policy if exists worker_all_lyrics_drafts on studio.lyrics_drafts;
create policy worker_all_lyrics_drafts on studio.lyrics_drafts for all to studio_worker using (true) with check (true);

-- 4. songs and lyrics drafts get their own content check (checker moderate.py kind 'song': lyrics copied from existing
--    songs and asking to sound like a named real singer are blocked as well)
alter table studio.moderation_log drop constraint if exists moderation_log_kind_check;
alter table studio.moderation_log add constraint moderation_log_kind_check check (kind in ('clip', 'frame', 'audio', 'song'));

-- 5. A song drives the video (2026-11-26): a shot without its own voiceover can be lip-synced to the scene's SONG (the
--    in-cut music that has lyrics). The worker cuts the song where that shot plays in the cut (worker.js
--    submitLipsync, from the kept clips before it). Everything else in lipsync_quote / lipsync_create is as it was.
create or replace function studio.lipsync_voice(p_shot uuid)
returns uuid language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select a.id from studio.audio_jobs a where a.shot_id = p_shot and a.kind = 'voiceover' and a.status = 'done' and a.in_cut
      order by a.created_at desc limit 1),
    (select a.id from studio.audio_jobs a join studio.shots sh on sh.scene_id = a.scene_id
      where sh.id = p_shot and a.shot_id is null and a.kind = 'music' and a.status = 'done' and a.in_cut
        and coalesce(a.input->>'lyrics', '') <> '' order by a.created_at desc limit 1))
$$;
revoke all on function studio.lipsync_voice(uuid) from public, anon;

create or replace function studio.lipsync_quote(p_shot uuid)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_uid uuid := auth.uid(); v_owner uuid; sh studio.shots; g studio.generations; v_vo studio.audio_jobs; m studio.models;
        v_len numeric; v_billed int; v_step int; v_last jsonb; v_why text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_uid is null or v_owner is null or v_owner <> v_uid then raise exception 'shot not found'; end if;
  select * into sh from studio.shots where id = p_shot;
  select * into m from studio.models where kind = 'lipsync' and active order by (id = 'veed-lipsync') desc, id limit 1;
  select jsonb_build_object('generation_id', x.id, 'status', x.status, 'error', x.error, 'kept', sh.approved_generation_id = x.id)
    into v_last from studio.generations x where x.shot_id = p_shot and x.route_kind = 'lipsync' order by x.created_at desc limit 1;
  select * into g from studio.generations where id = sh.approved_generation_id;
  select * into v_vo from studio.audio_jobs where id = studio.lipsync_voice(p_shot);
  v_len := coalesce(g.clip_s, sh.duration_s);
  v_why := case
    when m.id is null then 'Lip sync is not available right now.'
    when g.id is null or g.output_path is null then 'Keep a clip for this shot first.'
    when g.route_kind = 'lipsync' then null
    when v_vo.id is null then 'Make this shot''s voiceover first, or a song for the scene (it must be in the cut).'
    when coalesce(sh.speed, 1) <> 1 then 'Set this shot to normal speed (1x): the voice plays at normal speed, so a slowed clip cannot match it.'
    when v_len < m.min_duration_s or v_len > m.max_duration_s then format('Lip sync works on clips of %s to %s seconds; this one is %s s.', m.min_duration_s, m.max_duration_s, round(v_len, 1))
    when not studio.has_paid(v_uid) then 'Lip sync comes with a paid account (buy credits or a plan).'
    else null end;
  if v_why is null and g.route_kind = 'lipsync' then v_why := 'The kept clip is already lip-synced. Make the voiceover again to sync a new take.'; end if;
  v_step := greatest(1, coalesce(m.bill_step_s, 1));
  v_billed := greatest(v_step, ceil(coalesce(v_len, 5) / v_step::numeric)::int * v_step);
  return jsonb_build_object('ok', v_why is null, 'why', v_why, 'seconds', v_billed, 'clip_s', v_len,
                            'credits', v_billed * coalesce(m.credits_per_second, 18), 'model', m.id, 'model_label', m.label,
                            'last', v_last, 'to', case when v_vo.kind = 'music' then 'song' when v_vo.id is not null then 'voiceover' end);
end $function$;

create or replace function studio.lipsync_create(p_shot uuid)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := auth.uid(); q jsonb; sh studio.shots; v_vo uuid; v_cost int; v_acc studio.accounts; v_gen uuid;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  perform pg_advisory_xact_lock(hashtext('lipsync:' || p_shot::text));
  q := studio.lipsync_quote(p_shot);
  if not (q->>'ok')::boolean then raise exception '%', q->>'why'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and route_kind = 'lipsync' and status in ('queued', 'running', 'checking')) then
    raise exception 'A lip sync of this shot is already being made.'; end if;
  select * into sh from studio.shots where id = p_shot;
  v_vo := studio.lipsync_voice(p_shot);
  v_cost := (q->>'credits')::int;
  insert into studio.accounts(owner) values (v_uid) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_uid for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'Lip sync needs % credits; you have %.', v_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_uid;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved, route_kind, route_reason, lipsync_source, lipsync_audio, lipsync_s)
    values (v_uid, p_shot, q->>'model', v_cost, 'lipsync',
            case when q->>'to' = 'song' then 'Lip sync to the song: picked by the creator' else 'Lip sync to the voiceover: picked by the creator' end,
            sh.approved_generation_id, v_vo, (q->>'seconds')::int)
    returning id into v_gen;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_uid, 'reserve', v_cost, v_gen);
  return jsonb_build_object('generation_id', v_gen, 'credits', v_cost, 'seconds', (q->>'seconds')::int, 'model', q->>'model', 'to', q->>'to');
end $function$;

-- 5b. Shots on the song (2026-11-26): one or more shots per section of the scene's song (meta.sections, kept by the
--     worker when the song is done), each 5 to p_max seconds in whole seconds (clip models take whole seconds), rounded
--     on the running total so the shots add up to the song. The singer is the shot's cast; a section with lines says
--     what they sing, an instrumental one says they move to the music. Only on a scene with no shots yet, so the song and
--     the cut start together (lip sync cuts the song by the shot's place in the cut).
create or replace function studio.shots_from_song(p_song uuid, p_singer uuid, p_max integer default 10, p_camera text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare a studio.audio_jobs; v_series uuid; v_name text; sec jsonb; v_want numeric; v_n int; v_per int; k int; v_s int;
        v_done numeric := 0; v_carry numeric := 0; v_used numeric; v_lines jsonb; v_label text; v_act text; v_id uuid;
        v_out jsonb := '[]'::jsonb; v_cam text; v_max int;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into a from studio.audio_jobs where id = p_song and owner = auth.uid();
  if a.id is null or a.kind <> 'music' or a.status <> 'done' or coalesce(a.input->>'lyrics', '') = '' then
    raise exception 'pick a finished song (make_song) first'; end if;
  if jsonb_array_length(coalesce(a.meta->'sections', '[]'::jsonb)) = 0 then
    raise exception 'this song has no sections to follow (it was made before songs kept them); make it again'; end if;
  select sc.series_id into v_series from studio.scenes sc where sc.id = a.scene_id;
  select name into v_name from studio.characters where id = p_singer and series_id = v_series;
  if v_name is null then raise exception 'the singer must be a character of this project'; end if;
  if exists (select 1 from studio.shots where scene_id = a.scene_id) then
    raise exception 'this scene already has shots; plan the song on a new scene so the song and the cut start together'; end if;
  v_max := least(10, greatest(5, coalesce(p_max, 10)));
  v_cam := coalesce(nullif(left(trim(coalesce(p_camera, '')), 200), ''), 'medium close-up, facing the camera');
  for sec in select value from jsonb_array_elements(a.meta->'sections') loop
    v_want := (sec->>'seconds')::numeric + v_carry;
    v_n := greatest(1, ceil(v_want / v_max)::int);
    v_per := ceil(jsonb_array_length(coalesce(sec->'lines', '[]'::jsonb))::numeric / v_n)::int;
    v_used := 0;
    for k in 0 .. v_n - 1 loop
      v_s := least(v_max, greatest(5, (round(v_done + v_want * (k + 1) / v_n) - round(v_done + v_want * k / v_n))::int));
      select coalesce(jsonb_agg(value), '[]'::jsonb) into v_lines from (
        select value from jsonb_array_elements(coalesce(sec->'lines', '[]'::jsonb)) with ordinality t(value, i)
         where i > k * v_per and i <= (k + 1) * v_per) x;
      v_label := lower(sec->>'label');
      v_act := case when jsonb_array_length(v_lines) > 0
        then format('%s sings, mouth moving with the words, the %s of the song: "%s"', v_name, v_label,
                    left((select string_agg(value #>> '{}', ' / ') from jsonb_array_elements(v_lines)), 400))
        else format('%s moves to the music during the %s, not singing', v_name, v_label) end;
      v_id := studio.create_shot(a.scene_id, v_act, v_cam, v_s);
      perform studio.set_shot_cast(v_id, array[p_singer]);
      v_out := v_out || jsonb_build_object('shot_id', v_id, 'section', sec->>'label', 'seconds', v_s);
      v_used := v_used + v_s;
    end loop;
    v_carry := v_want - v_used; v_done := v_done + v_used;
    if jsonb_array_length(v_out) > 40 then raise exception 'that would be more than 40 shots; make a shorter song'; end if;
  end loop;
  return jsonb_build_object('shots', v_out, 'seconds', v_done, 'song_s', a.duration_s, 'timing', a.meta->>'timing');
end $$;
revoke all on function studio.shots_from_song(uuid, uuid, integer, text) from public, anon;
grant execute on function studio.shots_from_song(uuid, uuid, integer, text) to authenticated;
