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
stay in SIM mode (same graceful fallback as before).

## Notes for whoever picks this up in Claude Code
- Live crypto prices: CoinGecko public API, no key needed.
- Live stock prices: proxied through the `stock-proxy` Supabase Edge Function above.
- Data persists via `window.storage` (Claude artifact storage) with a `localStorage` fallback, plus optional Supabase cloud sync — check the `store` object and the "CLOUD SYNC" section near the top of the script.
- Everything currently lives in one `<script>` tag in index.html; a good first task is splitting it into modules (prices, bots, orders, ui) behind a bundler, while keeping `node test.js` green throughout.
