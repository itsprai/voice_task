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

SPLIT vs MERGE — decide carefully whether the speech contains ONE task or MULTIPLE tasks.

Bias HEAVILY toward ONE task. Most real-world utterances are a single action plus surrounding context.

Output MULTIPLE tasks ONLY when there are clearly distinct actions AND at least one of these is true:
  - different assignees (one for Sarah, one for Mike)
  - different dates/times that aren't shared context (call at 5pm, pay rent tomorrow)
  - independent goals with no shared purpose (call mom, file expense report)

Output ONE task (with notes / subtasks) when:
  - The speech is one main action with surrounding context (where, when, who-with, why, with-what details).
  - The "extra parts" are details, agenda items, or sub-steps of executing ONE goal.
  - Same assignee, same general topic, even if multiple sentences.

Examples of ONE task (do NOT split — collapse details into notes/subtasks):
  - "Ask Sarah to prepare the Acme client presentation, focus on Q4 numbers, meeting is Thursday at 3pm"
      → 1 task to Sarah, description "Prepare Acme client presentation", time "15:00", dueDate=Thursday,
        notes "Focus on Q4 numbers"
  - "Call mom about her doctor appointment, ask what the doctor said and whether she needs medicine"
      → 1 task to Me, description "Call mom", notes "Discuss doctor appointment, what doctor said, whether she needs medicine"
  - "Plan the office party — book the venue, order food, send invites"
      → 1 task to Me, description "Plan the office party", subtasks ["Book venue","Order food","Send invites"]
  - "Pay rent of 1850 dollars to the landlord by the 5th via NEFT"
      → 1 task, description "Pay rent", notes "$1850 to landlord by 5th, NEFT"

Examples of MULTIPLE tasks (DO split):
  - "Ask Sarah to send the report by Friday and have Mike review the slides by Monday"
      → 2 tasks: one to Sarah (Friday), one to Mike (Monday)
  - "Remind me to call mom at 5pm and pay the rent tomorrow"
      → 2 tasks: call mom (today 17:00), pay rent (tomorrow)
  - "Get Aditya to fix the deploy bug and Anil to update the docs"
      → 2 tasks: one to Aditya, one to Anil

When in DOUBT between split and merge → MERGE into one task with notes. Splitting a single task wrongly is much worse than missing a split.

NOTES — extra context that doesn't belong in the short task title goes in "notes":
- Amounts ("12,500 INR", "$185"), addresses, IDs, agenda items, names, deadlines beyond the due date,
  links, phone numbers, instructions ("include itemized invoice", "ask Aditya for login").
- Anything the assignee needs to know to execute the task, but that doesn't fit in a short title.
- Keep description SHORT and imperative (≤7 words ideally). Push details to notes.
- If no extra context, notes = "".

SUBTASKS — only when the user enumerates concrete sub-steps inside ONE task. Triggers: "with subtasks", "with steps", "first X then Y then Z", "by doing A, B, and C", or a clear enumerated list of sub-actions sharing one parent goal.
- If detected, output as an array of short imperative phrases.
- If not detected, subtasks = [].
- Items that are just CONTEXT (names, places, dates) belong in notes, NOT subtasks.

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

CUSTOM RECURRENCE — if the user says a pattern that DOESN'T fit any preset above, use recurrence="custom" and include a "recurrence_rule" object:
- "every 3 days" / "every 5 days" → recurrence="custom", recurrence_rule={interval:N, unit:"days"}
- "every 2 weeks" already maps to fortnightly; "every 4 weeks" / "every 6 weeks" → recurrence="custom", recurrence_rule={interval:N, unit:"weeks"}
- "every 4 months" / "every 8 months" → recurrence="custom", recurrence_rule={interval:N, unit:"months"}
- "every 2 years" / "every 5 years" → recurrence="custom", recurrence_rule={interval:N, unit:"years"}
- "every Monday and Thursday" → recurrence="custom", recurrence_rule={interval:1, unit:"weeks", byDays:["mon","thu"]}
- "every other Tuesday" → recurrence="custom", recurrence_rule={interval:2, unit:"weeks", byDays:["tue"]}
- "every weekday until end of month" → recurrence="weekdays" (preset) plus end-date is fine, but if you need a true end add recurrence_rule={endType:"on", endDate:"YYYY-MM-DD"} alongside
- "every Monday for the next 5 weeks" → recurrence="custom", recurrence_rule={interval:1, unit:"weeks", byDays:["mon"], endType:"count", endCount:5}
- "every day until December 31" → recurrence="custom", recurrence_rule={interval:1, unit:"days", endType:"on", endDate:"<resolved YYYY-MM-DD>"}
recurrence_rule shape: {interval:integer≥1, unit:"days"|"weeks"|"months"|"years", byDays?:["mon","tue","wed","thu","fri","sat","sun"], endType?:"never"|"on"|"count", endDate?:"YYYY-MM-DD", endCount?:integer≥1}
ONLY include "recurrence_rule" when recurrence="custom". Otherwise omit it.

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
- "recurrence": one of "none", "hourly", "daily", "weekdays", "weekends", "weekly", "fortnightly", "monthly", "quarterly", "biannually", "yearly", "custom". See RECURRENCE + CUSTOM RECURRENCE rules above. Default "none".
- "recurrence_rule": ONLY when recurrence="custom". See CUSTOM RECURRENCE shape above.
- "priority": "urgent" or "normal". See PRIORITY rules above. Default "normal".
- "notes": extra context (see NOTES rules above). Default "".
- "subtasks": array of short strings (see SUBTASKS rules above). Default [].

