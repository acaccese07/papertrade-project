-- PaperTrade cloud sync schema.
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste this -> Run.
-- Safe to re-run any time -- every statement is idempotent.
--
-- Scope: one row per signed-in account, holding the entire app state (holdings,
-- trades, orders, bots, achievements, equity history, etc.) as a single JSONB
-- blob -- the same shape the app already keeps in localStorage. This keeps the
-- sync layer simple: signing in on a second device pulls this row down, and
-- every local save pushes it back up.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Trader',
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

-- ---------- Leaderboard ----------
-- Adds an opt-in public leaderboard. The client computes its own return %
-- (it already has to, for live prices) and pushes it alongside the private
-- state blob. leaderboard_public is a VIEW exposing only the columns safe to
-- share (no holdings, trades, email, etc), and only for rows where the user
-- has opted in -- readable by anyone, signed in or not, since a leaderboard
-- needs to be visible before you've necessarily signed in yourself.

alter table public.profiles add column if not exists leaderboard_opt_in boolean not null default false;
alter table public.profiles add column if not exists leaderboard_return_pct numeric;
alter table public.profiles add column if not exists leaderboard_value numeric;

create or replace view public.leaderboard_public as
  select id, display_name, leaderboard_return_pct, leaderboard_value, updated_at
  from public.profiles
  where leaderboard_opt_in = true
  order by leaderboard_return_pct desc nulls last
  limit 100;

grant select on public.leaderboard_public to anon, authenticated;
