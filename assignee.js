// ─────────────────────────────────────────────────────────────────────────────
//  assignee.js — Assignee "My Tasks" view
//
//  Groups tasks by assigner. Shows who assigned each task.
//  Lets the assignee add tasks manually (attributed to a chosen assigner).
// ─────────────────────────────────────────────────────────────────────────────

function renderAssigneeTasksPage(tasks, assigners, editingTaskId = null) {
  const main = document.getElementById('assignee-main');
  if (!main) return;

  const myId    = Auth.profile?.id;
  const meEntry = { id: myId, full_name: 'Me', _isMe: true };
  const allOptions = [meEntry, ...assigners];

  // Active selection (Me is a valid choice even when no managers exist)
  const stateActive = typeof App !== 'undefined' ? App.state.activeAssignerId : null;
  const activeId = allOptions.some(o => o.id === stateActive) ? stateActive : (assigners[0]?.id || myId);
  if (typeof App !== 'undefined') App.state.activeAssignerId = activeId;
  const active   = allOptions.find(o => o.id === activeId);
  const isMe     = !!active?._isMe;

  const chips = allOptions.map(a => {
    const initial = escapeHTML(a._isMe ? 'M' : (a.full_name.trim()[0]?.toUpperCase() || '?'));
    return `
      <button class="person-tab ${a.id === activeId ? 'person-tab--active' : ''}" data-assigner-id="${a.id}">
        <span class="tab-avatar">${initial}</span>${escapeHTML(a.full_name)}
      </button>
    `;
  }).join('');

  // Group active person's tasks by due status (same as the manager pipeline).
  // Me = personal tasks (assigner=me & assignee=me); else = tasks from that manager.
  const personTasks = isMe
    ? tasks.filter(t => t.assigner_id === myId && t.assignee_id === myId)
    : tasks.filter(t => t.assigner_id === activeId);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const groupOverdue = [], groupToday = [], groupUpcoming = [], groupNoDate = [], groupDone = [];
  for (const task of personTasks) {
    if (task.status === 'completed') { groupDone.push(task); continue; }
    if (!task.dueDate) { groupNoDate.push(task); continue; }
    const due = new Date(task.dueDate + 'T00:00:00');
    if (isNaN(due))                            groupNoDate.push(task);
    else if (due < today)                      groupOverdue.push(task);
    else if (due.getTime() === today.getTime()) groupToday.push(task);
    else                                       groupUpcoming.push(task);
  }

  const section = (label, cls, list, dir = 'asc') => {
    if (!list.length) return '';
    return `
      <div class="pipeline-section-header pipeline-section-header--${cls}">${label}</div>
      ${sortByDateTime(list, dir).map(t => assigneeCardHTML(t, getComputedStatus(t), editingTaskId)).join('')}
    `;
  };

  const sections = [
    section('Overdue',  'overdue',  groupOverdue),
    section('Today',    'today',    groupToday),
    section('Upcoming', 'upcoming', groupUpcoming),
    section('No Date',  'nodate',   groupNoDate),
    section('Done',     'done',     groupDone, 'desc')
  ].join('');

  const emptyMsg = isMe
    ? 'No personal tasks yet. Tap + to add one.'
    : `No tasks from ${escapeHTML(active?.full_name || 'this manager')} yet.`;
  main.innerHTML = `
    <div class="pipeline-tabs assignee-tabs">${chips}</div>
    ${sections || `<div class="empty-section">${emptyMsg}</div>`}
  `;
}