Return a JSON object:
{"tasks": [{"description": "string", "assignee": "string", "dueDate": "YYYY-MM-DD", "time": "HH:MM", "recurrence": "string", "recurrence_rule": object|null, "priority": "string", "notes": "string", "subtasks": ["string", ...]}]}

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
    const validRecur = ['none','hourly','daily','weekdays','weekends','weekly','fortnightly','monthly','quarterly','biannually','yearly','custom'];

    for (const t of tasks) {
      if (!t.description || !t.assignee) continue;

      const assigneeRaw = t.assignee.trim();
      const isSelf = selfRefs.includes(assigneeRaw.toLowerCase());
      const recurrence = validRecur.includes(t.recurrence) ? t.recurrence : 'none';
      const recurrence_rule = recurrence === 'custom' && t.recurrence_rule
        ? normalizeRecurrenceRule(t.recurrence_rule)
        : null;
      const priority   = t.priority === 'urgent' ? 'urgent' : 'normal';
      const notes      = typeof t.notes === 'string' ? t.notes.trim() : '';
      const subtasks   = Array.isArray(t.subtasks)
        ? t.subtasks.map(s => String(s).trim()).filter(Boolean).slice(0, 10)
            .map(text => ({ id: crypto.randomUUID(), text, done: false }))
        : [];

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
          recurrence_rule,
          priority,
          notes,
          subtasks,
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
        recurrence_rule,
        priority,
        notes,
        subtasks,
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

SPLIT vs MERGE — decide carefully whether the speech is ONE task or MULTIPLE tasks.

Bias HEAVILY toward ONE task. Most utterances are a single action plus surrounding context.

Output MULTIPLE tasks ONLY when there are clearly distinct actions AND at least one of these is true:
  - different dates/times that aren't shared context (call at 5pm, pay rent tomorrow)
  - independent goals with no shared purpose (call mom, file expenses)

Output ONE task (with notes / subtasks) when:
  - The speech is one main action with surrounding context (where, when, why, with-what details).
  - The "extra parts" are details, agenda items, or sub-steps of executing ONE goal.

Examples of ONE task (do NOT split):
  - "Pay rent of 1850 dollars to the landlord by the 5th via NEFT"
      → 1 task "Pay rent", notes "$1850 to landlord by 5th, NEFT"
  - "Call mom about her doctor appointment, ask what the doctor said and whether she needs medicine"
      → 1 task "Call mom", notes "Discuss doctor appointment, what doctor said, whether she needs medicine"
  - "Plan the office party — book the venue, order food, send invites"
      → 1 task "Plan office party", subtasks ["Book venue","Order food","Send invites"]

Examples of MULTIPLE tasks (DO split):
  - "Remind me to call mom at 5pm and pay the rent tomorrow"
      → 2 tasks: call mom (today 17:00), pay rent (tomorrow)
  - "Email the report and then go for a run"
      → 2 tasks: independent goals

When in DOUBT → MERGE. Splitting a single task wrongly is worse than missing a split.

For each task return:
- "description": imperative phrase, SHORT (≤7 words ideally). Strip "remind me to", "I need to", "I have to", and recurrence words from description.
- "dueDate": YYYY-MM-DD. Use ${todayISO} if no date. For recurring tasks this is the FIRST occurrence.
  - "today"=${todayISO}, "tomorrow"=next day, "this/next [weekday]", "end of week"=Friday.
- "time": HH:MM 24-hour. Use ${currentTime} if no time.
  - "3pm"=15:00, "noon"=12:00, "morning"=09:00, "afternoon"=14:00, "evening"=18:00.
- "recurrence": one of "none","hourly","daily","weekdays","weekends","weekly","fortnightly","monthly","quarterly","biannually","yearly","custom". Detection cues:
  - "every day"/"daily"→daily, "every weekday"→weekdays, "every weekend"→weekends, "weekly"/"every Monday/Tuesday/etc"→weekly,
  - "fortnightly"/"biweekly"/"every two weeks"→fortnightly, "monthly"/"every month"→monthly,
  - "quarterly"/"every 3 months"→quarterly, "every 6 months"/"semi-annually"→biannually,
  - "yearly"/"annually"→yearly, "hourly"/"every hour"→hourly.
  - "by Friday"/"this Tuesday"/"tomorrow" are one-off deadlines → recurrence="none".
  - Default "none" when no clear recurring cue.
- "recurrence_rule": ONLY when recurrence="custom". For patterns that DON'T fit any preset:
  - "every N days/weeks/months/years" with N not matching a preset → {interval:N, unit:"days|weeks|months|years"}
  - "every Mon and Thu" → {interval:1, unit:"weeks", byDays:["mon","thu"]}
  - "every other Tue" → {interval:2, unit:"weeks", byDays:["tue"]}
  - "for the next 5 weeks/times" → add endType:"count", endCount:5
  - "until 2026-12-31" → add endType:"on", endDate:"YYYY-MM-DD"
  Omit "recurrence_rule" entirely (or set null) when recurrence ≠ "custom".
- "priority": "urgent" if speech contains "urgent","ASAP","important","high/top priority","critical","right away","immediately"; else "normal".
- "notes": extra context not needed in the title (amounts, addresses, IDs, agenda items, links). Empty string if none.
- "subtasks": only if user enumerates steps ("with steps", "first X then Y then Z"). Otherwise empty array.

JSON only:
{"tasks":[{"description":"...","dueDate":"YYYY-MM-DD","time":"HH:MM","recurrence":"...","recurrence_rule":object|null,"priority":"...","notes":"...","subtasks":[]}]}

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
    const validRecur = ['none','hourly','daily','weekdays','weekends','weekly','fortnightly','monthly','quarterly','biannually','yearly','custom'];
    return tasks.map(t => {
      const recurrence = validRecur.includes(t.recurrence) ? t.recurrence : 'none';
      const recurrence_rule = recurrence === 'custom' && t.recurrence_rule
        ? normalizeRecurrenceRule(t.recurrence_rule)
        : null;
      return {
        id:              crypto.randomUUID(),
        raw:             transcript,
        description:     t.description.trim(),
        assignee:        '',
        assignee_id:     null,
        assigner_id:     null,
        added_by:        null,
        dueDate:         t.dueDate  || todayISO,
        time:            t.time     || currentTime,
        status:          'pending',
        recurrence,
        recurrence_rule,
        priority:        t.priority === 'urgent' ? 'urgent' : 'normal',
        notes:           typeof t.notes === 'string' ? t.notes.trim() : '',
        subtasks:        Array.isArray(t.subtasks)
          ? t.subtasks.map(s => String(s).trim()).filter(Boolean).slice(0, 10)
              .map(text => ({ id: crypto.randomUUID(), text, done: false }))
          : [],
        createdAt,
        updatedAt:       createdAt
      };
    });
  },

  // Ask Groq to break a task description (+ optional notes) into concrete,
  // grounded subtasks. Returns an array of plain-text steps; falls back to []
  // on any error or when there's nothing to ground on.
  async breakIntoSteps(description, notes = '') {
    const desc = (description || '').trim();
    const ctx  = (notes || '').trim();
    if (!desc) return [];

    const systemPrompt = `Break a task into actionable subtasks, GROUNDED in the description and notes the user provided.

HARD RULES:
1. Every step must be a concrete action explicitly implied by the description OR notes. Do NOT invent steps that go beyond what the user said.
2. Use specific names, amounts, dates, places from the notes VERBATIM when phrasing steps.
3. NEVER output generic filler steps like "research the problem", "plan the approach", "verify everything", "follow up as needed", or "track status". If you cannot ground a step in the input, do not output it.
4. Step count scales with complexity:
   - Trivial task with no notes → return {"steps": []} (empty array). Be honest when there's nothing to break down.
   - Simple task → 2-3 steps.
   - Complex task with rich notes → up to 6 steps.
5. Each step is a SHORT imperative phrase (max 10 words). No numbering, no markdown, no explanations.
6. Do NOT restate the main action as its own step. Steps execute the task; they don't repeat it.

Return ONLY a JSON object: {"steps": ["step 1", "step 2"]}.

Examples:

Task: "Pay rent"
Notes: ""
→ {"steps": []}   ← nothing to ground; return empty rather than invent steps

Task: "Pay rent"
Notes: "$1850 to landlord by 5th via NEFT"
→ {"steps": ["Transfer $1850 via NEFT to landlord", "Send him the UTR by 5th"]}

Task: "Send prescription"
Notes: "Rich Tyagi · Apollo Pharmacy · BP meds"
→ {"steps": ["Pull Rich Tyagi's BP prescription", "Submit to Apollo Pharmacy", "Share confirmation with Rich"]}

Task: "Prepare client demo"
Notes: "Acme, Thursday 3pm, focus on Q4 numbers + new pricing"
→ {"steps": ["Pull Q4 numbers", "Add new pricing slide", "Run through deck before Thu 3pm"]}

Task: "Plan office party"
Notes: "Dec 15, venue + catering + invites"
→ {"steps": ["Book venue for Dec 15", "Arrange catering", "Send invites"]}

Task: "Email client"
Notes: ""
→ {"steps": []}`;

    const userPrompt = ctx
      ? `Description: "${desc}"\nNotes: "${ctx}"`
      : `Description: "${desc}"\nNotes: ""`;

    const payload = JSON.stringify({
      model:           CONFIG.GROQ_MODEL,
      messages:        [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      temperature:     0.2,
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

    if (!res.ok) throw new Error(`Groq error (${res.status})`);
    const data = await res.json();
    let parsed;
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || ''); }
    catch { return []; }
    return Array.isArray(parsed?.steps) ? parsed.steps.map(s => String(s).trim()).filter(Boolean).slice(0, 8) : [];
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
