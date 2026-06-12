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
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    const aKey = `${a.dueDate}T${a.time || '23:59'}`;
    const bKey = `${b.dueDate}T${b.time || '23:59'}`;
    const diff = aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    return direction === 'asc' ? diff : -diff;
  });
}

function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Tasks page renderer (assigner: all tasks flat list) ───────────────────────

function renderTaskPage(tasks, nameMap = {}) {
  const main = document.getElementById('tasks-main');
  if (!main) return;

  const overdue = sortByDateTime(tasks.filter(t => getComputedStatus(t) === 'overdue'),    'asc');
  const pending = sortByDateTime(tasks.filter(t => getComputedStatus(t) === 'pending'),    'asc');
  const future  = sortByDateTime(tasks.filter(t => getComputedStatus(t) === 'future'),     'asc');
  const done    = sortByDateTime(tasks.filter(t => getComputedStatus(t) === 'completed'),  'desc');

  main.innerHTML = `
    ${overdue.length ? taskSection('Overdue',   overdue, '#ef4444', nameMap) : ''}
    ${taskSection('Pending',   pending, '#f59e0b', nameMap)}
    ${taskSection('Upcoming',  future,  '#6366f1', nameMap)}
    ${taskSection('Completed', done,    '#10b981', nameMap)}
  `;
}

function taskSection(title, tasks, color, nameMap = {}) {
  return `
    <div class="task-section">
      <div class="section-header">
        <span class="section-dot" style="background:${color}"></span>
        <span class="section-title">${title}</span>
        <span class="section-count">${tasks.length}</span>
      </div>
      <div class="section-body">
        ${tasks.length
          ? tasks.map(t => taskCardHTML(t, nameMap)).join('')
          : `<div class="empty-section">No ${title.toLowerCase()} tasks</div>`}
      </div>
    </div>
  `;
}

// nameMap: { [profile_id]: full_name } — used to display assigner/assignee names
function taskCardHTML(task, nameMap = {}) {
  const status      = getComputedStatus(task);
  const isCompleted = status === 'completed';
  const isOverdue   = status === 'overdue';
  const dateTime    = formatDateTime(task.dueDate, task.time);
  const dateLabel   = formatDate(task.dueDate);
  const isToday     = dateLabel === 'Today';

  const cardClass = isCompleted ? 'task-card--done' : isOverdue ? 'task-card--overdue' : '';
  const dateClass = isToday ? 'task-date--today' : isOverdue ? 'task-date--overdue' : '';

  const displayName = nameMap[task.assignee_id] || task.assignee || '';
  const selfAdded   = task.added_by && task.added_by === task.assignee_id;

  return `
    <div class="task-card ${cardClass}">
      <button class="check-btn ${isCompleted ? 'check-btn--checked' : ''}" data-id="${task.id}" aria-label="Toggle complete">
        ${isCompleted ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <div class="task-body">
        ${displayName ? `<div class="task-assignee">${escapeHTML(displayName)}</div>` : ''}
        <div class="task-desc ${isCompleted ? 'task-desc--done' : ''}">${escapeHTML(task.description)}</div>
        ${dateTime ? `<div class="task-date ${dateClass}">${dateTime}</div>` : ''}
        ${selfAdded ? `<div class="task-self-added">Added by assignee</div>` : ''}
      </div>
      <button class="delete-btn" data-id="${task.id}" aria-label="Delete">&#x2715;</button>
    </div>
  `;
}
