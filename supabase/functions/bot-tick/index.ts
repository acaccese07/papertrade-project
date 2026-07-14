// Runs the trading-bot decision logic server-side so bots keep trading even
// when nobody has the app open. Triggered on a schedule by pg_cron (see
// supabase/schema.sql) hitting this function every 2 minutes.
//
// This is a faithful-in-spirit port of the client's botThink()/botBuy()/
// botSell() in index.html, with one honest simplification: the client uses a
// short rolling in-memory price history (for SMA/momentum). This function
// has no persistent tick history of its own, so "dip" and "momentum"
// strategies use 24h % change (which Finnhub and CoinGecko already return
// directly) as a stand-in for "below/above recent average". Same idea,
// coarser signal.
//
// Also simplified: trade cooldowns (each strategy's "every" field, 20-45s)
// are shorter than this function's 2-minute cron interval, so in practice a
// bot here trades roughly once per cron tick rather than on its configured
// cadence -- background trading is intentionally slower-paced than the
// live in-app version, not identical to it.
//
// Deploy: supabase functions deploy bot-tick
// Needs no extra secrets beyond FINNHUB_KEY (shared with stock-proxy) --
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FINNHUB_KEY = Deno.env.get("FINNHUB_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:admin@papertrade.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const GECKO_ID: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", ADA: "cardano",
  DOGE: "dogecoin", SHIB: "shiba-inu", PEPE: "pepe", BONK: "bonk", WIF: "dogwifhat",
};

type Strat = { pool: string[]; risk: number; tp: number | null; sl: number | null; every: number };
const BOT_STRATS: Record<"crypto" | "stock", Record<string, Strat>> = {
  crypto: {
    steady: { pool: ["BTC", "ETH", "SOL"], risk: .06, tp: 10, sl: null, every: 45 },
    dip: { pool: ["BTC", "ETH", "SOL", "XRP", "ADA"], risk: .10, tp: 6, sl: -8, every: 30 },
    degen: { pool: ["DOGE", "SHIB", "PEPE", "BONK", "WIF", "SOL"], risk: .18, tp: 9, sl: -6, every: 20 },
  },
  stock: {
    steady: { pool: ["AAPL", "MSFT", "GOOGL", "RY", "TD", "BMO"], risk: .06, tp: 10, sl: null, every: 45 },
    dip: { pool: ["NVDA", "TSLA", "AMZN", "META", "SHOP", "AMD"], risk: .10, tp: 6, sl: -8, every: 30 },
    degen: { pool: ["TSLA", "PLTR", "COIN", "AMD", "SHOP", "NVDA"], risk: .16, tp: 8, sl: -6, every: 20 },
  },
};

const HOLIDAYS = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
];
function marketOpen(): boolean {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const p: Record<string, string> = {};
  f.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  const ymd = `${p.year}-${p.month}-${p.day}`, mins = (+p.hour % 24) * 60 + +p.minute;
  if (p.weekday === "Sat" || p.weekday === "Sun" || HOLIDAYS.includes(ymd)) return false;
  return mins >= 570 && mins < 960;
}

type Quote = { price: number; chg: number };
async function fetchCryptoPrices(ids: string[]): Promise<Record<string, Quote>> {
  const geckoIds = ids.map((id) => GECKO_ID[id]).filter(Boolean).join(",");
  if (!geckoIds) return {};
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds}&vs_currencies=usd&include_24hr_change=true`);
    const d = await r.json();
    const out: Record<string, Quote> = {};
    for (const id of ids) {
      const g = GECKO_ID[id];
      if (g && d[g]?.usd) out[id] = { price: d[g].usd, chg: d[g].usd_24h_change || 0 };
    }
    return out;
  } catch (_e) { return {}; }
}
async function fetchStockPrices(ids: string[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (!FINNHUB_KEY) return out;
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${id}&token=${FINNHUB_KEY}`);
      const d = await r.json();
      if (d.c > 0) out[id] = { price: d.c, chg: d.dp || 0 };
    } catch (_e) { /* skip this symbol */ }
  }));
  return out;
}

