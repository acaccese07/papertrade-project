# PaperTrade

A practice stock/crypto trading app — single-file HTML app (`index.html`) with a jsdom test suite (`test.js`, 83 checks).

## Run the tests
```
npm install jsdom
node test.js
```
Should print `RESULT: 83 passed, 0 failed` before and after any change.

## Deploy
This is a static file — GitHub Pages, Netlify, or Vercel can all host it as-is.
For GitHub Pages: push to a repo, enable Pages on the `main` branch, root folder.

## Cloud sync (Supabase)
Optional layer on top of the local profiles system — signing in with a magic
link backs the active profile up to Supabase and pulls it down on another
device. The app works fully offline if this is never configured.

Setup (one-time):
1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run `supabase/schema.sql` from this repo.
3. In Settings → API, copy the Project URL and anon/publishable key into the
   `SUPABASE_URL`/`SUPABASE_KEY` constants near the top of the main `<script>`
   in `index.html`.

These are meant to be public client-side keys (Row Level Security in
`schema.sql` scopes every row to `auth.uid()`), so it's fine that they ship in
the static HTML — never put the `service_role` key here.

### Fix magic-link emails (required for real use)
Supabase's built-in mailer has a very low rate limit (a handful of emails per
hour) — fine for the one-off test above, not reliable for real signups. Set
up free SMTP once:
1. Create a free account at [resend.com](https://resend.com) and grab an API key.
2. In Supabase: **Authentication → Emails → SMTP Settings** → enable custom SMTP.
   Host `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key.
3. Save. The default per-hour limit goes away immediately.

### Live stock prices (no per-visitor key needed)
Stock quotes are proxied through a Supabase Edge Function
(`supabase/functions/stock-proxy`) holding one shared Finnhub key server-side
— visitors never see or need their own key. To wire this up:
1. Get a free API key at [finnhub.io](https://finnhub.io).
2. Install the Supabase CLI (`brew install supabase/tap/supabase` on macOS)
   and run `supabase login` (opens a browser to authenticate).
3. From the repo root: `supabase link --project-ref iskyoiimykxqtygqxwwb`
4. Deploy the function: `supabase functions deploy stock-proxy`
5. Set the secret (never shared with Claude — run this yourself):
   `supabase secrets set FINNHUB_KEY=your_key_here`

Once deployed, stocks go live for every visitor automatically — no Settings
field, no per-user setup. If the function isn't deployed yet, stocks just
stay in SIM mode (same graceful fallback as before). The same function also
serves stock logos (`type:"logo"`); crypto logos come free from CoinGecko's
`/coins/markets` response, no extra setup needed.

### 24/7 bot execution
Bots also run server-side on a schedule (`supabase/functions/bot-tick`,
triggered every 2 minutes by pg_cron — see the bottom of `schema.sql`), so a
signed-in user's active bots keep trading even with the app fully closed.
This is a simplified port of the client's bot logic: "dip"/"momentum"
strategies use 24h % change instead of the client's short-window moving
average (the server has no persistent tick history to compute one from), and
trades happen roughly once per 2-minute cron tick rather than each
strategy's exact 20-45s cooldown. Deploy/update it the same way as
stock-proxy: `supabase functions deploy bot-tick`. The cron schedule itself
is set up by re-running `schema.sql` (idempotent, safe to re-run).

### Price alerts (push notifications)
Uses Web Push (`sw.js` + `supabase/functions/bot-tick`'s alert-checking pass,
same 2-minute cron cycle as bots) with VAPID keys. If setting this up on a
fresh project, generate a keypair with `npx web-push generate-vapid-keys`,
then `supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...` and
put the public key in the `VAPID_PUBLIC_KEY` constant in `index.html`. Only
works for signed-in cloud accounts. Known platform limit: iOS Safari only
supports Web Push for PWAs added to the home screen, not regular tabs.

### Referrals
`?ref=<user-id>` in the URL gives a new signup a $500 starting-cash bonus
immediately (purely local, no server needed), and once they sign in with a
cloud account, `supabase/functions/apply-referral` credits the referrer
$500 too (needs the service-role key to write to someone else's row, which
is exactly what that function is for). `referred_by` on `profiles` is set
once and never overwritten, which is the actual guard against re-claiming
the same link repeatedly. Deliberately low-stakes anti-abuse: this is fake
money, so "can't be spammed pointlessly" was the bar, not airtight fraud
prevention.

## Notes for whoever picks this up in Claude Code
- Live crypto prices: CoinGecko public API, no key needed.
- Live stock prices: proxied through the `stock-proxy` Supabase Edge Function above.
- Data persists via `window.storage` (Claude artifact storage) with a `localStorage` fallback, plus optional Supabase cloud sync — check the `store` object and the "CLOUD SYNC" section near the top of the script.
- Public leaderboard: opt-in, backed by the `leaderboard_public` view in `schema.sql` — exposes only display name + return %, never email or holdings.
- Everything currently lives in one `<script>` tag in index.html; a good first task is splitting it into modules (prices, bots, orders, ui) behind a bundler, while keeping `node test.js` green throughout.
