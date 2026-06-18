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

// ─────────────────────────────────────────────────────────────────────────────
// Per-person summaries — single Groq call producing one short sentence per
// teammate (including the manager's "Me"). One LLM round-trip serves the
// whole Home page so cost stays predictable.
// Returns { [personId]: "summary sentence" } on success, {} on failure.
// ─────────────────────────────────────────────────────────────────────────────
async function summarizePerPerson(
  people: Array<{
    id: string;
    name: string;
    todayCount: number;
    overdueCount: number;
    urgentCount: number;
    descriptions: string[];
  }>,
): Promise<Record<string, string>> {
  if (!GROQ_API_KEY || !people.length) return {};

  const systemPrompt =
    `You write ONE short sentence summarizing each person's day for a manager's morning briefing.
Rules:
- Max ~90 characters per sentence.
- Warm but factual. No greetings. No emojis. No "you have". No bullet lists.
- Highlight overdue items when present. Mention urgency when set. Acknowledge light days.
- Reference the actual task descriptions or themes — be specific, not generic.
- Return ONLY a JSON object: {"summaries": {"<personId>": "sentence", ...}}.

Examples:
Input: [{"id":"a1","name":"Aditya","todayCount":3,"overdueCount":1,"urgentCount":1,"descriptions":["Deploy fix","Q4 deck","Send report"]}]
Output: {"summaries":{"a1":"Carrying over an invoice plus three tasks today including the urgent deploy fix."}}

Input: [{"id":"b1","name":"Anshul","todayCount":1,"overdueCount":0,"urgentCount":0,"descriptions":["Demo prep"]}]
Output: {"summaries":{"b1":"One task — demo prep this afternoon."}}

Input: [{"id":"c1","name":"Me","todayCount":0,"overdueCount":0,"urgentCount":0,"descriptions":[]}]
Output: {"summaries":{"c1":"Nothing on deck — quiet day."}}`;

  const userPrompt = JSON.stringify(people);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:           GROQ_MODEL,
        messages:        [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt   },
        ],
        temperature:     0.3,
        max_tokens:      400,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    const out: Record<string, string> = {};
    for (const [id, val] of Object.entries(parsed.summaries ?? {})) {
      if (typeof val === "string") out[id] = (val as string).slice(0, 140);
    }
    return out;
  } catch (err) {
    console.warn("summarizePerPerson failed:", (err as Error)?.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview handler — used by the web app's Home page.
// Authenticates via the caller's JWT, gathers today's pending tasks + overdue
// + urgent counts, plus per-teammate summaries when caller is an assigner.
// ─────────────────────────────────────────────────────────────────────────────
async function handlePreview(req: Request): Promise<Response> {
  // 1. Authenticate the caller
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 2. Resolve "today" in the user's preferred timezone (falls back to UTC)
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: prefs } = await admin
    .from("user_preferences")
    .select("key, value")
    .eq("user_id", user.id)
    .in("key", ["daily_reminder_tz"]);
  const tz = (prefs?.find((p: { key: string }) => p.key === "daily_reminder_tz") as { value: string } | undefined)?.value || "UTC";

  let today: string;
  try {
    today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    today = new Date().toISOString().split("T")[0];
  }

  // 3. Pull every task this caller can SEE that's relevant to today (Postgres
  // applies the filter; RLS already scopes the row visibility per user).
  //    Relevant = pending AND (dueDate = today OR dueDate < today).
  //    For the caller-as-assigner: any task they assigned (assigner_id = me).
  //    For the caller-as-assignee: any task assigned to them (assignee_id = me).
  // We don't know the caller's role yet — use a single query with OR so service
  // role returns rows that satisfy either condition for this user.
  const { data: allRelevant } = await admin
    .from("tasks")
    .select("id, description, priority, dueDate, time, dueAt, status, assigner_id, assignee_id, added_by")
    .or(`assigner_id.eq.${user.id},assignee_id.eq.${user.id}`)
    .eq("status", "pending")
    .lte("dueDate", today)
    .order("time", { ascending: true });

  // 4. Caller-scoped counts (their own assignee_id view — like an assignee role
  // would see). Used by the top-level digest paragraph.
  const myTodayTasks = (allRelevant ?? []).filter(
    (t: { assignee_id: string; dueDate: string }) =>
      t.assignee_id === user.id && t.dueDate === today,
  );
  const myOverdueTasks = (allRelevant ?? []).filter(
    (t: { assignee_id: string; dueDate: string }) =>
      t.assignee_id === user.id && t.dueDate < today,
  );
  const todayCount = myTodayTasks.length;
  const overdueCount = myOverdueTasks.length;
  const urgentCount = myTodayTasks.filter((t: { priority?: string }) => t.priority === "urgent").length;

  // Global summary intentionally skipped — Home now uses per-person cards only.
  const summary: string | null = null;

  // 5. Per-person buckets — only meaningful when caller is the assigner across
  // multiple teammates. We bucket by assignee_id, including the caller's own
  // personal-task bucket. Names come from profiles in one batch.
  const callerIsAssigner = (allRelevant ?? []).some(
    (t: { assigner_id: string }) => t.assigner_id === user.id,
  );

  const perPerson: Array<{
    id: string;
    name: string;
    todayCount: number;
    overdueCount: number;
    urgentCount: number;
    descriptions: string[];
    summary: string;
  }> = [];

  if (callerIsAssigner) {
    // Build buckets keyed by assignee_id. Only count rows the caller assigned
    // (assigner_id = me) so we don't leak the assignee's view of OTHER managers'
    // tasks into the caller's per-person summaries.
    type Bucket = {
      ids: Set<string>;
      today: { description: string; priority?: string }[];
      overdue: { description: string }[];
      urgent: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const t of (allRelevant ?? []) as Array<{
      id: string; description: string; priority?: string;
      dueDate: string; assigner_id: string; assignee_id: string;
    }>) {
      if (t.assigner_id !== user.id) continue;
      const key = t.assignee_id;
      if (!buckets.has(key)) buckets.set(key, { ids: new Set(), today: [], overdue: [], urgent: 0 });
      const b = buckets.get(key)!;
      b.ids.add(t.id);
      if (t.dueDate === today)        b.today.push({ description: t.description, priority: t.priority });
      else if (t.dueDate < today)     b.overdue.push({ description: t.description });
      if (t.priority === "urgent" && t.dueDate === today) b.urgent++;
    }

    // Resolve names in one batch
    const personIds = Array.from(buckets.keys());
    let names: Record<string, string> = {};
    if (personIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", personIds);
      names = Object.fromEntries((profs ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name]));
    }

    // Shape input for the LLM
    const llmInput = personIds.map(id => {
      const b = buckets.get(id)!;
      return {
        id,
        name: id === user.id ? "Me" : (names[id] || "Unknown"),
        todayCount: b.today.length,
        overdueCount: b.overdue.length,
        urgentCount: b.urgent,
        descriptions: [
          ...b.overdue.map(t => t.description),
          ...b.today.map(t => t.description),
        ].slice(0, 8),
      };
    });

    const summaries = await summarizePerPerson(llmInput);

    for (const p of llmInput) {
      perPerson.push({
        ...p,
        summary: summaries[p.id] || "",
      });
    }
  }

  return new Response(
    JSON.stringify({
      summary,
      todayCount,
      overdueCount,
      urgentCount,
      perPerson,
      generatedAt: new Date().toISOString(),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ── Preview mode ─────────────────────────────────────────────────────────
  // Called by the Home page on the web app. Returns a one-paragraph briefing
  // for the authenticated user's today + overdue picture.
  //
  // Body: { mode: "preview" }
  // Returns: { summary, todayCount, overdueCount, urgentCount }
  let body: { mode?: string } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = {}; }
  }

  if (body.mode === "preview") {
    return handlePreview(req);
  }

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
