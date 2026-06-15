// send-daily-digest — runs every minute via pg_cron.
// Finds users whose daily_reminder_time matches the current minute (in their
// timezone) and sends a single web-push summarizing today's pending tasks.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT     = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@taskvoice.app";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: "VAPID keys not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1. Read every user's daily-reminder preferences
  const { data: prefs, error: prefsErr } = await admin
    .from("user_preferences")
    .select("user_id, key, value")
    .in("key", ["daily_reminder_enabled", "daily_reminder_time", "daily_reminder_tz"]);

  if (prefsErr) {
    return new Response(JSON.stringify({ error: prefsErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!prefs?.length) {
    return new Response(JSON.stringify({ sent: 0, scanned: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Group by user
  type Prefs = Record<string, string>;
  const byUser: Record<string, Prefs> = {};
  for (const p of prefs as Array<{ user_id: string; key: string; value: string }>) {
    byUser[p.user_id] = byUser[p.user_id] ?? {};
    byUser[p.user_id][p.key] = p.value;
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  let scanned = 0;

  const now = new Date();

  for (const [userId, p] of Object.entries(byUser)) {
    scanned++;
    if (p.daily_reminder_enabled !== "1") continue;
    if (!p.daily_reminder_time) continue;

    const tz = p.daily_reminder_tz || "UTC";

    // HH:MM in the user's timezone
    let localHM: string;
    let today: string;
    try {
      localHM = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
      }).format(now);
      today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    } catch {
      continue; // bad timezone string
    }

    if (localHM !== p.daily_reminder_time) continue;

    // Fetch today's pending tasks assigned to this user
    const { data: tasks } = await admin
      .from("tasks")
      .select("description")
      .eq("assignee_id", userId)
      .eq("dueDate", today)
      .eq("status", "pending")
      .order("time", { ascending: true })
      .limit(5);

    if (!tasks?.length) continue;

    const titles = tasks.map((t: { description: string }) => t.description);
    const body = titles.slice(0, 3).join(" · ") + (titles.length > 3 ? "…" : "");
    const payload = JSON.stringify({
      title: `${tasks.length} task${tasks.length === 1 ? "" : "s"} today`,
      body,
      url: "/",
      taskId: "daily-digest",
    });

    // Send to every push subscription this user has
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", userId);

    for (const sub of (subs ?? []) as Array<{ endpoint: string; p256dh: string; auth: string }>) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        failed++;
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 410 || code === 404) {
          // Subscription expired/invalid — remove it so we don't keep trying
          await admin.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
          pruned++;
        } else {
          console.error("push failed:", (err as Error)?.message || err);
        }
      }
    }
  }

  return new Response(JSON.stringify({ sent, failed, pruned, scanned }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
