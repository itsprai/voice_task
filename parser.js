// ─────────────────────────────────────────────────────────────────────────────
//  parser.js — Groq NLP parser with team-member name resolution
//
//  For assigners: Groq extracts a name → fuzzy-matched against confirmed team.
//  For assignees using voice (add-task): assigner is picked from a dropdown,
//    so Parser.parse() is only called in assigner context.
// ─────────────────────────────────────────────────────────────────────────────

const Parser = {

  // team: [{ id, full_name }] — current assigner's confirmed team
  // Returns array of task objects with assignee_id resolved.
  async parse(transcript, team = []) {
    const now        = new Date();
    const todayISO   = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().slice(0, 5);
    const todayLabel = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const teamNames = team.map(m => m.full_name).join(', ') || 'anyone';

    const systemPrompt = `You are a task extraction assistant for a busy manager.
Today is ${todayLabel} (${todayISO}). Current time is ${currentTime}.

The manager's team: ${teamNames}. Team-member names must match this list exactly (case-insensitive).

Extract EVERY task mentioned. Each task has its OWN assignee, date, time, and recurrence.

PRIORITY — set "priority" to "urgent" when speech contains words like:
- "urgent", "urgently", "ASAP", "important", "high priority", "top priority",
  "critical", "right away", "immediately", "first thing", "drop everything"
Otherwise default to "normal". Do NOT mark urgent just because there's a near-term deadline like "in 5 min" — only when an urgency adjective is explicit.

RECURRENCE — set "recurrence" based on speech cues:
- "every day", "daily", "each morning/night/evening" → "daily"
- "every weekday", "Mon-Fri", "on weekdays" → "weekdays"
- "every weekend", "on weekends" → "weekends"
- "weekly", "every week", "every Monday/Tuesday/Sunday/etc" → "weekly"
- "biweekly", "fortnightly", "every two weeks", "every other week" → "fortnightly"
- "monthly", "every month", "each month" → "monthly"
- "quarterly", "every 3 months", "each quarter" → "quarterly"
- "every 6 months", "twice a year", "semi-annually" → "biannually"
- "yearly", "annually", "every year" → "yearly"
- "hourly", "every hour" → "hourly"
- NO recurrence cue → "none"

Do NOT confuse a one-off deadline with recurrence:
- "by Monday" / "by Friday" → deadline, recurrence="none"
- "this Tuesday at 5pm" / "tomorrow morning" → one-off, recurrence="none"
- "every Monday" / "on Mondays at 5pm" → recurring, recurrence="weekly"
- "remind me to call mom tonight" → one-off, recurrence="none"
- "remind me to call mom every night" → recurring, recurrence="daily"

ASSIGNEE — read CAREFULLY:
- The assignee is the PERSON WHO MUST DO the task, NOT the recipient of an outcome.
- Use "Me" ONLY when the manager is asking themselves to do something. Phrases that mean assignee = "Me":
  * "remind me to X", "I need to X", "I have to X", "I should X", "my task to X", "for myself"
- Use a team member name when the manager is delegating. Phrases that mean assignee = team member:
  * "ask X to", "tell X to", "have X", "get X to", "assign X to", "X needs to", "X should"

CRITICAL — do NOT confuse "me" appearing inside a delegated task with a self-task:
  * "Ask Aditya to send the report to me" → assignee = "Aditya" (Aditya does the work; "to me" is just the recipient)
  * "Tell Sarah to email me by 5pm" → assignee = "Sarah"
  * "Have Marcus call me tomorrow" → assignee = "Marcus"
  * "Get John to update me on status" → assignee = "John"
  * "Remind me to email Sarah" → assignee = "Me"
  * "I need to call Marcus" → assignee = "Me"

Whenever a delegation phrase ("ask/tell/have/get/assign X to") is present, the assignee is X — regardless of how many times "me" appears later in the sentence.

For each task return:
- "description": imperative phrase. Strip "remind me to", "I need to", "I have to" when assignee is "Me". Strip recurrence words ("every day", "weekly", etc.) from description.
- "assignee": "Me" for self-tasks, or a team member's name (title case) for delegated tasks.
- "dueDate": resolve relative dates to YYYY-MM-DD. Use ${todayISO} if no date mentioned. For recurring tasks, this is the FIRST occurrence's date.
  * "today" = ${todayISO}, "tomorrow" = next day
  * "this [weekday]" = upcoming occurrence, "next [weekday]" = next week
  * "end of week" = this Friday
- "time": extract time in HH:MM (24-hour). Use ${currentTime} if no time mentioned.
  * "3pm" = "15:00", "9am" = "09:00", "noon" = "12:00"
  * "morning" = "09:00", "afternoon" = "14:00", "evening" = "18:00"
- "recurrence": one of "none", "hourly", "daily", "weekdays", "weekends", "weekly", "fortnightly", "monthly", "quarterly", "biannually", "yearly". See RECURRENCE rules above. Default "none".
- "priority": "urgent" or "normal". See PRIORITY rules above. Default "normal".

Return a JSON object:
{"tasks": [{"description": "string", "assignee": "string", "dueDate": "YYYY-MM-DD", "time": "HH:MM", "recurrence": "string", "priority": "string"}]}

If no task found:
{"tasks": [], "error": "Could not understand the task. Please speak again."}`;

    const payload = JSON.stringify({
      model:           CONFIG.GROQ_MODEL,
      messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: transcript }],
      temperature:     0.1,
      response_format: { type: 'json_object' }
    });

    // Local dev with a key in config.js calls Groq directly;
    // production goes through the /api/groq proxy so the key never ships to the browser.
    const useDirect = CONFIG.GROQ_API_KEY && CONFIG.GROQ_API_KEY !== 'YOUR_GROQ_API_KEY';
    const res = useDirect
      ? await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` },
          body: payload
        })
      : await fetch('/api/groq', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Auth.token}` },
          body: payload
        });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Groq API error (${res.status})`);
    }

    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new Error('Could not understand response. Please try again.'); }

    if (parsed.error && (!parsed.tasks || !parsed.tasks.length)) throw new Error(parsed.error);

    const tasks = parsed.tasks || [];
    if (!tasks.length) throw new Error('Could not find a person or task. Please speak again.');

    const createdAt = new Date().toISOString();
    const result    = [];

    const myId       = Auth.profile?.id ?? null;
    const myName     = Auth.profile?.full_name ?? 'Me';
    const selfRefs   = ['me', 'myself', 'i', 'self'];
    const validRecur = ['none','hourly','daily','weekdays','weekends','weekly','fortnightly','monthly','quarterly','biannually','yearly'];

    for (const t of tasks) {
      if (!t.description || !t.assignee) continue;

      const assigneeRaw = t.assignee.trim();
      const isSelf = selfRefs.includes(assigneeRaw.toLowerCase());
      const recurrence = validRecur.includes(t.recurrence) ? t.recurrence : 'none';
      const priority   = t.priority === 'urgent' ? 'urgent' : 'normal';

      if (isSelf) {
        // Personal task — assigner & assignee both the current user
        result.push({
          id:          crypto.randomUUID(),
          raw:         transcript,
          description: t.description.trim(),
          assignee:    myName,
          assignee_id: myId,
          assigner_id: myId,
          added_by:    myId,
          dueDate:     t.dueDate || todayISO,
          time:        t.time    || currentTime,
          status:      'pending',
          recurrence,
          priority,
          createdAt,
          updatedAt:   createdAt
        });
        continue;
      }

      // Resolve assignee name → team member
      const member = this._resolveTeamMember(assigneeRaw, team);
      if (!member && team.length > 0) {
        throw new Error(`"${assigneeRaw}" is not in your team. Check the name and try again.`);
      }

      result.push({
        id:          crypto.randomUUID(),
        raw:         transcript,
        description: t.description.trim(),
        assignee:    member ? member.full_name : assigneeRaw,
        assignee_id: member ? member.id : null,
        assigner_id: myId,
        added_by:    myId,
        dueDate:     t.dueDate || todayISO,
        time:        t.time    || currentTime,
        status:      'pending',
        recurrence,
        priority,
        createdAt,
        updatedAt:   createdAt
      });
    }

    return result;
  },

  // Simplified parser — no assignee extraction. Used for personal/own-task
  // dictation where the assignee is always the speaker.
  async parseSimple(transcript) {
    const now         = new Date();
    const todayISO    = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().slice(0, 5);
    const todayLabel  = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const systemPrompt = `Extract task details from the user's speech.
