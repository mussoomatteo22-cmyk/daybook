// Deletes the signed-in person's account and everything in it (events, classes, projects,
// settings, reminder log all cascade from auth.users). Required by the App Store for any app
// that lets people create an account. Called from Settings › Your data › Delete account.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = token ? await sb.auth.getUser(token) : { data: { user: null } };
  if (!user) return new Response("Forbidden", { status: 403, headers: cors });
  const { error } = await sb.auth.admin.deleteUser(user.id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500, headers: cors });
  return Response.json({ ok: true }, { headers: cors });
});