function assigneeCardHTML(task, computedStatus, editingTaskId) {
  const isCompleted = computedStatus === 'completed';
  const isOverdue   = computedStatus === 'overdue';
  const dateTime    = formatDateTime(task.dueDate, task.time);
  const dateLabel   = formatDate(task.dueDate);
  const isToday     = dateLabel === 'Today';
  const isEditing   = editingTaskId === task.id;
  const selfAdded   = task.added_by === Auth.profile?.id && task.added_by === task.assignee_id;

  const editFormHTML = isEditing ? `
    <div class="pipeline-edit-form">
      <input type="text"  class="pipeline-edit-desc" value="${escapeHTML(task.description)}"/>
      <div class="pipeline-edit-row">
        <input type="date" class="pipeline-edit-date" value="${task.dueDate || ''}"/>
        <input type="time" class="pipeline-edit-time" value="${task.time || ''}"/>
      </div>
      <label class="pipeline-edit-urgent-row">
        <input type="checkbox" class="pipeline-edit-urgent" ${task.priority === 'urgent' ? 'checked' : ''}/>
        Mark as urgent
      </label>
      <div class="pipeline-edit-actions">
        <button class="pipeline-edit-save btn-primary" data-id="${task.id}">Save</button>
        <button class="pipeline-edit-cancel btn-secondary">Cancel</button>
      </div>
    </div>
  ` : '';

  const createdLabel = formatCreatedAt(task.createdAt);
  const recurLabel   = recurrenceLabel(task.recurrence);
  const urgentMark   = task.priority === 'urgent' ? '<span class="task-urgent-mark" title="Urgent">!</span>' : '';

  return `
    <div class="assignee-task-card ${isCompleted ? 'assignee-task-card--done' : ''} ${isOverdue ? 'assignee-task-card--overdue' : ''}">
      <button class="check-btn ${isCompleted ? 'check-btn--checked' : ''}" data-id="${task.id}" aria-label="Toggle complete">
        ${isCompleted ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <div class="assignee-task-body">
        <div class="assignee-task-desc ${isCompleted ? 'assignee-task-desc--done' : ''}">${urgentMark}${escapeHTML(task.description)}</div>
        ${dateTime ? `<div class="assignee-task-date ${isOverdue ? 'task-date--overdue' : isToday ? 'task-date--today' : ''}">${dateTime}</div>` : ''}
        ${recurLabel ? `<div class="task-recur-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="10" height="10"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>${escapeHTML(recurLabel)}</div>` : ''}
        ${createdLabel ? `<div class="task-added-at">Added ${escapeHTML(createdLabel)}</div>` : ''}
        ${selfAdded ? `<div class="task-self-added">Added by you</div>` : ''}
      </div>
      <button class="assignee-edit-btn" data-id="${task.id}" aria-label="Edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
      </button>
    </div>
    ${editFormHTML}
  `;
}

// ── Add Task form (assignee adds their own task attributed to an assigner) ────
function renderAssigneeAddTaskForm(assigners, activeAssignerId) {
  const myId = Auth.profile?.id;
  const isMe = activeAssignerId === myId;

  const active = isMe
    ? { id: myId, full_name: Auth.profile?.full_name || 'Me' }
    : (assigners.find(a => a.id === activeAssignerId) || assigners[0]);

  if (!active) return `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet assignee-add-form">
      <div class="sheet-grabber"></div>
      <p style="color:var(--muted);font-size:14px;text-align:center;padding:12px 0;">
        No managers linked yet. Ask your manager to invite you.
      </p>
    </div>
  `;

  const contextLine = isMe
    ? `<p class="sheet-context">Personal task</p>`
    : `<p class="sheet-context">From <strong>${escapeHTML(active.full_name)}</strong></p>`;

  const recurOpts = RECURRENCE_OPTIONS.map(o =>
    `<option value="${o.value}">${escapeHTML(o.label)}</option>`
  ).join('');

  return `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet assignee-add-form" id="assignee-add-form">
      <div class="sheet-grabber"></div>
      <p class="sheet-title">Add a task</p>
      ${contextLine}
      <input type="text" id="add-assignee-task-desc" class="add-task-input" placeholder="Task description…" autocomplete="off"/>
      <label class="add-task-field-label" for="add-assignee-task-date">Date</label>
      <input type="date" id="add-assignee-task-date" class="add-task-date"/>
      <label class="add-task-field-label" for="add-assignee-task-time">Time</label>
      <input type="time" id="add-assignee-task-time" class="add-task-date"/>
      <label class="add-task-field-label" for="add-assignee-task-recurrence">Repeat</label>
      <select id="add-assignee-task-recurrence" class="add-task-input add-task-select">${recurOpts}</select>
      <label class="add-task-urgent-row">
        <input type="checkbox" id="add-assignee-task-urgent"/>
        <span>Mark as urgent</span>
      </label>
      <button id="add-assignee-task-submit" class="add-task-btn" data-assigner-id="${active.id}">Add Task</button>
    </div>
  `;
}
