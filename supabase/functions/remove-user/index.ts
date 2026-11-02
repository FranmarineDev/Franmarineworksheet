// Supabase Edge Function: remove-user
// Lets a signed-in MANAGER delete another account in their own region. The person can no longer
// sign in; worksheets, incidents and reports they wrote are kept (their name stays in the sheet
// data — only the "created by / updated by" pointers are cleared so the delete can go through).
// Secrets: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (set automatically).

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
    const { data: me } = await admin.from("profiles").select("role, region").eq("id", user.id).single();
    if (me?.role !== "manager") return json({ error: "only managers can remove people" }, 403);

    const { user_id } = await req.json().catch(() => ({}));
    if (!user_id || typeof user_id !== "string") return json({ error: "user_id required" }, 400);
    if (user_id === user.id) return json({ error: "you can't remove yourself" }, 400);

    const { data: target } = await admin.from("profiles").select("id, email, full_name, region").eq("id", user_id).single();
    if (!target) return json({ error: "user not found" }, 404);
    if (target.region !== me.region) return json({ error: `${target.full_name || target.email} is in ${target.region} — only a ${target.region} manager can remove them` }, 403);

    // Clear the pointers that reference this profile so the delete isn't blocked. Sheet content is untouched.
    const clears: [string, string[]][] = [
      ["jobs", ["created_by"]],
      ["worksheets", ["created_by", "updated_by"]],
      ["incidents", ["reported_by", "acknowledged_by"]],
      ["drill_reports", ["sent_by"]],
      ["closeout_reports", ["sent_by"]],
    ];
    for (const [table, cols] of clears) {
      for (const col of cols) {
        const { error } = await admin.from(table).update({ [col]: null }).eq(col, user_id);
        if (error && !/does not exist|relation|column/i.test(error.message)) return json({ error: `${table}.${col}: ${error.message}` }, 500);
      }
    }

    const { error } = await admin.auth.admin.deleteUser(user_id);   // profiles row cascades
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, removed: target.email });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
