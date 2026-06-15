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
const GROQ_API_KEY      = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_MODEL        = Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// One-line natural-language digest from a task list. Returns null on any failure
// so the caller can fall back to the plain-text format.
async function summarizeTasks(descriptions: string[], totalCount: number): Promise<string | null> {
  if (!GROQ_API_KEY || !descriptions.length) return null;

  const systemPrompt =
    `You write a SINGLE short sentence (max ~110 characters) summarizing a user's tasks for today, for a push notification.
Be warm but factual — no greetings, no emojis, no "Hi", no "you have", no bullet lists.
Capture the day's theme or highlight the most time-sensitive or important item.
For long lists, group into themes and acknowledge the volume.
Return ONLY the sentence, no quotes, no markdown.

Examples:
Tasks (3 total): ["Send Prescription of Rich Tyagi","Call Mohit","Order dad eyeglasses"]
→ Two errands and a call with Mohit lined up for today.

Tasks (1 total): ["Apply Australian Visa"]
→ One focus today: your Australian visa application.

Tasks (4 total): ["Send report","Standup","1:1 with John","Code review"]
→ Standup, 1:1 with John, plus a report and a code review to wrap.

Tasks (12 total, showing 10): ["Pay rent","Email lawyer","School fee","Buy groceries","Doctor follow-up","Call mom","Fix sink","Pickup laundry","Submit timesheet","Order books"]
→ Heavy day — 12 tasks across errands, calls, and admin work to clear.`;

  const userPrompt = totalCount > descriptions.length
    ? `Tasks (${totalCount} total, showing ${descriptions.length}): ${JSON.stringify(descriptions)}`
    : `Tasks (${totalCount} total): ${JSON.stringify(descriptions)}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages:    [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt   },
        ],
        temperature: 0.3,
        max_tokens:  60,
      }),
      // Don't let a stuck Groq call block the cron tick
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    // Strip any wrapping quotes/markdown
    return text.replace(/^["'`*_]+|["'`*_]+$/g, "").slice(0, 140);
  } catch (err) {
    console.warn("summarizeTasks failed:", (err as Error)?.message);
    return null;
  }
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

    // First a cheap exact count so the title reflects the TRUE number of tasks
    // (decoupled from the LLM-friendly limit below)
    const { count: totalCount } = await admin
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("assignee_id", userId)
      .eq("dueDate", today)
      .eq("status", "pending");

    if (!totalCount) continue;

    // Up to 10 descriptions feed the LLM — enough for theme detection without
    // bloating the prompt or push body
    const { data: tasks } = await admin
      .from("tasks")
      .select("description")
      .eq("assignee_id", userId)
      .eq("dueDate", today)
      .eq("status", "pending")
      .order("time", { ascending: true })
      .limit(10);

    if (!tasks?.length) continue;

    const titles    = tasks.map((t: { description: string }) => t.description);
    const aiBody    = await summarizeTasks(titles, totalCount);
    const plainBody = totalCount > 3
      ? `${titles.slice(0, 3).join(" · ")} +${totalCount - 3} more`
      : titles.slice(0, totalCount).join(" · ");
    const body      = aiBody ?? plainBody;
    const payload = JSON.stringify({
      title: `${totalCount} task${totalCount === 1 ? "" : "s"} today`,
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
