// ─────────────────────────────────────────────────────────────────────────────
//  tasks.js — Shared date utilities, card HTML, and task-list renderers
//  Used by both the assigner pipeline and the assignee "My Tasks" view.
// ─────────────────────────────────────────────────────────────────────────────

// ── Date utilities ────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(str + 'T00:00:00') : new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function getComputedStatus(task) {
  if (task.status === 'completed') return 'completed';
  if (task.dueDate) {
    const due = parseDate(task.dueDate);
    if (due) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (due < today) return 'overdue';
      if (due > today) return 'future';
    }
  }
  return 'pending';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = parseDate(dateStr);
  if (!d) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d.getTime() === today.getTime()) return 'Today';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return '';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function formatDateTime(dateStr, timeStr) {
  const date = formatDate(dateStr);
  const time = formatTime(timeStr);
  if (!date && !time) return '';
  return time ? `${date} · ${time}` : date;
}

function formatCreatedAt(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return formatDateTime(ds, ts);
}

function sortByDateTime(tasks, direction = 'asc') {
  return [...tasks].sort((a, b) => {
    // Urgent always floats above non-urgent within the same section
    const aU = a.priority === 'urgent' ? 1 : 0;
    const bU = b.priority === 'urgent' ? 1 : 0;
    if (aU !== bU) return bU - aU;

    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    const aKey = `${a.dueDate}T${a.time || '23:59'}`;
    const bKey = `${b.dueDate}T${b.time || '23:59'}`;
    const diff = aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    return direction === 'asc' ? diff : -diff;
  });
}

// Personal task = user is both assigner and assignee. Hidden from every view
// except the Me chip on Team / My Tasks.
function isPersonalTask(t, userId) {
  return userId && t.assigner_id === userId && t.assignee_id === userId;
}

// ── Recurrence helpers ────────────────────────────────────────────────────────

const RECURRENCE_OPTIONS = [
  { value: 'none',         label: 'Never' },
  { value: 'hourly',       label: 'Hourly' },
  { value: 'daily',        label: 'Daily' },
  { value: 'weekdays',     label: 'Weekdays' },
  { value: 'weekends',     label: 'Weekends' },
  { value: 'weekly',       label: 'Weekly' },
  { value: 'fortnightly',  label: 'Fortnightly' },
  { value: 'monthly',      label: 'Monthly' },
  { value: 'quarterly',    label: 'Every 3 months' },
  { value: 'biannually',   label: 'Every 6 months' },
  { value: 'yearly',       label: 'Yearly' },
  { value: 'custom',       label: 'Custom…' }
];

const WEEKDAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
const WEEKDAY_NAMES_SHORT = { sun:'Sun', mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat' };

// Coerce/validate a possibly-malformed rule into the canonical shape.
function normalizeRecurrenceRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const interval = Math.max(1, Math.floor(Number(rule.interval) || 1));
  const unit = ['days','weeks','months','years'].includes(rule.unit) ? rule.unit : 'days';
  const byDays = Array.isArray(rule.byDays)
    ? rule.byDays.filter(d => WEEKDAY_KEYS.includes(d))
    : [];
  const endType = ['never','on','count'].includes(rule.endType) ? rule.endType : 'never';
  const endDate = endType === 'on' && typeof rule.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rule.endDate) ? rule.endDate : null;
  const endCount = endType === 'count' ? Math.max(1, Math.floor(Number(rule.endCount) || 1)) : null;
  return { interval, unit, byDays: unit === 'weeks' ? byDays : [], endType, endDate, endCount };
}