function pickForStrategy(stratKey: string, strat: Strat, prices: Record<string, Quote>, holdings: Record<string, { qty: number; cost: number }>) {
  if (stratKey === "steady") {
    const pool = strat.pool.map((id) => ({ id, val: holdings[id] ? holdings[id].qty * (prices[id]?.price || 0) : 0 }));
    pool.sort((a, b) => a.val - b.val);
    return { pick: pool[0].id, why: "Scheduled buy — dollar-cost averaging means investing steadily regardless of price, which smooths out timing risk over time." };
  }
  if (stratKey === "dip") {
    let best: string | null = null, bestGap = 1.5;
    for (const id of strat.pool) {
      const q = prices[id]; if (!q) continue;
      const gap = -q.chg;
      if (gap > bestGap) { bestGap = gap; best = id; }
    }
    return best ? { pick: best, why: `${best} is down ${bestGap.toFixed(2)}% over 24h — a classic mean-reversion setup: buy weakness, sell the bounce.` } : { pick: null, why: "" };
  }
  let best: string | null = null, bestMom = 1;
  for (const id of strat.pool) {
    const q = prices[id]; if (!q) continue;
    if (q.chg > bestMom) { bestMom = q.chg; best = id; }
  }
  return best ? { pick: best, why: `${best} has the strongest 24h momentum (+${bestMom.toFixed(2)}%). Momentum traders bet that what's moving keeps moving — until it doesn't.` } : { pick: null, why: "" };
}

// Custom (user-built) strategies arrive as untrusted JSON inside the state
// blob -- clamp everything to sane ranges rather than trusting the client.
function sanitizeCustom(c: any): (Strat & { brain: string }) | null {
  if (!c || !Array.isArray(c.pool) || !c.pool.length) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    brain: ["steady", "dip", "degen"].includes(c.brain) ? c.brain : "steady",
    pool: c.pool.filter((x: unknown) => typeof x === "string").slice(0, 10),
    risk: clamp(+c.risk || .08, .01, .3),
    tp: c.tp ? clamp(+c.tp, 3, 50) : null,
    sl: c.sl ? clamp(+c.sl, -20, -3) : null,
    every: clamp(+c.every || 30, 20, 3600),
  };
}

function buy(bot: any, state: any, k: string, id: string, val: number, why: string, price: number) {
  if (val > bot.cash) val = bot.cash;
  if (val < 1) return;
  const qty = val / price;
  bot.cash -= val;
  const h = bot.holdings[id] || (bot.holdings[id] = { qty: 0, cost: 0 });
  h.qty += qty; h.cost += val;
  bot.log = bot.log || [];
  bot.log.unshift({ t: Date.now(), side: "buy", id, val, why });
  if (bot.log.length > 120) bot.log.pop();
  state.trades = state.trades || [];
  state.trades.unshift({ t: Date.now(), side: "buy", id, qty, price, val, who: "bot-" + k });
  if (state.trades.length > 300) state.trades.pop();
}
function sell(bot: any, state: any, k: string, id: string, portion: number, why: string, price: number) {
  const h = bot.holdings[id]; if (!h) return;
  const qty = h.qty * portion, val = qty * price;
  h.cost -= h.cost * portion; h.qty -= qty; bot.cash += val;
  if (h.qty < 1e-9) delete bot.holdings[id];
  bot.log = bot.log || [];
  bot.log.unshift({ t: Date.now(), side: "sell", id, val, why });
  if (bot.log.length > 120) bot.log.pop();
  state.trades = state.trades || [];
  state.trades.unshift({ t: Date.now(), side: "sell", id, qty, price, val, who: "bot-" + k });
  if (state.trades.length > 300) state.trades.pop();
}

