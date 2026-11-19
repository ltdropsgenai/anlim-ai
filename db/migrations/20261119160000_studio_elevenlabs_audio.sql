-- ElevenLabs: creators connect their own account and add voiceover, sound effects and a generated score to a scene
-- cut (2026-11-19, Londi: "users can connect these accounts if they have them"; "give the user the option of having
-- the app generate a score or they can import one themselves"). @anlim
-- The creator's API key is kept in Supabase Vault (encrypted); only studio-api (to check it and list voices) and the
-- worker (to make the audio) read it. The app never gets it back, only its last four characters.
-- anlim charges no credits for this audio: it runs on the creator's own ElevenLabs plan.

create table if not exists studio.connections (
  owner      uuid not null,
  provider   text not null check (provider in ('elevenlabs')),
  secret_id  uuid not null,                                -- vault.secrets.id
  key_hint   text,                                         -- "…a1b2"
  account    jsonb,                                        -- tier, characters used / limit, next reset (when the key may read it)
  status     text not null default 'ok' check (status in ('ok', 'invalid')),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, provider)
);
alter table studio.connections enable row level security;
create policy connections_own on studio.connections for select to authenticated using (owner = (select auth.uid()));
revoke all on studio.connections from public, anon, authenticated;
grant select (owner, provider, key_hint, account, status, checked_at, created_at) on studio.connections to authenticated;

create table if not exists studio.audio_jobs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null,
  scene_id     uuid not null references studio.scenes(id) on delete cascade,
  shot_id      uuid references studio.shots(id) on delete cascade,        -- null for a scene's score
  kind         text not null check (kind in ('voiceover', 'sfx', 'music')),
  provider     text not null default 'elevenlabs',
  input        jsonb not null,                -- voiceover: text, voice_id, voice_name, model; sfx: text, duration_s; music: text, length_s, instrumental
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  in_cut       boolean not null default false, -- the one the scene cut uses (newest finished per shot and kind, or per scene for music)
  output_path  text,
  duration_s   numeric,
  meta         jsonb,                          -- provider ids, character cost
  error        text,
  tries        int not null default 0,
  locked_by    text,
  locked_until timestamptz,
  next_try_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists audio_jobs_scene_idx on studio.audio_jobs(scene_id, created_at desc);
create index if not exists audio_jobs_due_idx on studio.audio_jobs(status, next_try_at) where status in ('queued', 'running');
alter table studio.audio_jobs enable row level security;
create policy audio_jobs_own on studio.audio_jobs for select to authenticated using (owner = (select auth.uid()));
revoke all on studio.audio_jobs from public, anon;
grant select on studio.audio_jobs to authenticated;