function recurrenceLabel(value, rule) {
  if (value !== 'custom') {
    const found = RECURRENCE_OPTIONS.find(o => o.value === value);
    return found && value !== 'custom' ? found.label : '';
  }
  const r = normalizeRecurrenceRule(rule);
  if (!r) return 'Custom';
  const unitWord = r.interval === 1
    ? { days: 'day', weeks: 'week', months: 'month', years: 'year' }[r.unit]
    : r.unit;
  let label = r.interval === 1 ? `Every ${unitWord}` : `Every ${r.interval} ${unitWord}`;
  if (r.unit === 'weeks' && r.byDays.length) {
    const days = r.byDays
      .slice()
      .sort((a, b) => WEEKDAY_KEYS.indexOf(a) - WEEKDAY_KEYS.indexOf(b))
      .map(d => WEEKDAY_NAMES_SHORT[d])
      .join(', ');
    label += ` on ${days}`;
  }
  if (r.endType === 'on' && r.endDate)        label += ` until ${r.endDate}`;
  else if (r.endType === 'count' && r.endCount) label += ` (${r.endCount} left)`;
  return label;
}

function _pad2(n) { return String(n).padStart(2, '0'); }
function _fmtDateISO(d) { return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`; }

function _addMonthsClamp(date, count) {
  const originalDay = date.getDate();
  date.setMonth(date.getMonth() + count);
  // Jan 31 → Feb has no 31st → JS rolls to Mar 3. Detect and clamp to last day of target month.
  if (date.getDate() !== originalDay) date.setDate(0);
}

// Given a task that just completed, compute the next instance's dueDate + time.
// Returns null if recurrence === 'none', the chain has ended (custom + endType cutoff),
// or unknown.
// For custom recurrence, returns { dueDate, time, ruleUpdate } where ruleUpdate is the
// rule to attach to the spawned instance (e.g. endCount decremented). For presets the
// return is { dueDate, time, ruleUpdate: null }.
// Anchored to max(today, originalDueDate) so a late-completed task doesn't fire
// catch-up reminders for missed days.
function nextDueDateForRecurrence(currentDueDate, currentTime, recurrence, rule) {
  if (!recurrence || recurrence === 'none') return null;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = parseDate(currentDueDate);
  const anchorMs = Math.max(today.getTime(), due ? due.getTime() : today.getTime());
  const next = new Date(anchorMs);
  let nextTime = currentTime || '';

  switch (recurrence) {
    case 'hourly': {
      const [h, m] = (currentTime || '00:00').split(':').map(Number);
      next.setHours((isNaN(h) ? 0 : h), (isNaN(m) ? 0 : m), 0, 0);
      next.setHours(next.getHours() + 1);
      nextTime = `${_pad2(next.getHours())}:${_pad2(next.getMinutes())}`;
      break;
    }
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekdays': {
      next.setDate(next.getDate() + 1);
      const day = next.getDay();
      if (day === 6)       next.setDate(next.getDate() + 2); // Sat → Mon
      else if (day === 0)  next.setDate(next.getDate() + 1); // Sun → Mon
      break;
    }
    case 'weekends': {
      next.setDate(next.getDate() + 1);
      const day = next.getDay();
      if (day >= 1 && day <= 5) next.setDate(next.getDate() + (6 - day)); // Mon-Fri → Sat
      break;
    }
    case 'weekly':       next.setDate(next.getDate() + 7);  break;
    case 'fortnightly':  next.setDate(next.getDate() + 14); break;
    case 'monthly':      _addMonthsClamp(next, 1);  break;
    case 'quarterly':    _addMonthsClamp(next, 3);  break;
    case 'biannually':   _addMonthsClamp(next, 6);  break;
    case 'yearly':       next.setFullYear(next.getFullYear() + 1); break;
    case 'custom': {
      const r = normalizeRecurrenceRule(rule);
      if (!r) return null;
      const advance = _advanceCustom(next, r);
      if (!advance) return null;
      // End conditions
      if (r.endType === 'on' && r.endDate) {
        const endMs = parseDate(r.endDate)?.getTime() ?? null;
        if (endMs !== null && advance.getTime() > endMs) return null;
      }
      let ruleUpdate = r;
      if (r.endType === 'count') {
        // r.endCount is the number of REMAINING occurrences including the one
        // that just completed. So the spawned instance gets endCount - 1.
        // When that hits 0 we stop the chain.
        const remaining = (r.endCount || 0) - 1;
        if (remaining < 1) return null;
        ruleUpdate = { ...r, endCount: remaining };
      }
      return { dueDate: _fmtDateISO(advance), time: nextTime, ruleUpdate };
    }
    default: return null;
  }

  return { dueDate: _fmtDateISO(next), time: nextTime, ruleUpdate: null };
}

// Advance `next` by one custom-rule step. For weeks with byDays, walks to the
// next matching weekday within the interval. Mutates next? No — returns a new
// Date so caller's anchor stays clean.
function _advanceCustom(start, rule) {
  const d = new Date(start.getTime());
  if (rule.unit === 'days')  { d.setDate(d.getDate() + rule.interval); return d; }
  if (rule.unit === 'months') { _addMonthsClamp(d, rule.interval); return d; }
  if (rule.unit === 'years')  { d.setFullYear(d.getFullYear() + rule.interval); return d; }
  if (rule.unit === 'weeks') {
    if (!rule.byDays.length) {
      d.setDate(d.getDate() + 7 * rule.interval);
      return d;
    }
    // With byDays: find the next matching weekday. If there's a remaining
    // matching day in the current week, jump to it. Else jump `interval` weeks
    // forward to the earliest matching day in that target week.
    const wanted = rule.byDays.map(k => WEEKDAY_KEYS.indexOf(k)).filter(i => i >= 0);
    if (!wanted.length) { d.setDate(d.getDate() + 7 * rule.interval); return d; }
    const startDow = d.getDay();
    const sameWeek = wanted.filter(i => i > startDow).sort((a,b)=>a-b)[0];
    if (sameWeek !== undefined) {
      d.setDate(d.getDate() + (sameWeek - startDow));
      return d;
    }
    // Move to the start (Sun) of the target week N intervals away, then to the earliest wanted day
    const daysToSunday = (7 - startDow) % 7 || 7; // next Sunday (skip same week's Sunday)
    d.setDate(d.getDate() + daysToSunday + 7 * (rule.interval - 1));
    const earliest = wanted.slice().sort((a,b)=>a-b)[0];
    d.setDate(d.getDate() + earliest);
    return d;
  }
  return null;
}

// ── Subtask + notes helpers ──────────────────────────────────────────────────

function safeSubtasks(task) {
  return Array.isArray(task?.subtasks) ? task.subtasks : [];
}

function subtaskProgress(task) {
  const list = safeSubtasks(task);
  if (!list.length) return null;
  const done = list.filter(s => s.done).length;
  return { done, total: list.length };
}

// Reusable HTML for subtask checklist (shown nested under parent description).
function subtasksHTML(task) {
  const list = safeSubtasks(task);
  if (!list.length) return '';
  return `
    <ul class="task-subtasks">
      ${list.map(s => `
        <li class="subtask-row">
          <input type="checkbox" class="subtask-check" data-task-id="${task.id}" data-subtask-id="${s.id}" ${s.done ? 'checked' : ''}/>
          <span class="subtask-text ${s.done ? 'subtask-text--done' : ''}">${escapeHTML(s.text)}</span>
        </li>
      `).join('')}
    </ul>
  `;
}

// HTML block used in BOTH the Type sheet (creation) and inline edit form (editing).
// Renders: notes textarea + subtasks list (with delete X buttons) + add-row + Break into Steps button.
// idPrefix isolates input IDs for parallel forms (e.g. 'add' vs 'edit-<taskId>').
function notesAndSubtasksFormHTML(task, idPrefix) {
  const notes = task?.notes ?? '';
  const list  = safeSubtasks(task);
  const rows = list.map(s => `
    <div class="subtask-edit-row" data-subtask-id="${s.id}">
      <input type="checkbox" class="subtask-edit-check" ${s.done ? 'checked' : ''}/>
      <input type="text" class="subtask-edit-text" value="${escapeHTML(s.text)}"/>
      <button type="button" class="subtask-edit-remove" aria-label="Remove subtask">&#x2715;</button>
    </div>
  `).join('');

  return `
    <label class="add-task-field-label">Notes (optional)</label>
    <textarea id="${idPrefix}-notes" class="add-task-input add-task-notes" rows="3"
      placeholder="Extra context — amounts, addresses, agenda…">${escapeHTML(notes)}</textarea>

    <label class="add-task-field-label">Subtasks (optional)</label>
    <div id="${idPrefix}-subtasks" class="subtask-edit-list" data-task-id="${task?.id ?? ''}">${rows}</div>
    <div class="subtask-add-row">
      <input type="text" id="${idPrefix}-subtask-new" class="add-task-input subtask-add-input" placeholder="Add a subtask…"/>
      <button type="button" class="subtask-add-btn" data-target="${idPrefix}-subtasks">+ Add</button>
    </div>
    <button type="button" class="break-into-steps-btn" data-target="${idPrefix}-subtasks">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
        <polyline points="12 19 5 12 12 5"/><polyline points="19 19 12 12 19 5"/>
      </svg>
      Break into steps with AI
    </button>
  `;
}

// Read subtasks back out of a rendered notesAndSubtasksFormHTML block.
// Returns the JSON-ready array: [{id, text, done}, ...]. Empty-text rows are dropped.
function readSubtasksFromForm(containerEl) {
  if (!containerEl) return [];
  return Array.from(containerEl.querySelectorAll('.subtask-edit-row')).map(row => ({
    id:   row.dataset.subtaskId || crypto.randomUUID(),
    text: row.querySelector('.subtask-edit-text').value.trim(),
    done: row.querySelector('.subtask-edit-check').checked
  })).filter(s => s.text.length > 0);
}

// ── Custom recurrence rule builder ───────────────────────────────────────────

// HTML for the inline Custom rule builder. Shown/hidden by toggling a class
// on the wrapper based on the parent <select> value. idPrefix isolates IDs
// when multiple forms (e.g. add + edit) exist on the page.
function customRuleFormHTML(rule, idPrefix) {
  const r = normalizeRecurrenceRule(rule) || {
    interval: 1, unit: 'days', byDays: [], endType: 'never', endDate: null, endCount: null
  };
  const unitOpts = ['days','weeks','months','years']
    .map(u => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${u}</option>`)
    .join('');
  const dayPills = WEEKDAY_KEYS.map(k => `
    <button type="button" class="custom-recur-daypill ${r.byDays.includes(k) ? 'is-on' : ''}" data-day="${k}">
      ${WEEKDAY_NAMES_SHORT[k][0]}
    </button>
  `).join('');
  return `
    <div id="${idPrefix}-custom-recur" class="custom-recur-block" data-prefix="${idPrefix}">
      <div class="custom-recur-row">
        <span>Every</span>
        <input type="number" min="1" max="999" id="${idPrefix}-custom-interval"
          class="custom-recur-interval" value="${r.interval}"/>
        <select id="${idPrefix}-custom-unit" class="custom-recur-unit">${unitOpts}</select>
      </div>

      <div class="custom-recur-bydays ${r.unit === 'weeks' ? '' : 'is-hidden'}" id="${idPrefix}-custom-bydays-wrap">
        <label class="add-task-field-label">On these days (optional)</label>
        <div class="custom-recur-daypills">${dayPills}</div>
      </div>

      <label class="add-task-field-label">End repeat</label>
      <div class="custom-recur-end">
        <label class="custom-recur-endopt">
          <input type="radio" name="${idPrefix}-custom-end" value="never" ${r.endType === 'never' ? 'checked' : ''}/>
          <span>Never</span>
        </label>
        <label class="custom-recur-endopt">
          <input type="radio" name="${idPrefix}-custom-end" value="on" ${r.endType === 'on' ? 'checked' : ''}/>
          <span>On date</span>
          <input type="date" id="${idPrefix}-custom-enddate" class="custom-recur-enddate"
            value="${r.endDate || ''}" ${r.endType === 'on' ? '' : 'disabled'}/>
        </label>
        <label class="custom-recur-endopt">
          <input type="radio" name="${idPrefix}-custom-end" value="count" ${r.endType === 'count' ? 'checked' : ''}/>
          <span>After</span>
          <input type="number" min="1" max="999" id="${idPrefix}-custom-endcount" class="custom-recur-endcount"
            value="${r.endCount || ''}" ${r.endType === 'count' ? '' : 'disabled'}/>
          <span>times</span>
        </label>
      </div>
    </div>
  `;
}

