// send-invite — adds a team member for a manager.
//   • Email already registered as a team member → link directly, no email.
//   • Registered but never onboarded → magic-link email landing on the invite.
//   • Not registered → Supabase's built-in "Invite user" email.
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
    const normEmail = String(email).trim().toLowerCase();

    // Already registered? Look the email up among existing users.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = list?.users?.find(
      (u: { email?: string }) => (u.email ?? "").toLowerCase() === normEmail,
    );

    if (existing) {
      const { data: prof } = await admin
        .from("profiles").select("id, full_name, role").eq("id", existing.id).single();

      if (prof?.role === "assigner") {
        return json({ error: "This email belongs to a manager account" }, 400);
      }

      if (prof) {
        // Registered team member → link to this manager directly, no email
        const { error: mapErr } = await admin
          .from("assigner_assignee_map")
          .upsert(
            { assigner_id: user.id, assignee_id: prof.id },
            { ignoreDuplicates: true },
          );
        if (mapErr) return json({ error: mapErr.message }, 400);
        await admin.from("invites").update({ status: "accepted" }).eq("id", invite.id);
        return json({ linked: true, name: prof.full_name });
      }

      // Auth user exists but never finished onboarding → magic-link email
      // that lands on the invite URL (onboarding will force the assignee role)
      const { error: otpErr } = await admin.auth.signInWithOtp({
        email: normEmail,
        options: { emailRedirectTo: redirectTo },
      });
      if (otpErr) return json({ error: otpErr.message }, 400);
      return json({ sent: true, existing: true });
    }

    // Brand-new user → proper invite email
    const { error } = await admin.auth.admin.inviteUserByEmail(normEmail, {
      redirectTo,
      data: { full_name: name ?? "" },
    });
    if (error) return json({ error: error.message }, 400);

    return json({ sent: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
