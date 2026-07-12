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
  if (!q || (type !== "quote" && type !== "search")) {
    return new Response(JSON.stringify({ error: "expected {type:'quote'|'search', q:'SYMBOL'}" }), {
      status: 400,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const cacheKey = `${type}:${q}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return new Response(JSON.stringify(hit.body), { headers: { ...CORS, "content-type": "application/json" } });
  }

  const upstream = type === "quote"
    ? `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`
    : `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`;

  try {
    const r = await fetch(upstream);
    const body = await r.json();
    cache.set(cacheKey, { at: Date.now(), body });
    return new Response(JSON.stringify(body), { headers: { ...CORS, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