// Read the custom rule back out of a form. Returns null if any required field
// is missing/invalid so the caller can fall back gracefully.
function readCustomRuleFromForm(idPrefix) {
  const wrap = document.getElementById(`${idPrefix}-custom-recur`);
  if (!wrap) return null;
  const interval = Number(document.getElementById(`${idPrefix}-custom-interval`)?.value || 1);
  const unit     = document.getElementById(`${idPrefix}-custom-unit`)?.value || 'days';
  const byDays   = unit === 'weeks'
    ? Array.from(wrap.querySelectorAll('.custom-recur-daypill.is-on')).map(b => b.dataset.day)
    : [];
  const endType  = wrap.querySelector(`input[name="${idPrefix}-custom-end"]:checked`)?.value || 'never';
  const endDate  = endType === 'on'    ? (document.getElementById(`${idPrefix}-custom-enddate`)?.value || null) : null;
  const endCount = endType === 'count' ? Number(document.getElementById(`${idPrefix}-custom-endcount`)?.value || 1) : null;
  return normalizeRecurrenceRule({ interval, unit, byDays, endType, endDate, endCount });
}

// Build a new subtask-edit-row DOM node (used when user clicks + Add or after AI break-down).
function makeSubtaskRow(text = '', done = false) {
  const row = document.createElement('div');
  row.className = 'subtask-edit-row';
  row.dataset.subtaskId = crypto.randomUUID();
  row.innerHTML = `
    <input type="checkbox" class="subtask-edit-check" ${done ? 'checked' : ''}/>
    <input type="text" class="subtask-edit-text" value="${escapeHTML(text)}"/>
    <button type="button" class="subtask-edit-remove" aria-label="Remove subtask">&#x2715;</button>
  `;
  return row;
}

