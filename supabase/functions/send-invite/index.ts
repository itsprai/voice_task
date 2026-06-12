// send-invite — emails an invite to a team member using Supabase's built-in
// "Invite user" email. Falls back to a magic-link email if the invitee
// already has an account (inviteUserByEmail rejects existing users).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { email, name, inviteToken, appUrl } = await req.json();
    if (!email || !inviteToken || !appUrl) {
      return json({ error: "email, inviteToken and appUrl are required" }, 400);
    }

    // Verify the caller is an authenticated user
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Only managers may send invites
    const { data: profile } = await admin
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "assigner") {
      return json({ error: "Only managers can send invites" }, 403);
    }

    // Verify the invite row belongs to this manager
    const { data: invite } = await admin
      .from("invites").select("id, assigner_id").eq("token", inviteToken).single();
    if (!invite || invite.assigner_id !== user.id) {
      return json({ error: "Invite not found" }, 404);
    }

    // Supabase validates redirectTo against the auth Redirect URLs allowlist
    const redirectTo = `${String(appUrl).replace(/\/$/, "")}/?invite=${inviteToken}`;

    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { full_name: name ?? "" },
    });

    if (error) {
      const alreadyExists =
        error.status === 422 || /already.*registered/i.test(error.message);
      if (alreadyExists) {
        // Existing account → send a magic-link email that lands on the invite URL
        const { error: otpErr } = await admin.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (otpErr) return json({ error: otpErr.message }, 400);
        return json({ sent: true, existing: true });
      }
      return json({ error: error.message }, 400);
    }

    return json({ sent: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
