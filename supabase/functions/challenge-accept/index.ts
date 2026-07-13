// Accepts a head-to-head challenge. Runs server-side because accepting
// writes the opponent's half onto the challenger's row -- a cross-user write
// RLS would never allow from the acceptor's own session (same pattern as
// apply-referral). Baselines both sides' leaderboard_return_pct at accept
// time; the bot-tick cron resolves the winner once ends_at passes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DURATION_DAYS = 7;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let body: { challenge_id?: string; opponent_id?: string; opponent_name?: string } = {};
  try { body = await req.json(); } catch (_e) { /* validated below */ }
  const { challenge_id, opponent_id, opponent_name } = body;
  if (!challenge_id || !opponent_id) return json({ error: "invalid request" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: ch } = await admin.from("challenges").select("*").eq("id", challenge_id).maybeSingle();
  if (!ch) return json({ error: "challenge not found" }, 404);
  if (ch.status !== "open") return json({ error: "challenge already accepted" }, 409);
  if (ch.challenger === opponent_id) return json({ error: "can't accept your own challenge" }, 400);

  const { data: profs } = await admin.from("profiles")
    .select("id, leaderboard_return_pct").in("id", [ch.challenger, opponent_id]);
  const pct = (id: string) => (profs ?? []).find((p) => p.id === id)?.leaderboard_return_pct ?? 0;

  await admin.from("challenges").update({
    opponent: opponent_id,
    opponent_name: (opponent_name || "Trader").slice(0, 20),
    challenger_start_pct: pct(ch.challenger),
    opponent_start_pct: pct(opponent_id),
    status: "active",
    ends_at: new Date(Date.now() + DURATION_DAYS * 86400_000).toISOString(),
  }).eq("id", challenge_id);

  return json({ ok: true, ends_in_days: DURATION_DAYS });
});