// Notes preview rendered on every task card. Multi-line clamp by default (2 lines);
// tap toggles the .task-notes-preview--expanded class to reveal the full text.
// Full notes always live in the DOM — CSS handles the clamp.
function notesPreviewHTML(task) {
  const notes = (task?.notes ?? '').trim();
  if (!notes) return '';
  return `
    <div class="task-notes-preview">
      <svg class="task-notes-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="task-notes-text">${escapeHTML(notes)}</span>
      <svg class="task-notes-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
  `;
}

function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Home page renderer (assigner: summary chips + today's tasks) ──────────────

function renderHomePage(tasks, nameMap = {}) {
  const digestEl = document.getElementById('home-digest');
  const chipsEl  = document.getElementById('home-chips');
  const listEl   = document.getElementById('home-tasks');
  const dateEl   = document.getElementById('home-date');

  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }
  if (!chipsEl || !listEl) return;

  const myId = Auth.profile?.id;
  const teamOnly = tasks.filter(t => !isPersonalTask(t, myId));

  const pendingCount = teamOnly.filter(t => ['pending', 'future'].includes(getComputedStatus(t))).length;
  const doneCount    = teamOnly.filter(t => getComputedStatus(t) === 'completed').length;
  const overdueCount = teamOnly.filter(t => getComputedStatus(t) === 'overdue').length;

  chipsEl.innerHTML = `
    <span class="stat-chip"><span class="stat-chip-dot stat-chip-dot--pending"></span>Pending ${pendingCount}</span>
    <span class="stat-chip"><span class="stat-chip-dot stat-chip-dot--done"></span>Done ${doneCount}</span>
    <span class="stat-chip"><span class="stat-chip-dot stat-chip-dot--overdue"></span>Overdue ${overdueCount}</span>
  `;

  // AI digest card — populated asynchronously by App._refreshHomeDigest()
  if (digestEl) {
    const cache = (typeof App !== 'undefined' ? App.state.homeDigest : null);
    digestEl.innerHTML = renderDigestCard(cache, { pendingCount, overdueCount });
  }

  // Today's pending tasks (urgent first via shared sort)
  const todayTasks = sortByDateTime(
    teamOnly.filter(t => getComputedStatus(t) === 'pending' && formatDate(t.dueDate) === 'Today'),
    'asc'
  );

  listEl.innerHTML = todayTasks.length
    ? `<div class="card-list">${todayTasks.map(t => taskCardHTML(t, nameMap)).join('')}</div>`
    : `<div class="empty-section">Nothing due today — tap the mic to assign a task</div>`;
}

