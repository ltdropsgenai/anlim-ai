-- Ad template (2026-11-27, Londi: "Ok, build #1 first" of the UGC ad feature; tracker claude/anlim-build-tracker.md). @anlim
-- The creator describes a product (and may give its web page): Claude writes three short ad scripts (worker ad.js ->
-- checker /ad_script, frame_check/ad_script.py), each a hook, a demo and a call to action laid out as shots with the
-- picture, the spoken line and any words on screen. The creator picks one and anlim makes it a project: a 9:16 (or other
-- shape) photoreal or cartoon project, a scene, one shot per beat with the spoken line kept on the shot (shots.line, used
-- by make_voiceover when no text is given), the words on screen as the shot's title effect, and each shot trimmed in the
-- cut to the beat's length (clips are made at least 5 s long). Free, like lyrics drafts; 30 drafts a day.
-- Legal (FTC 16 CFR 465, 2024): scripts are written for a presenter or a demo, never as an invented customer's review;
-- they claim only what the creator gave; the content check (moderate.py, Job: ad) blocks fake testimonials, fake
-- endorsements by real people and banned products. The product page is fetched by the checker with private and internal
-- addresses refused (ad_script.safe_fetch).

alter table studio.shots add column if not exists line text;

alter table studio.moderation_log drop constraint if exists moderation_log_kind_check;
alter table studio.moderation_log add constraint moderation_log_kind_check check (kind in ('clip', 'frame', 'audio', 'song', 'replace', 'ad'));

