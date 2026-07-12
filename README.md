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

## Notes for whoever picks this up in Claude Code
- Live crypto prices: CoinGecko public API, no key needed.
- Live stock prices: requires a free Finnhub API key, entered in-app under Settings.
- Data persists via `window.storage` (Claude artifact storage) with a `localStorage` fallback — check the `store` object near the top of the script if porting off the artifacts platform.
- Everything currently lives in one `<script>` tag in index.html; a good first task is splitting it into modules (prices, bots, orders, ui) behind a bundler, while keeping `node test.js` green throughout.