// ── Daily digest card (LLM summary fetched via send-daily-digest Edge Function) ─
function renderDigestCard(state, counts) {
  // state shape: null | { summary, todayCount, overdueCount, urgentCount, generatedAt, loading, error }
  const greeting = digestGreeting();

  if (!state) {
    return `
      <div class="digest-card digest-card--loading">
        <p class="digest-greeting">${escapeHTML(greeting)}, ${escapeHTML(digestFirstName())}.</p>
        <p class="digest-body digest-body--loading">Reading the day…</p>
      </div>
    `;
  }

  if (state.loading) {
    return `
      <div class="digest-card digest-card--loading">
        <p class="digest-greeting">${escapeHTML(greeting)}, ${escapeHTML(digestFirstName())}.</p>
        <p class="digest-body digest-body--loading">Reading the day…</p>
      </div>
    `;
  }

  // Fallback summary if Groq is unreachable: build from counts
  let body = state.summary;
  if (!body) {
    const c = counts || { pendingCount: 0, overdueCount: 0 };
    if ((c.pendingCount || 0) === 0 && (c.overdueCount || 0) === 0) {
      body = 'Nothing on deck. Quiet day.';
    } else {
      body = `${c.pendingCount} pending${c.overdueCount ? `, ${c.overdueCount} overdue` : ''}.`;
    }
  }

  const ageLine = state.generatedAt
    ? `<span class="digest-meta">${escapeHTML(formatRelativeAge(state.generatedAt))}</span>`
    : '';

  return `
    <div class="digest-card">
      <p class="digest-greeting">${escapeHTML(greeting)}, ${escapeHTML(digestFirstName())}.</p>
      <p class="digest-body">${escapeHTML(body)}</p>
      <div class="digest-footer">
        ${ageLine}
        <button id="home-digest-refresh" class="digest-refresh" type="button" aria-label="Refresh briefing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Refresh
        </button>
      </div>
    </div>
  `;
}

function digestGreeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Late night';
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Night';
}

function digestFirstName() {
  const full = (Auth.profile?.full_name || '').trim();
  if (!full) return 'there';
  return full.split(/\s+/)[0];
}

function formatRelativeAge(iso) {
  try {
    const then = new Date(iso).getTime();
    const diffMin = Math.floor((Date.now() - then) / 60000);
    if (diffMin < 1)   return 'just now';
    if (diffMin < 60)  return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    return `${Math.floor(diffMin / 1440)}d ago`;
  } catch { return ''; }
}

// ── Tasks page renderer (assigner: segmented filter + grouped by person) ──────

function renderTaskPage(tasks, nameMap = {}) {
  const main = document.getElementById('tasks-main');
  if (!main) return;

  const filter = (typeof App !== 'undefined' && App.state.taskFilter) || 'all';
  const myId   = Auth.profile?.id;

  const filtered = tasks.filter(t => {
    if (isPersonalTask(t, myId)) return false;  // personal tasks live on the Me chip
    const done = getComputedStatus(t) === 'completed';
    if (filter === 'pending') return !done;
    if (filter === 'done')    return done;
    return true;
  });

  const segmented = `
    <div class="segmented" id="task-segmented">
      ${[['all', 'All'], ['pending', 'Pending'], ['done', 'Done']].map(([key, label]) =>
        `<button class="seg-btn ${filter === key ? 'seg-btn--active' : ''}" data-filter="${key}">${label}</button>`
      ).join('')}
    </div>
  `;

  // Group by person
  const groups = new Map();
  for (const t of filtered) {
    const name = nameMap[t.assignee_id] || t.assignee || 'Unassigned';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(t);
  }

  const body = groups.size
    ? [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, list]) => `
          <div class="person-group">
            <div class="person-group-header">
              <span class="avatar">${escapeHTML(name.trim()[0]?.toUpperCase() || '?')}</span>
              <span class="person-group-name">${escapeHTML(name)}</span>
              <span class="person-group-count">${list.length}</span>
            </div>
            <div class="card-list">
              ${sortByDateTime(list, 'asc').map(t => taskCardHTML(t, nameMap, { hideAssignee: true })).join('')}
            </div>
          </div>
        `).join('')
    : `<div class="empty-section">No ${filter === 'all' ? '' : filter + ' '}tasks yet</div>`;

  main.innerHTML = segmented + body;
}