Today is ${todayLabel} (${todayISO}). Current time is ${currentTime}.

Extract every task mentioned. For each:
- "description": imperative phrase. Strip "remind me to", "I need to", "I have to", and recurrence words from description.
- "dueDate": YYYY-MM-DD. Use ${todayISO} if no date. For recurring tasks this is the FIRST occurrence.
  - "today"=${todayISO}, "tomorrow"=next day, "this/next [weekday]", "end of week"=Friday.
- "time": HH:MM 24-hour. Use ${currentTime} if no time.
  - "3pm"=15:00, "noon"=12:00, "morning"=09:00, "afternoon"=14:00, "evening"=18:00.
- "recurrence": one of "none","hourly","daily","weekdays","weekends","weekly","fortnightly","monthly","quarterly","biannually","yearly". Detection cues:
  - "every day"/"daily"→daily, "every weekday"→weekdays, "every weekend"→weekends, "weekly"/"every Monday/Tuesday/etc"→weekly,
  - "fortnightly"/"biweekly"/"every two weeks"→fortnightly, "monthly"/"every month"→monthly,
  - "quarterly"/"every 3 months"→quarterly, "every 6 months"/"semi-annually"→biannually,
  - "yearly"/"annually"→yearly, "hourly"/"every hour"→hourly.
  - "by Friday"/"this Tuesday"/"tomorrow" are one-off deadlines → recurrence="none".
  - Default "none" when no clear recurring cue.