-- A creator asks for one piece of audio. Checks ownership, the connection, sizes, and how much is already waiting.
create or replace function studio.request_audio(p_scene uuid, p_shot uuid, p_kind text, p_input jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_id uuid; v_text text; v_in jsonb; n int; v_dur numeric; v_len numeric;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_kind not in ('voiceover', 'sfx', 'music') then raise exception 'unknown kind of audio'; end if;
  if p_kind = 'music' then p_shot := null;
  elsif p_shot is null or not exists (select 1 from studio.shots where id = p_shot and scene_id = p_scene) then
    raise exception 'pick a shot of this scene';
  end if;
  if not exists (select 1 from studio.connections where owner = v_owner and provider = 'elevenlabs' and status = 'ok') then
    raise exception 'connect your ElevenLabs account first (Account > Connections)';
  end if;
  select count(*) into n from studio.audio_jobs where owner = v_owner and status in ('queued', 'running');
  if n >= 6 then raise exception 'six pieces of audio are already being made; wait for them to finish'; end if;

  v_text := trim(coalesce(p_input->>'text', ''));
  if v_text = '' then raise exception 'write what you want first'; end if;
  if p_kind = 'voiceover' then
    if length(v_text) > 3000 then raise exception 'a voiceover line can be up to 3,000 characters'; end if;
    if coalesce(p_input->>'voice_id', '') !~ '^[A-Za-z0-9]{8,40}$' then raise exception 'pick a voice'; end if;
    v_in := jsonb_build_object('text', v_text, 'voice_id', p_input->>'voice_id', 'voice_name', left(coalesce(p_input->>'voice_name', ''), 80),
                               'model', 'eleven_v3');
  elsif p_kind = 'sfx' then
    if length(v_text) > 450 then raise exception 'describe the sound in up to 450 characters'; end if;
    v_dur := nullif(p_input->>'duration_s', '')::numeric;
    if v_dur is not null and (v_dur < 0.5 or v_dur > 30) then raise exception 'a sound effect can be 0.5 to 30 seconds'; end if;
    v_in := jsonb_build_object('text', v_text, 'duration_s', v_dur);
  else
    if length(v_text) > 2000 then raise exception 'describe the score in up to 2,000 characters'; end if;
    v_len := coalesce(nullif(p_input->>'length_s', '')::numeric, 30);
    if v_len < 3 or v_len > 600 then raise exception 'a score can be 3 seconds to 10 minutes'; end if;
    v_in := jsonb_build_object('text', v_text, 'length_s', round(v_len, 1), 'instrumental', coalesce((p_input->>'instrumental')::boolean, true));
  end if;
  insert into studio.audio_jobs(owner, scene_id, shot_id, kind, input) values (v_owner, p_scene, p_shot, p_kind, v_in) returning id into v_id;
  return v_id;
end $$;
revoke all on function studio.request_audio(uuid, uuid, text, jsonb) from public, anon;
grant execute on function studio.request_audio(uuid, uuid, text, jsonb) to authenticated;

-- Pick which finished piece the cut uses (or none) for its shot and kind (scene for music).
create or replace function studio.use_audio(p_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path to '' as $$
declare j studio.audio_jobs;
begin
  select * into j from studio.audio_jobs where id = p_id and owner = auth.uid();
  if j.id is null then raise exception 'not found'; end if;
  if j.status <> 'done' then raise exception 'it is not finished yet'; end if;
  if p_on then
    update studio.audio_jobs set in_cut = false, updated_at = now()
     where scene_id = j.scene_id and kind = j.kind and shot_id is not distinct from j.shot_id and id <> j.id and in_cut;
  end if;
  update studio.audio_jobs set in_cut = p_on, updated_at = now() where id = p_id;
end $$;
revoke all on function studio.use_audio(uuid, boolean) from public, anon;
grant execute on function studio.use_audio(uuid, boolean) to authenticated;

create or replace function studio.claim_audio_jobs(p_worker text, p_limit int default 2, p_lease_s int default 600)
returns setof studio.audio_jobs language plpgsql security definer set search_path to '' as $$
begin
  return query
  update studio.audio_jobs a set locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_s),
         status = 'running', updated_at = now()
   where a.id in (select id from studio.audio_jobs
                   where status in ('queued', 'running') and (locked_until is null or locked_until < now()) and next_try_at <= now()
                   order by created_at limit p_limit for update skip locked)
  returning a.*;
end $$;
revoke all on function studio.claim_audio_jobs(text, int, int) from public, anon, authenticated;
grant execute on function studio.claim_audio_jobs(text, int, int) to studio_worker;

-- The worker reads a creator's key here (it connects as the database owner; nobody else may call this).
create or replace function studio.connection_key(p_owner uuid, p_provider text)
returns text language sql security definer set search_path to '' as $$
  select d.decrypted_secret from studio.connections c join vault.decrypted_secrets d on d.id = c.secret_id
   where c.owner = p_owner and c.provider = p_provider
$$;
revoke all on function studio.connection_key(uuid, text) from public, anon, authenticated;
grant execute on function studio.connection_key(uuid, text) to studio_worker;

-- the worker (role studio_worker) makes the audio and marks a refused key (applied as studio_audio_worker_grants)
create policy worker_all_audio_jobs on studio.audio_jobs for all to studio_worker using (true) with check (true);
grant select, update on studio.audio_jobs to studio_worker;
create policy worker_connections on studio.connections for all to studio_worker using (true) with check (true);
grant select (owner, provider, status), update (status, updated_at) on studio.connections to studio_worker;
