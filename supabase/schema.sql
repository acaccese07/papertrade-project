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
-- bot leaderboard: combined return % across the user's active bots, plus a
-- human label of what they're running ("🐢 Steady Stacker + 🚀 Momentum Chaser")
alter table public.profiles add column if not exists leaderboard_bot_return_pct numeric;
alter table public.profiles add column if not exists leaderboard_bot_label text;
-- weekly recap snapshot: what the user's return % was at the last Monday
-- recap, so the next recap can report the week's delta
alter table public.profiles add column if not exists week_start_pct numeric;
alter table public.profiles add column if not exists week_start_at timestamptz;
-- bot marketplace: sanitized custom bot configs (pool/brain/risk/tp/sl only
-- -- never cash/holdings/trades), so another user can "Clone" a config
-- straight from the bot leaderboard. Only populated for custom bots.
alter table public.profiles add column if not exists leaderboard_bot_configs jsonb;
-- public profile page (?u=<id>): badge count is the only extra field it
-- needs beyond what's already exposed.
alter table public.profiles add column if not exists leaderboard_badges_count int;
-- per-notification-type opt-outs, read by bot-tick before sending each push
alter table public.profiles add column if not exists notif_prefs jsonb;
-- monthly leaderboard seasons: season_start_pct is each trader's all-time
-- return % snapshotted at the last monthly rollover (or at signup, for a
-- brand-new account, which defaults to 0 -- see the backfill below). The
-- client computes "this season" rank as leaderboard_return_pct minus this,
-- so a trader who joined mid-month isn't ranked against someone else's
-- months-old head start.
alter table public.profiles add column if not exists season_start_pct numeric;
alter table public.profiles add column if not exists season_start_at timestamptz;
alter table public.profiles add column if not exists season_label text;
update public.profiles set season_start_pct=coalesce(leaderboard_return_pct,0),
  season_start_at=now(), season_label=to_char(now(),'YYYY-MM') where season_start_pct is null;

-- drop+recreate rather than "or replace": postgres refuses to reorder/insert
-- view columns in place, and column order here isn't worth preserving
drop view if exists public.leaderboard_public;
create view public.leaderboard_public as
  select id, display_name, leaderboard_return_pct, leaderboard_value,
         leaderboard_bot_return_pct, leaderboard_bot_label, leaderboard_bot_configs,
         leaderboard_badges_count, season_start_pct, updated_at
  from public.profiles
  where leaderboard_opt_in = true
  order by leaderboard_return_pct desc nulls last
  limit 100;

grant select on public.leaderboard_public to anon, authenticated;

-- ---------- Private leagues ----------
-- Invite-code group leaderboards, separate from the public one. Unlike
-- challenges/referrals, joining doesn't need a service-role Edge Function --
-- a user can always insert their own membership row under RLS. Reading
-- *other* members' return % still does (league-leaderboard Edge Function),
-- since RLS on profiles only ever exposes your own row.
create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  creator uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.leagues enable row level security;
drop policy if exists "read any league" on public.leagues;
create policy "read any league" on public.leagues for select using (true);
drop policy if exists "create own league" on public.leagues;
create policy "create own league" on public.leagues for insert with check (auth.uid() = creator);

create table if not exists public.league_members (
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Trader',
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);
alter table public.league_members enable row level security;
drop policy if exists "read own league memberships" on public.league_members;
create policy "read own league memberships" on public.league_members
  for select using (auth.uid() = user_id or league_id in (select league_id from public.league_members where user_id = auth.uid()));
drop policy if exists "join league as self" on public.league_members;
create policy "join league as self" on public.league_members
  for insert with check (auth.uid() = user_id);
drop policy if exists "leave league as self" on public.league_members;
create policy "leave league as self" on public.league_members
  for delete using (auth.uid() = user_id);

-- ---------- Head-to-head challenges ----------
-- A challenge is "same market, 7 days, best return-delta wins". Baselines are
-- each side's leaderboard_return_pct at accept time; resolution happens in
-- the bot-tick cron once ends_at passes, comparing each side's current pct to
-- their baseline. Rows are created by the challenger directly (RLS below);
-- accepting writes the opponent's half onto someone else's row, so that goes
-- through the challenge-accept Edge Function (service role), same pattern as
-- apply-referral.

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  challenger uuid not null references auth.users(id) on delete cascade,
  challenger_name text not null default 'Trader',
  opponent uuid references auth.users(id) on delete cascade,
  opponent_name text,
  challenger_start_pct numeric,
  opponent_start_pct numeric,
  status text not null default 'open' check (status in ('open','active','done')),
  winner uuid,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.challenges enable row level security;
drop policy if exists "read own or open challenges" on public.challenges;
create policy "read own or open challenges" on public.challenges
  for select using (auth.uid() = challenger or auth.uid() = opponent or status = 'open');
drop policy if exists "create own challenges" on public.challenges;
create policy "create own challenges" on public.challenges
  for insert with check (auth.uid() = challenger);

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

-- ---------- Referrals ----------
-- referred_by is set once (never overwritten) the first time a new account
-- successfully claims a referral link, via the apply-referral Edge Function
-- (which uses the service-role key to credit the *referrer's* account --
-- something the new user's own session could never do under RLS, since RLS
-- only ever lets you write your own row).
alter table public.profiles add column if not exists referred_by uuid references auth.users(id);
