-- agent1102 database tables (everything except long-term memory, which lives in memory.sql).
--
-- IMPORTANT: this file was written by reading what server.js saves and loads. It was NOT exported from your live
-- Supabase project, so compare it with your Table Editor before relying on it. It is safe to run on a project that
-- already has these tables: "create table if not exists" leaves existing tables alone, "add column if not exists"
-- only fills in missing columns, and turning on Row Level Security does not affect the server (see below).
--
-- Run it in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Storage buckets are not in SQL: the server creates the public "chat-uploads" bucket by itself, and the
-- "avatars" bucket (public) holds profile pictures.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  email       text,
  phone       text,
  avatar_url  text,
  updated_at  timestamptz not null default now()
);
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------- saved chats
-- The page makes a chat's id from the clock (a number of milliseconds), so two people could in theory pick the same
-- id. The primary key is (user_id, id) so that never matters: each person's chats are their own. (The server also
-- refuses to save over a chat id that belongs to someone else.)
create table if not exists public.chats (
  id          text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  username    text,
  email       text,
  phone       text,
  title       text,
  history     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);
-- for projects whose chats table was made before these columns existed (what chats.sql was meant to do)
alter table public.chats add column if not exists username text;
alter table public.chats add column if not exists email text;
alter table public.chats add column if not exists phone text;
alter table public.chats add column if not exists updated_at timestamptz not null default now();
create index if not exists chats_user_created_idx on public.chats (user_id, created_at desc);

-- OPTIONAL, only if your existing chats table has "id" alone as its primary key (check in the Table Editor):
-- this makes it match the table above. Not needed for safety, because the server now checks chat ownership.
--   alter table public.chats drop constraint chats_pkey;
--   alter table public.chats add primary key (user_id, id);

-- ---------------------------------------------------------------- game high scores (one row per person)
create table if not exists public.trex_highscores (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text,
  high_score  integer not null default 0 check (high_score >= 0),
  updated_at  timestamptz not null default now()
);
create table if not exists public.pacman_highscores (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text,
  high_score  integer not null default 0 check (high_score >= 0),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- locking the tables to the server
-- Row Level Security ON with NO policies = nobody can read or write these tables from a browser or with the public
-- (anon) key. Only the server can, because it uses the service_role key, which bypasses RLS, and it always filters
-- by the verified user. Nothing in the web page talks to Supabase directly, so nothing is lost by this.
-- Without it, anyone holding your project's public key could read or change every table through Supabase's API.
alter table public.profiles          enable row level security;
alter table public.chats             enable row level security;
alter table public.trex_highscores   enable row level security;
alter table public.pacman_highscores enable row level security;
