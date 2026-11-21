-- Admin tools for agent1102: site-wide notifications, and a log of what admins do.
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run. It is safe to run again.
-- (Until you do, the admin panel still opens, but sending notifications says this file has not been run yet.)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- notifications to every user
-- A message shown at the top of the app to every signed-in person from starts_at until expires_at.
-- Each person can dismiss it with the x; that is remembered per account in announcement_dismissals.
create table if not exists public.announcements (
  id          uuid primary key default gen_random_uuid(),
  message     text not null check (char_length(message) between 1 and 500),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists announcements_expires_idx on public.announcements (expires_at desc);

create table if not exists public.announcement_dismissals (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  dismissed_at    timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- ---------------------------------------------------------------- what admins did
-- One row each time an admin opens someone's account or chats, asks the AI about users, suspends or unbans, or sends a notification.
create table if not exists public.admin_audit (
  id              bigint generated always as identity primary key,
  admin_id        uuid references auth.users(id) on delete set null,
  admin_email     text,
  action          text not null,
  target_user_id  uuid,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);

-- Row Level Security ON with NO policies = nobody can read or write these from a browser. Only the server (service_role key) can.
alter table public.announcements            enable row level security;
alter table public.announcement_dismissals  enable row level security;
alter table public.admin_audit              enable row level security;