create table if not exists studio.ad_drafts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  product text not null,
  brief text not null,
  url text,
  offer text,
  cta text,
  presenter text,
  tone text,
  language text,
  length_s integer not null default 15 check (length_s in (10, 15, 30)),
  look text not null default 'photoreal' check (look in ('photoreal', 'cartoon')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  variants jsonb,
  page_title text,
  error text,
  tries integer not null default 0,
  locked_until timestamptz,
  series_id uuid references studio.series(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ad_drafts_queue on studio.ad_drafts(status, created_at) where status in ('queued', 'running');
create index if not exists ad_drafts_owner on studio.ad_drafts(owner, created_at desc);
alter table studio.ad_drafts enable row level security;
drop policy if exists ad_drafts_own on studio.ad_drafts;
create policy ad_drafts_own on studio.ad_drafts for select to authenticated using (owner = auth.uid());
grant select on studio.ad_drafts to authenticated;

create or replace function studio.request_ad_script(p jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid; n int; v_url text; v_len int; v_look text;
  t_product text := btrim(coalesce(p->>'product', '')); t_brief text := btrim(coalesce(p->>'brief', ''));
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if length(t_product) < 2 or length(t_product) > 80 then raise exception 'name the product in 2 to 80 characters'; end if;
  if length(t_brief) < 10 or length(t_brief) > 1500 then raise exception 'say what the product is and who it is for (10 to 1,500 characters)'; end if;
  if length(coalesce(p->>'offer', '')) > 200 or length(coalesce(p->>'cta', '')) > 80 or length(coalesce(p->>'presenter', '')) > 80
     or length(coalesce(p->>'tone', '')) > 80 or length(coalesce(p->>'language', '')) > 40 then
    raise exception 'the offer is up to 200 characters; the call to action, presenter and tone up to 80; the language up to 40'; end if;
  if concat_ws(' ', t_product, t_brief, p->>'offer', p->>'cta', p->>'presenter', p->>'tone', p->>'language') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'remove the control characters from the text'; end if;
  v_url := nullif(btrim(coalesce(p->>'url', '')), '');
  if v_url is not null and (v_url !~* '^https?://[^/\s]+' or length(v_url) > 500 or v_url ~ '\s') then
    raise exception 'the web page must be an http or https address (up to 500 characters)'; end if;
  v_len := coalesce(nullif(p->>'length_s', '')::int, 15);
  if v_len not in (10, 15, 30) then raise exception 'an ad is 10, 15 or 30 seconds'; end if;
  v_look := coalesce(nullif(p->>'look', ''), 'photoreal');
  if v_look not in ('photoreal', 'cartoon') then raise exception 'look must be photoreal or cartoon'; end if;
  perform pg_advisory_xact_lock(hashtext('ad:' || auth.uid()::text));
  select count(*) into n from studio.ad_drafts where owner = auth.uid() and created_at > now() - interval '24 hours';
  if n >= 30 then raise exception 'you asked for 30 ad scripts in the last 24 hours; try again later'; end if;
  insert into studio.ad_drafts(owner, product, brief, url, offer, cta, presenter, tone, language, length_s, look)
  values (auth.uid(), t_product, t_brief, v_url, nullif(btrim(coalesce(p->>'offer', '')), ''), nullif(btrim(coalesce(p->>'cta', '')), ''),
          nullif(btrim(coalesce(p->>'presenter', '')), ''), nullif(btrim(coalesce(p->>'tone', '')), ''),
          nullif(btrim(coalesce(p->>'language', '')), ''), v_len, v_look)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function studio.request_ad_script(jsonb) from public, anon;
grant execute on function studio.request_ad_script(jsonb) to authenticated;

create or replace function studio.claim_ad_drafts(p_limit integer default 2, p_lease_s integer default 240)
returns setof studio.ad_drafts language plpgsql security definer set search_path to '' as $$
begin
  return query
  update studio.ad_drafts d set status = 'running', locked_until = now() + make_interval(secs => p_lease_s), updated_at = now()
   where d.id in (select id from studio.ad_drafts where status in ('queued', 'running') and (locked_until is null or locked_until < now())
                   order by created_at limit p_limit for update skip locked)
  returning d.*;
end $$;
revoke all on function studio.claim_ad_drafts(integer, integer) from public, anon, authenticated;
grant execute on function studio.claim_ad_drafts(integer, integer) to studio_worker;
grant select, update on studio.ad_drafts to studio_worker;
drop policy if exists worker_all_ad_drafts on studio.ad_drafts;
create policy worker_all_ad_drafts on studio.ad_drafts for all to studio_worker using (true) with check (true);

-- The chosen script as a project. p_series: an existing project of the creator's (its look and shape are kept; a new
-- scene is added), or null for a new project named "Ad: <product>" in the given shape. Returns the project, the scene
-- and the shots.
create or replace function studio.apply_ad_draft(p_draft uuid, p_variant int, p_series uuid default null, p_aspect text default '9:16')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare d studio.ad_drafts; v jsonb; s jsonb; v_series uuid := p_series; v_scene uuid; v_shot uuid; v_shots jsonb := '[]'::jsonb;
        v_secs numeric; v_len int; v_text text; v_name text; k int := 0;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into d from studio.ad_drafts where id = p_draft and owner = auth.uid();
  if not found then raise exception 'ad script not found'; end if;
  if d.status <> 'done' or jsonb_typeof(d.variants) <> 'array' then raise exception 'the ad script is not ready yet'; end if;
  if p_variant is null or p_variant < 1 or p_variant > jsonb_array_length(d.variants) then
    raise exception 'pick script 1 to %', jsonb_array_length(d.variants); end if;
  v := d.variants -> (p_variant - 1);
  if jsonb_typeof(v->'shots') <> 'array' or jsonb_array_length(v->'shots') = 0 then raise exception 'this script has no shots'; end if;
  if p_aspect not in ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9') then raise exception 'unknown shape %', p_aspect; end if;
  if v_series is null then
    v_name := left('Ad: ' || d.product, 200);
    v_series := studio.create_series(v_name, null, d.look);
    update studio.series set aspect = p_aspect where id = v_series;
  else
    select name into v_name from studio.series where id = v_series and owner = auth.uid();
    if v_name is null then raise exception 'project not found'; end if;
  end if;
  v_scene := studio.create_scene(v_series, left(coalesce(nullif(v->>'angle', ''), 'Ad'), 120));
  for s in select value from jsonb_array_elements(v->'shots') loop
    k := k + 1;
    exit when k > 8;
    v_secs := least(30, greatest(1, coalesce(nullif(s->>'seconds', '')::numeric, 3)));
    v_len := greatest(5, ceil(v_secs)::int);
    v_shot := studio.create_shot(v_scene, left(coalesce(nullif(btrim(s->>'picture'), ''), 'The product on a clean background'), 2000),
                                 nullif(left(coalesce(s->>'camera', ''), 200), ''), v_len);
    v_text := nullif(btrim(regexp_replace(coalesce(s->>'on_screen', ''), '[[:cntrl:]]+', ' ', 'g')), '');
    update studio.shots
       set line = nullif(left(btrim(regexp_replace(coalesce(s->>'line', ''), '[[:cntrl:]]+', ' ', 'g')), 600), ''),
           -- the cut plays the beat's length: the rest of the clip is trimmed off its end (at least 1 s is always kept)
           trim_end_s = round(greatest(0, v_len - v_secs), 2),
           fx = case when v_text is null then '{}'::jsonb
                     else jsonb_build_object('title', jsonb_build_object('text', left(v_text, 40), 'at_s', 0.2,
                            'dur_s', least(v_secs, 3.0), 'color', 'yellow', 'y', 0.3)) end
     where id = v_shot;
    v_shots := v_shots || jsonb_build_object('shot_id', v_shot, 'seconds', v_secs);
  end loop;
  update studio.ad_drafts set series_id = v_series, updated_at = now() where id = p_draft;
  return jsonb_build_object('series_id', v_series, 'series_name', v_name, 'scene_id', v_scene, 'shots', v_shots);
end $$;
revoke all on function studio.apply_ad_draft(uuid, int, uuid, text) from public, anon;
grant execute on function studio.apply_ad_draft(uuid, int, uuid, text) to authenticated;
