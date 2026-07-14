// Returns a private league's standings. Membership itself is a direct client
// insert under RLS (see schema.sql), but *reading* other members' return %
// needs the service-role key -- profiles' RLS only ever exposes your own row.
//
// Deploy: supabase functions deploy league-leaderboard
// Called via supabase-js: sb.functions.invoke("league-leaderboard", {body:{league_id,user_id}})

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let payload: { league_id?: string; user_id?: string } = {};
  try { payload = await req.json(); } catch (_e) { /* validated below */ }
  const { league_id, user_id } = payload;
  if (!league_id || !user_id) {
    return new Response(JSON.stringify({ error: "expected {league_id, user_id}" }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: membership } = await admin.from("league_members")
    .select("user_id").eq("league_id", league_id).eq("user_id", user_id).maybeSingle();
  if (!membership) {
    return new Response(JSON.stringify({ error: "not a member of this league" }), {
      status: 403, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const { data: members } = await admin.from("league_members")
    .select("user_id, display_name").eq("league_id", league_id);
  const ids = (members ?? []).map((m: any) => m.user_id);
  const { data: profs } = await admin.from("profiles")
    .select("id, leaderboard_return_pct, leaderboard_value, leaderboard_badges_count").in("id", ids);

  const rows = (members ?? []).map((m: any) => {
    const p = (profs ?? []).find((x: any) => x.id === m.user_id) || {};
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      return_pct: p.leaderboard_return_pct ?? 0,
      value: p.leaderboard_value ?? 0,
      badges: p.leaderboard_badges_count ?? 0,
    };
  }).sort((a: any, b: any) => b.return_pct - a.return_pct);

  return new Response(JSON.stringify({ rows }), { headers: { ...CORS, "content-type": "application/json" } });
});
