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

  const pendingCount = tasks.filter(t => ['pending', 'future'].includes(getComputedStatus(t))).length;
  const doneCount    = tasks.filter(t => getComputedStatus(t) === 'completed').length;
  const overdueCount = tasks.filter(t => getComputedStatus(t) === 'overdue').length;

  chipsEl.innerHTML = `
    <span class="stat-chip"><span class="stat-chip-dot stat-chip-dot--pending"></span>Pending ${pendingCount}</span>
    <span class="stat-chip"><span class="stat-chip-dot stat-chip-dot--done"></span>Done ${doneCount}</span>
    <span class="stat-chip"><span class="stat-chip-dot stat-chip-dot--overdue"></span>Overdue ${overdueCount}</span>
  `;

  // Overdue + due-today tasks, soonest first
  const todayTasks = sortByDateTime(tasks.filter(t => {
    const s = getComputedStatus(t);
    if (s === 'overdue') return true;
    return s === 'pending' && formatDate(t.dueDate) === 'Today';
  }), 'asc');

  listEl.innerHTML = todayTasks.length
    ? `<div class="card-list">${todayTasks.map(t => taskCardHTML(t, nameMap)).join('')}</div>`
    : `<div class="empty-section">Nothing due today — tap the mic to assign a task</div>`;
}

// ── Tasks page renderer (assigner: segmented filter + grouped by person) ──────

function renderTaskPage(tasks, nameMap = {}) {
  const main = document.getElementById('tasks-main');
  if (!main) return;

  const filter = (typeof App !== 'undefined' && App.state.taskFilter) || 'all';

  const filtered = tasks.filter(t => {
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

  return `
    <div class="task-card ${cardClass}">
      <button class="check-btn ${isCompleted ? 'check-btn--checked' : ''}" data-id="${task.id}" aria-label="Toggle complete">
        ${isCompleted ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <div class="task-body">
        <div class="task-desc ${isCompleted ? 'task-desc--done' : ''}">${escapeHTML(task.description)}</div>
        ${metaParts.length ? `<div class="task-date ${dateClass}">${metaParts.map(escapeHTML).join(' · ')}</div>` : ''}
        ${selfAdded ? `<div class="task-self-added">Added by assignee</div>` : ''}
      </div>
      <button class="delete-btn" data-id="${task.id}" aria-label="Delete">&#x2715;</button>
    </div>
  `;
}
