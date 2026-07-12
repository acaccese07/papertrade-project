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

-- ---------- 24/7 bot execution ----------
-- Schedules supabase/functions/bot-tick to run every 2 minutes via pg_cron,
-- so bots keep trading for signed-in accounts even with the app fully
-- closed. The function itself decides who has an active bot; this just
-- wakes it up on a schedule. The bearer token below is the public
-- anon/publishable key (safe to embed, same one already in index.html) --
-- it only needs to satisfy the function's own gateway auth check, since the
-- function internally uses the service-role key for actual database access.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule('bot-tick');
exception when others then null;
end $$;

select cron.schedule(
  'bot-tick',
  '*/2 * * * *',
  $$
  select net.http_post(
    url:='https://iskyoiimykxqtygqxwwb.supabase.co/functions/v1/bot-tick',
    headers:='{"Content-Type":"application/json","Authorization":"Bearer sb_publishable_KXQRhXlM058xNHP1G2YFNw_s7VC-Lr0"}'::jsonb,
    body:='{}'::jsonb
  );
  $$
);

-- ---------- Price alerts (push notifications) ----------
-- push_subscriptions holds each device's Web Push subscription (one signed-in
-- user can have several -- one per browser/device they've enabled alerts on).
-- price_alerts holds "notify me when X crosses $Y" requests. Both are
-- strictly private (RLS: only the owner can read/write their own rows) --
-- the bot-tick function checks/fires these using the service-role key, which
-- bypasses RLS entirely, same as it already does for bots.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "manage own subscriptions" on public.push_subscriptions;
create policy "manage own subscriptions" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_id text not null,
  asset_type text not null check (asset_type in ('crypto','stock')),
  gecko_id text,
  direction text not null check (direction in ('above','below')),
  target numeric not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  triggered_at timestamptz
);
alter table public.price_alerts enable row level security;
drop policy if exists "manage own alerts" on public.price_alerts;
create policy "manage own alerts" on public.price_alerts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
