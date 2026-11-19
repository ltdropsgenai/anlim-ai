-- Security review 2026-11-19: "Connect ElevenLabs" checks a key with ElevenLabs and says whether it works (and the
-- plan and credits). Without a limit, any free account could test stolen keys in bulk. studio-api now allows 10 key
-- tries (connects and checks) per account per hour, 20 checks; attempts are recorded here (only studio-api, as the database owner, reads it).
create table if not exists studio.connection_attempts (
  id bigint generated always as identity primary key,
  owner uuid not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists connection_attempts_owner_at on studio.connection_attempts(owner, at desc);
alter table studio.connection_attempts enable row level security;
revoke all on studio.connection_attempts from public, anon, authenticated;
