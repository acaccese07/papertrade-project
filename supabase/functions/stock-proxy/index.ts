// Proxies Finnhub stock quote/search requests using a server-side secret key,
// so visitors never need their own API key. The key never reaches the browser.
//
// Deploy once with the Supabase CLI (see README.md for the full walkthrough):
//   supabase functions deploy stock-proxy
//   supabase secrets set FINNHUB_KEY=your_key_here
//
// Called from the app via supabase-js: sb.functions.invoke("stock-proxy", {body:{type,q}})

const FINNHUB_KEY = Deno.env.get("FINNHUB_KEY") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Small in-memory cache shared across warm invocations of this function
// instance -- keeps many concurrent visitors from each re-hitting Finnhub
// for the same symbol within the same few seconds.
const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 5000;
const LOGO_TTL_MS = 24 * 60 * 60 * 1000; // logos don't change; cache a full day
const NEWS_TTL_MS = 10 * 60 * 1000; // headlines: 10 minutes is plenty fresh

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (!FINNHUB_KEY) {
    return new Response(JSON.stringify({ error: "FINNHUB_KEY secret not configured" }), {
      status: 500,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  let payload: { type?: string; q?: string } = {};
  try {
    payload = await req.json();
  } catch (_e) {
    // ignore -- validated below
  }
  const { type, q } = payload;
  if (!q || (type !== "quote" && type !== "search" && type !== "logo" && type !== "news")) {
    return new Response(JSON.stringify({ error: "expected {type:'quote'|'search'|'logo'|'news', q:'SYMBOL'}" }), {
      status: 400,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const ttl = type === "logo" ? LOGO_TTL_MS : type === "news" ? NEWS_TTL_MS : TTL_MS;
  const cacheKey = `${type}:${q}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) {
    return new Response(JSON.stringify(hit.body), { headers: { ...CORS, "content-type": "application/json" } });
  }

  const day = (offset: number) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
  const upstream = type === "quote"
    ? `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`
    : type === "search"
    ? `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`
    : type === "news"
    ? `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(q)}&from=${day(7)}&to=${day(0)}&token=${FINNHUB_KEY}`
    : `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`;

  try {
    const r = await fetch(upstream);
    const raw = await r.json();
    const body = type === "logo" ? { logo: raw?.logo || null }
      : type === "news" ? { items: (Array.isArray(raw) ? raw : []).slice(0, 5).map((n: any) => ({
          headline: n.headline, source: n.source, datetime: n.datetime, url: n.url })) }
      : raw;
    cache.set(cacheKey, { at: Date.now(), body });
    return new Response(JSON.stringify(body), { headers: { ...CORS, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
