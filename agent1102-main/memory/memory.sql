-- Long-term memory for agent1102.
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- (Until you do, the chat keeps working normally; memory just stays switched off and the server logs a warning.)

create extension if not exists pgcrypto;

create table if not exists public.user_memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'fact' check (kind in ('fact', 'project', 'preference')),
  content     text not null check (char_length(content) between 3 and 300),
  source      text not null default 'auto' check (source in ('auto', 'user')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists user_memories_user_idx on public.user_memories (user_id, created_at);

-- Row Level Security ON with NO policies = nobody can read or write this table from a browser.
-- Only the server (which uses the service_role key and always filters by the verified user id) can touch it.
alter table public.user_memories enable row level security;
