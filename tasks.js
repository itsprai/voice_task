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
  { value: 'yearly',       label: 'Yearly' }
];

function recurrenceLabel(value) {
  const found = RECURRENCE_OPTIONS.find(o => o.value === value);
  return found ? found.label : '';
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
// Returns null if recurrence === 'none' or unknown.
// Anchored to max(today, originalDueDate) so a late-completed task doesn't fire
// catch-up reminders for missed days.
function nextDueDateForRecurrence(currentDueDate, currentTime, recurrence) {
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
    default: return null;
  }

  return { dueDate: _fmtDateISO(next), time: nextTime };
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

// Small inline clipboard icon + 1-line preview of notes.
function notesPreviewHTML(task) {
  const notes = (task?.notes ?? '').trim();
  if (!notes) return '';
  const preview = notes.length > 80 ? notes.slice(0, 78) + '…' : notes;
  return `
    <div class="task-notes-preview" title="${escapeHTML(notes)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span>${escapeHTML(preview)}</span>
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
  const chipsEl = document.getElementById('home-chips');
  const listEl  = document.getElementById('home-tasks');
  const dateEl  = document.getElementById('home-date');

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

  // Only tasks due today and still pending — done/overdue live on the Tasks page
  const todayTasks = sortByDateTime(
    teamOnly.filter(t => getComputedStatus(t) === 'pending' && formatDate(t.dueDate) === 'Today'),
    'asc'
  );

  listEl.innerHTML = todayTasks.length
    ? `<div class="card-list">${todayTasks.map(t => taskCardHTML(t, nameMap)).join('')}</div>`
    : `<div class="empty-section">Nothing due today — tap the mic to assign a task</div>`;
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
  const recurLabel   = recurrenceLabel(task.recurrence);
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