- "priority": "urgent" if speech contains "urgent","ASAP","important","high/top priority","critical","right away","immediately"; else "normal".

JSON only:
{"tasks":[{"description":"...","dueDate":"YYYY-MM-DD","time":"HH:MM","recurrence":"...","priority":"..."}]}

If nothing usable: {"tasks":[],"error":"Could not understand. Please speak again."}`;

    const payload = JSON.stringify({
      model:           CONFIG.GROQ_MODEL,
      messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: transcript }],
      temperature:     0.1,
      response_format: { type: 'json_object' }
    });
    const useDirect = CONFIG.GROQ_API_KEY && CONFIG.GROQ_API_KEY !== 'YOUR_GROQ_API_KEY';
    const res = useDirect
      ? await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` },
          body: payload
        })
      : await fetch('/api/groq', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Auth.token}` },
          body: payload
        });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Groq API error (${res.status})`);
    }

    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new Error('Could not understand response. Please try again.'); }
    if (parsed.error && (!parsed.tasks || !parsed.tasks.length)) throw new Error(parsed.error);

    const tasks = (parsed.tasks || []).filter(t => t.description);
    if (!tasks.length) throw new Error('Could not understand the task. Please speak again.');

    const createdAt = new Date().toISOString();
    const validRecur = ['none','hourly','daily','weekdays','weekends','weekly','fortnightly','monthly','quarterly','biannually','yearly'];
    return tasks.map(t => ({
      id:          crypto.randomUUID(),
      raw:         transcript,
      description: t.description.trim(),
      assignee:    '',
      assignee_id: null,
      assigner_id: null,
      added_by:    null,
      dueDate:     t.dueDate  || todayISO,
      time:        t.time     || currentTime,
      status:      'pending',
      recurrence:  validRecur.includes(t.recurrence) ? t.recurrence : 'none',
      priority:    t.priority === 'urgent' ? 'urgent' : 'normal',
      createdAt,
      updatedAt:   createdAt
    }));
  },

  // Fuzzy match: exact → startsWith → includes (case-insensitive)
  _resolveTeamMember(name, team) {
    if (!team.length) return null;
    const q = name.trim().toLowerCase();
    return (
      team.find(m => m.full_name.toLowerCase() === q) ||
      team.find(m => m.full_name.toLowerCase().startsWith(q)) ||
      team.find(m => m.full_name.toLowerCase().includes(q)) ||
      null
    );
  }
};