Deno.serve(async (_req) => {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: rows, error } = await admin.from("profiles").select("id, state");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  // preset pools plus whatever symbols users' custom bots reference; custom
  // crypto bots carry their own symbol->coingecko-id map (geckoMap) since the
  // server's static GECKO_ID only covers the preset pools
  const cryptoIds = new Set(Object.values(BOT_STRATS.crypto).flatMap((s) => s.pool));
  const stockIds = new Set(Object.values(BOT_STRATS.stock).flatMap((s) => s.pool));
  for (const row of rows ?? []) {
    const bots = (row.state as any)?.bots;
    for (const k of ["crypto", "stock"] as const) {
      const bot = bots?.[k];
      if (!bot?.active || bot.strategy !== "custom" || !Array.isArray(bot.custom?.pool)) continue;
      for (const id of bot.custom.pool.slice(0, 10)) {
        if (typeof id !== "string") continue;
        (k === "crypto" ? cryptoIds : stockIds).add(id);
        const g = bot.custom.geckoMap?.[id];
        if (k === "crypto" && typeof g === "string") GECKO_ID[id] = g;
      }
    }
  }
  const isOpen = marketOpen();
  const [cryptoPrices, stockPrices] = await Promise.all([
    fetchCryptoPrices([...cryptoIds]),
    isOpen ? fetchStockPrices([...stockIds]) : Promise.resolve({}),
  ]);

  let processed = 0;
  for (const row of rows ?? []) {
    const state = row.state as any;
    if (!state?.bots) continue;
    let changed = false;

    for (const k of ["crypto", "stock"] as const) {
      const bot = state.bots[k];
      if (!bot?.active) continue;
      if (k === "stock" && !isOpen) continue;
      const strat = bot.strategy === "custom" ? sanitizeCustom(bot.custom) : BOT_STRATS[k][bot.strategy];
      if (!strat) continue;
      const brain = bot.strategy === "custom" ? (strat as any).brain : bot.strategy;
      const prices = k === "crypto" ? cryptoPrices : stockPrices;
      bot.lastCheck = Date.now();
      changed = true; // persist the heartbeat even on ticks with no trade

      for (const id of Object.keys({ ...bot.holdings })) {
        const h = bot.holdings[id], q = prices[id];
        if (!q) continue;
        const plp = (q.price * h.qty - h.cost) / h.cost * 100;
        if (strat.tp && plp >= strat.tp) {
          sell(bot, state, k, id, 1, `Hit the +${strat.tp}% profit target (${plp.toFixed(1)}%). Locking in the win — profits aren't real until you take them.`, q.price);
          changed = true;
        } else if (strat.sl && plp <= strat.sl) {
          sell(bot, state, k, id, 1, `Stop-loss triggered at ${plp.toFixed(1)}%. Cutting losers early keeps small losses from becoming big ones.`, q.price);
          changed = true;
        }
      }

      const now = Date.now();
      if (now - (bot.lastAct || 0) < strat.every * 1000) continue;
      const botVal = bot.cash + Object.entries(bot.holdings || {}).reduce((s, [id, h]: [string, any]) => s + h.qty * (prices[id]?.price || 0), 0);
      const budget = Math.min(bot.cash, botVal * strat.risk);
      if (budget < 5) continue;
      const { pick, why } = pickForStrategy(brain, strat, prices, bot.holdings || {});
      if (!pick || !prices[pick]) continue;
      bot.lastAct = now;
      buy(bot, state, k, pick, budget, why, prices[pick].price);
      changed = true;
    }

    if (changed) {
      await admin.from("profiles").update({ state }).eq("id", row.id);
      processed++;
    }
  }

  const alertsFired = await checkPriceAlerts(admin, cryptoPrices, stockPrices, isOpen);
  const challengesResolved = await resolveChallenges(admin);
  const recapsSent = await weeklyRecap(admin);

  return new Response(JSON.stringify({ ok: true, accounts: (rows ?? []).length, processed, alertsFired, challengesResolved, recapsSent }), {
    headers: { "content-type": "application/json" },
  });
});

// Sends one push payload to every device a user has registered, pruning
// subscriptions the push service reports as dead (404/410).
// Reads the user's per-notification-type opt-out (set in Settings, synced
// via pushCloud's notif_prefs field). Missing/null means "not set yet" ->
// default to allowed, so existing users don't silently stop getting pushes.
async function notifAllowed(admin: ReturnType<typeof createClient>, userId: string, key: string): Promise<boolean> {
  const { data } = await admin.from("profiles").select("notif_prefs").eq("id", userId).maybeSingle();
  const prefs = (data?.notif_prefs as any) || {};
  return prefs[key] !== false;
}

async function sendPushTo(admin: ReturnType<typeof createClient>, userId: string, title: string, body: string, notifKey?: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (notifKey && !(await notifAllowed(admin, userId, notifKey))) return;
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", userId);
  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, url: "/" }),
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", sub.id);
      }
    }
  }
}

