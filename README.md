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

## Notes for whoever picks this up in Claude Code
- Live crypto prices: CoinGecko public API, no key needed.
- Live stock prices: requires a free Finnhub API key, entered in-app under Settings.
- Data persists via `window.storage` (Claude artifact storage) with a `localStorage` fallback — check the `store` object near the top of the script if porting off the artifacts platform.
- Everything currently lives in one `<script>` tag in index.html; a good first task is splitting it into modules (prices, bots, orders, ui) behind a bundler, while keeping `node test.js` green throughout.