// nameMap: { [profile_id]: full_name } — used to display assigner/assignee names
function taskCardHTML(task, nameMap = {}, opts = {}) {
  const status      = getComputedStatus(task);
  const isCompleted = status === 'completed';
  const isOverdue   = status === 'overdue';
  const dateTime    = formatDateTime(task.dueDate, task.time);
  const dateLabel   = formatDate(task.dueDate);
  const isToday     = dateLabel === 'Today';

  const cardClass = isCompleted ? 'task-card--done' : isOverdue ? 'task-card--overdue' : '';
  const dateClass = isToday ? 'task-date--today' : isOverdue ? 'task-date--overdue' : '';

  const displayName = opts.hideAssignee ? '' : (nameMap[task.assignee_id] || task.assignee || '');
  const selfAdded   = task.added_by && task.added_by === task.assignee_id;
  const metaParts   = [displayName, dateTime].filter(Boolean);

  const createdLabel = formatCreatedAt(task.createdAt);
  const recurLabel   = recurrenceLabel(task.recurrence, task.recurrence_rule);
  const urgentMark   = task.priority === 'urgent' ? '<span class="task-urgent-mark" title="Urgent">!</span>' : '';
  const progress     = subtaskProgress(task);
  const progressBadge = progress ? `<span class="subtask-progress">${progress.done}/${progress.total}</span>` : '';

  return `
    <div class="task-card ${cardClass}">
      <button class="check-btn ${isCompleted ? 'check-btn--checked' : ''}" data-id="${task.id}" aria-label="Toggle complete">
        ${isCompleted ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <div class="task-body">
        <div class="task-desc ${isCompleted ? 'task-desc--done' : ''}">${urgentMark}${escapeHTML(task.description)}${progressBadge}</div>
        ${metaParts.length ? `<div class="task-date ${dateClass}">${metaParts.map(escapeHTML).join(' · ')}</div>` : ''}
        ${notesPreviewHTML(task)}
        ${subtasksHTML(task)}
        ${recurLabel ? `<div class="task-recur-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="10" height="10"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>${escapeHTML(recurLabel)}</div>` : ''}
        ${createdLabel ? `<div class="task-added-at">Added ${escapeHTML(createdLabel)}</div>` : ''}
        ${selfAdded ? `<div class="task-self-added">Added by assignee</div>` : ''}
      </div>
      <button class="delete-btn" data-id="${task.id}" aria-label="Delete">&#x2715;</button>
    </div>
  `;
}
