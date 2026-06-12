// ─────────────────────────────────────────────────────────────────────────────
//  assignee.js — Assignee "My Tasks" view
//
//  Groups tasks by assigner. Shows who assigned each task.
//  Lets the assignee add tasks manually (attributed to a chosen assigner).
// ─────────────────────────────────────────────────────────────────────────────

function renderAssigneeTasksPage(tasks, assigners, editingTaskId = null) {
  const main = document.getElementById('assignee-main');
  if (!main) return;

  if (!assigners.length) {
    main.innerHTML = `
      <div class="empty-section" style="padding:48px 20px;text-align:center;">
        <p style="font-size:32px;margin-bottom:12px;">👋</p>
        <p style="font-weight:600;margin-bottom:6px;">You're in!</p>
        <p style="color:var(--muted);font-size:14px;">Your manager will assign tasks to you soon. Check back here to see them.</p>
      </div>
    `;
    return;
  }

  const myId = Auth.profile?.id;

  // Group tasks by assigner_id
  const tasksByAssigner = {};
  for (const assigner of assigners) {
    tasksByAssigner[assigner.id] = [];
  }
  for (const task of tasks) {
    if (tasksByAssigner[task.assigner_id] !== undefined) {
      tasksByAssigner[task.assigner_id].push(task);
    }
  }

  const html = assigners.map(assigner => {
    const assignerTasks = tasksByAssigner[assigner.id] || [];
    const pending   = sortByDateTime(assignerTasks.filter(t => getComputedStatus(t) === 'pending'),   'asc');
    const overdue   = sortByDateTime(assignerTasks.filter(t => getComputedStatus(t) === 'overdue'),   'asc');
    const future    = sortByDateTime(assignerTasks.filter(t => getComputedStatus(t) === 'future'),    'asc');
    const done      = sortByDateTime(assignerTasks.filter(t => getComputedStatus(t) === 'completed'), 'desc');

    const sectionHtml = [
      ...overdue.map(t  => assigneeCardHTML(t, 'overdue',  editingTaskId)),
      ...pending.map(t  => assigneeCardHTML(t, 'pending',  editingTaskId)),
      ...future.map(t   => assigneeCardHTML(t, 'future',   editingTaskId)),
      ...done.map(t     => assigneeCardHTML(t, 'completed', editingTaskId))
    ].join('') || `<div class="empty-section">No tasks from ${escapeHTML(assigner.full_name)} yet.</div>`;

    return `
      <div class="assignee-group">
        <div class="assignee-group-header">
          <span class="assignee-group-avatar">${escapeHTML(assigner.full_name[0].toUpperCase())}</span>
          <span class="assignee-group-name">From ${escapeHTML(assigner.full_name)}</span>
          <span class="assignee-group-count">${assignerTasks.filter(t => t.status !== 'completed').length} pending</span>
        </div>
        ${sectionHtml}
      </div>
    `;
  }).join('');

  main.innerHTML = html;
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
      <div class="pipeline-edit-actions">
        <button class="pipeline-edit-save btn-primary" data-id="${task.id}">Save</button>
        <button class="pipeline-edit-cancel btn-secondary">Cancel</button>
      </div>
    </div>
  ` : '';

  return `
    <div class="assignee-task-card ${isCompleted ? 'assignee-task-card--done' : ''} ${isOverdue ? 'assignee-task-card--overdue' : ''}">
      <button class="check-btn ${isCompleted ? 'check-btn--checked' : ''}" data-id="${task.id}" aria-label="Toggle complete">
        ${isCompleted ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <div class="assignee-task-body">
        <div class="assignee-task-desc ${isCompleted ? 'assignee-task-desc--done' : ''}">${escapeHTML(task.description)}</div>
        ${dateTime ? `<div class="assignee-task-date ${isOverdue ? 'task-date--overdue' : isToday ? 'task-date--today' : ''}">${dateTime}</div>` : ''}
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
function renderAssigneeAddTaskForm(assigners) {
  if (!assigners.length) return `
    <div class="assignee-add-form">
      <p style="color:var(--muted);font-size:14px;text-align:center;padding:12px 0;">
        No managers linked yet. Ask your manager to share an invite link.
      </p>
    </div>
  `;

  const options = assigners.map(a =>
    `<option value="${a.id}">${escapeHTML(a.full_name)}</option>`
  ).join('');

  return `
    <div class="assignee-add-form" id="assignee-add-form">
      <p class="add-task-title">Add a task you received</p>
      <label class="add-task-field-label" for="add-assignee-task-for">From</label>
      <select id="add-assignee-task-for" class="add-task-input add-task-select">
        ${options}
      </select>
      <input type="text" id="add-assignee-task-desc" class="add-task-input" placeholder="Task description…" autocomplete="off"/>
      <label class="add-task-field-label" for="add-assignee-task-date">Date</label>
      <input type="date" id="add-assignee-task-date" class="add-task-date"/>
      <label class="add-task-field-label" for="add-assignee-task-time">Time</label>
      <input type="time" id="add-assignee-task-time" class="add-task-date"/>
      <button id="add-assignee-task-submit" class="add-task-btn">Add Task</button>
    </div>
  `;
}
