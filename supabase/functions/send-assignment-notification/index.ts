// send-assignment-notification — fires when a manager assigns a task to a
// teammate. Verifies the caller's JWT, confirms the manager → teammate link
// in assigner_assignee_map, then web-pushes every subscription the teammate
// has registered.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT     = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@taskvoice.app";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Friendly "Mon, Jun 22 at 3:00 PM" / "Mon, Jun 22" / "" depending on inputs.
function formatDue(dueDate?: string | null, time?: string | null): string {
  if (!dueDate) return "";
  try {
    const [y, m, d] = dueDate.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dateStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month:   "short",
      day:     "numeric",
    }).format(dt);
    if (!time) return dateStr;
    const [hh, mm] = time.split(":").map(Number);
    const tDate = new Date(Date.UTC(2000, 0, 1, hh, mm));
    const timeStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour:     "numeric",
      minute:   "2-digit",
      hour12:   true,
    }).format(tDate);
    return `${dateStr} at ${timeStr}`;
  } catch {
    return dueDate;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json({ error: "VAPID keys not configured" }, 500);
  }

  try {
    const {
      taskId,
      assigneeId,
      description,
      dueDate,
      time,
      priority,
    } = await req.json();

    if (!assigneeId || !description) {
      return json({ error: "assigneeId and description are required" }, 400);
    }

    // 1. Authenticate the caller
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const assignerId = user.id;

    // Don't bother for self-assigned (shouldn't happen, but cheap guard)
    if (assignerId === assigneeId) {
      return json({ sent: 0, skipped: "self-assigned" });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 2. Verify the manager → teammate link genuinely exists
    const { data: link } = await admin
      .from("assigner_assignee_map")
      .select("assigner_id")
      .eq("assigner_id", assignerId)
      .eq("assignee_id", assigneeId)
      .maybeSingle();
    if (!link) return json({ error: "Not linked to this teammate" }, 403);

    // 3. Compose notification content
    const { data: assignerProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", assignerId)
      .single();

    const fromName = (assignerProfile?.full_name || "Your manager").split(" ")[0];
    const urgentMark = priority === "urgent" ? "! " : "";
    const dueStr     = formatDue(dueDate, time);

    const title = `New task from ${fromName}`;
    const body  = dueStr
      ? `${urgentMark}${description} — ${dueStr}`
      : `${urgentMark}${description}`;

    const payload = JSON.stringify({
      title,
      body,
      url:    "/",
      taskId: taskId || null,
    });

    // 4. Fetch the teammate's push subscriptions and send
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", assigneeId);

    let sent = 0, failed = 0, pruned = 0;

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
          await admin.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
          pruned++;
        } else {
          console.error("push failed:", (err as Error)?.message || err);
        }
      }
    }

    return json({ sent, failed, pruned, subscriptions: subs?.length ?? 0 });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
