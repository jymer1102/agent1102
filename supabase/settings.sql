-- Per-person AI settings for agent1102: the written preferences from Settings -> AI, and the person's own Groq API key.
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- (Until you do, the chat keeps working normally with the shared key; the Settings -> AI page just says saving isn't set up yet.)

create table if not exists public.user_settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  talk_style      text not null default '' check (char_length(talk_style) <= 1500),  -- "how should the AI talk to me"
  about_me        text not null default '' check (char_length(about_me) <= 1500),    -- "what should the AI know about me"
  groq_key_enc    text,                                                              -- the person's own Groq key, ENCRYPTED by the server (never stored in plain text)
  groq_key_last4  text,                                                              -- last 4 characters, so the page can show which key is in use
  updated_at      timestamptz not null default now()
);

-- Row Level Security ON with NO policies = nobody can read or write this table from a browser.
-- Only the server (service_role key, always filtering by the verified user id) can touch it.
alter table public.user_settings enable row level security;
