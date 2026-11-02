// Supabase Edge Function: invite-user
// Lets a signed-in MANAGER create an account for a new person and email them an invite link
// (Supabase's "Invite user" email template, pointing at APP_URL). The new profile is put in
// the manager's own region unless a region is given.
// Secrets: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (set automatically), APP_URL.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: me } = await admin.from("profiles").select("role, region, full_name").eq("id", user.id).single();
    if (me?.role !== "manager") return json({ error: "only managers can invite people" }, 403);

    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const full_name = String(body.full_name ?? "").trim();
    const role = body.role === "manager" ? "manager" : "supervisor";
    const region = body.region === "WA" || body.region === "NSW" ? body.region : me.region;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "a valid email address is required" }, 400);
    if (!full_name) return json({ error: "a name is required" }, 400);

    const redirectTo = Deno.env.get("APP_URL") || undefined;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo });
    if (error) {
      const already = /already|exists|registered/i.test(error.message);
      return json({ error: already ? `${email} already has an account — use "Send link" on their row instead.` : error.message }, already ? 409 : 500);
    }

    // The on_auth_user_created trigger has made the profile (default NSW / supervisor); set what the manager chose.
    const id = data.user?.id;
    if (id) await admin.from("profiles").update({ full_name, role, region }).eq("id", id);

    return json({ ok: true, id, email, full_name, role, region, invited_by: me.full_name ?? user.email });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
