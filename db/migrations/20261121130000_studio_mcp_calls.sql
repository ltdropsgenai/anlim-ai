-- MCP server (studio-mcp, 2026-11-21): a log of calls from AI tools, used for the "create" rate limit
-- (Londi: at most 5 creates per 10 minutes per account from chat). Written and read only by the function's own
-- database connection; creators cannot see or change it. @anlim
create table if not exists studio.mcp_calls (
  id    bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  tool  text not null,
  at    timestamptz not null default now()
);
create index if not exists mcp_calls_owner_at_idx on studio.mcp_calls(owner, tool, at desc);
alter table studio.mcp_calls enable row level security;
revoke all on studio.mcp_calls from public, anon, authenticated;
