-- PaperTrade cloud sync schema.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste this -> Run.
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

create policy "select own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = id);
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