// Head-to-head challenges: once ends_at passes, whoever gained the most
// return % relative to their baseline-at-accept wins. Uses the same
// leaderboard_return_pct the client already pushes on every save.
async function resolveChallenges(admin: ReturnType<typeof createClient>): Promise<number> {
  const { data: chs } = await admin.from("challenges").select("*")
    .eq("status", "active").lte("ends_at", new Date().toISOString());
  let resolved = 0;
  for (const ch of (chs ?? []) as any[]) {
    const { data: profs } = await admin.from("profiles")
      .select("id, leaderboard_return_pct").in("id", [ch.challenger, ch.opponent]);
    const pct = (id: string) => (profs ?? []).find((p: any) => p.id === id)?.leaderboard_return_pct ?? 0;
    const cDelta = pct(ch.challenger) - (ch.challenger_start_pct ?? 0);
    const oDelta = pct(ch.opponent) - (ch.opponent_start_pct ?? 0);
    const winner = cDelta === oDelta ? null : (cDelta > oDelta ? ch.challenger : ch.opponent);
    await admin.from("challenges").update({ status: "done", winner }).eq("id", ch.id);
    const line = (mine: number, theirs: number, theirName: string) =>
      mine === theirs ? `It's a tie with ${theirName} — ${mine.toFixed(2)}% each` :
      mine > theirs ? `You beat ${theirName}! ${mine.toFixed(2)}% vs ${theirs.toFixed(2)}%` :
      `${theirName} won this one — ${theirs.toFixed(2)}% vs your ${mine.toFixed(2)}%`;
    await sendPushTo(admin, ch.challenger, "🏁 Challenge over!", line(cDelta, oDelta, ch.opponent_name || "your rival"), "duels");
    await sendPushTo(admin, ch.opponent, "🏁 Challenge over!", line(oDelta, cDelta, ch.challenger_name || "your rival"), "duels");
    resolved++;
  }
  return resolved;
}

// Monday 9:00 AM ET recap: report each user's week-over-week return delta,
// then roll the snapshot forward. The */2 cron only lands in the 9:00-9:01
// window once, so this fires at most once per week.
async function weeklyRecap(admin: ReturnType<typeof createClient>): Promise<number> {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  f.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  if (p.weekday !== "Mon" || +p.hour !== 9 || +p.minute >= 2) return 0;

  const { data: rows } = await admin.from("profiles").select("id, leaderboard_return_pct, week_start_pct");
  let sent = 0;
  for (const row of (rows ?? []) as any[]) {
    const nowPct = row.leaderboard_return_pct ?? 0;
    if (row.week_start_pct !== null && row.week_start_pct !== undefined) {
      const delta = nowPct - row.week_start_pct;
      await sendPushTo(admin, row.id, "📈 Your week on PaperTrade",
        `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% this week. ${delta >= 0 ? "Keep it rolling!" : "New week, fresh start."}`, "recap");
      sent++;
    }
    await admin.from("profiles").update({ week_start_pct: nowPct, week_start_at: new Date().toISOString() }).eq("id", row.id);
  }
  return sent;
}

async function checkPriceAlerts(
  admin: ReturnType<typeof createClient>,
  cryptoPrices: Record<string, Quote>,
  stockPrices: Record<string, Quote>,
  isOpen: boolean,
): Promise<number> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return 0;
  const { data: alerts } = await admin.from("price_alerts").select("*").eq("active", true);
  if (!alerts || !alerts.length) return 0;

  // fetch prices for any alerted assets not already covered by the bot pools
  const missingCrypto = [...new Set(alerts.filter((al: any) => al.asset_type === "crypto" && !cryptoPrices[al.asset_id]).map((al: any) => al.asset_id))];
  const missingStock = [...new Set(alerts.filter((al: any) => al.asset_type === "stock" && !stockPrices[al.asset_id]).map((al: any) => al.asset_id))];
  const [extraCrypto, extraStock] = await Promise.all([
    missingCrypto.length ? fetchCryptoPrices(missingCrypto as string[]) : Promise.resolve({}),
    isOpen && missingStock.length ? fetchStockPrices(missingStock as string[]) : Promise.resolve({}),
  ]);
  const allCrypto = { ...cryptoPrices, ...extraCrypto };
  const allStock = { ...stockPrices, ...extraStock };

  let fired = 0;
  for (const al of alerts as any[]) {
    const q = al.asset_type === "crypto" ? allCrypto[al.asset_id] : allStock[al.asset_id];
    if (!q) continue;
    const hit = al.direction === "above" ? q.price >= al.target : q.price <= al.target;
    if (!hit) continue;

    await sendPushTo(admin, al.user_id, `${al.asset_id} is ${al.direction} ${al.target}`,
      `Now at $${q.price.toLocaleString()} — tap to open PaperTrade`, "alerts");
    await admin.from("price_alerts").update({ active: false, triggered_at: new Date().toISOString() }).eq("id", al.id);
    fired++;
  }
  return fired;
}
