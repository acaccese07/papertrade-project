// Credits a referrer's account when someone they invited signs in for the
// first time via a ?ref=<their-user-id> link. Runs server-side because
// crediting a *different* user's account is something the new user's own
// session could never do under RLS -- only the service-role key can.
//
// Fake-money stakes are low here on purpose: this is a practice-trading app,
// so the anti-abuse bar is "can't be spammed pointlessly", not "airtight".
// referred_by is set once and never overwritten, which is the actual guard
// against someone re-triggering the same referral repeatedly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BONUS = 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let body: { referrer_id?: string; new_user_id?: string } = {};
  try { body = await req.json(); } catch (_e) { /* validated below */ }
  const { referrer_id, new_user_id } = body;
  if (!referrer_id || !new_user_id || referrer_id === new_user_id) {
    return new Response(JSON.stringify({ error: "invalid request" }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: newRow } = await admin.from("profiles").select("referred_by").eq("id", new_user_id).maybeSingle();
  if (!newRow) {
    return new Response(JSON.stringify({ error: "new user not found" }), {
      status: 404, headers: { ...CORS, "content-type": "application/json" },
    });
  }
  if (newRow.referred_by) {
    return new Response(JSON.stringify({ ok: true, already: true }), {
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const { data: refRow } = await admin.from("profiles").select("state").eq("id", referrer_id).maybeSingle();
  if (!refRow) {
    return new Response(JSON.stringify({ error: "referrer not found" }), {
      status: 404, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  // bump start/youBase along with cash so the bonus reads as a deposit, not
  // a fabricated investment gain in the referrer's all-time return %
  const state = (refRow.state as any) || {};
  state.cash = (state.cash || 0) + BONUS;
  state.start = (state.start || 0) + BONUS;
  state.youBase = (state.youBase || 0) + BONUS;
  await admin.from("profiles").update({ state }).eq("id", referrer_id);
  await admin.from("profiles").update({ referred_by: referrer_id }).eq("id", new_user_id);

  return new Response(JSON.stringify({ ok: true, bonus: BONUS }), {
    headers: { ...CORS, "content-type": "application/json" },
  });
});
