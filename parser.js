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
    if (!CONFIG.GROQ_API_KEY || CONFIG.GROQ_API_KEY === 'your_groq_api_key_here') {
      throw new Error('Please add your Groq API key in config.js');
    }

    const now        = new Date();
    const todayISO   = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().slice(0, 5);
    const todayLabel = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const teamNames = team.map(m => m.full_name).join(', ') || 'anyone';

    const systemPrompt = `You are a task extraction assistant for a busy manager.
Today is ${todayLabel} (${todayISO}). Current time is ${currentTime}.

The manager's team: ${teamNames}. Match assignee names exactly to this list (case-insensitive).

Extract EVERY task mentioned. Each task has its OWN assignee, date, and time.

For each task return:
- "description": imperative phrase, no assignee name.
- "assignee": person's name from the team list (title case). Look for: "assign X to", "tell X to", "ask X to", "have X", "get X to".
- "dueDate": resolve relative dates to YYYY-MM-DD. Use ${todayISO} if no date mentioned.
  - "today" = ${todayISO}, "tomorrow" = next day
  - "this [weekday]" = upcoming occurrence, "next [weekday]" = next week
  - "end of week" = this Friday
- "time": extract time in HH:MM (24-hour). Use ${currentTime} if no time mentioned.
  - "3pm" = "15:00", "9am" = "09:00", "noon" = "12:00"
  - "morning" = "09:00", "afternoon" = "14:00", "evening" = "18:00"

Return a JSON object:
{"tasks": [{"description": "string", "assignee": "string", "dueDate": "YYYY-MM-DD", "time": "HH:MM"}]}

If no task found:
{"tasks": [], "error": "Could not understand the task. Please speak again."}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` },
      body: JSON.stringify({
        model:           CONFIG.GROQ_MODEL,
        messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: transcript }],
        temperature:     0.1,
        response_format: { type: 'json_object' }
      })
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

    for (const t of tasks) {
      if (!t.description || !t.assignee) continue;

      // Resolve assignee name → team member
      const member = this._resolveTeamMember(t.assignee, team);
      if (!member && team.length > 0) {
        throw new Error(`"${t.assignee}" is not in your team. Check the name and try again.`);
      }

      result.push({
        id:          crypto.randomUUID(),
        raw:         transcript,
        description: t.description.trim(),
        assignee:    member ? member.full_name : t.assignee.trim(),
        assignee_id: member ? member.id : null,
        assigner_id: Auth.profile?.id ?? null,
        added_by:    Auth.profile?.id ?? null,
        dueDate:     t.dueDate  || todayISO,
        time:        t.time     || currentTime,
        status:      'pending',
        createdAt,
        updatedAt:   createdAt
      });
    }

    return result;
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
