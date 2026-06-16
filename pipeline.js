// ─────────────────────────────────────────────────────────────────────────────
//  pipeline.js — Assigner pipeline view (person tabs + task lists)
//
//  Key differences from v1:
//  - Tabs come from confirmed team (assigner_assignee_map) + pending invites
//  - Tasks are scoped to the active assigner via RLS (no extra filter needed)
//  - "+ Add Person" opens invite flow instead of plain name form
//  - nameMap { [id]: full_name } is used for display
// ─────────────────────────────────────────────────────────────────────────────

function renderPipelinePage(tasks, activePersonId, editMode, showAddPerson, pinnedIds, editingTaskId, team, pendingInvites, nameMap) {
  const tabsEl    = document.getElementById('pipeline-tabs');
  const addAreaEl = document.getElementById('add-person-area');
  const mainEl    = document.getElementById('pipeline-main');

  const pinnedSet = new Set(pinnedIds);
  const myId      = Auth.profile?.id;

  // "Me" is a synthetic chip representing personal tasks (assigner=me, assignee=me).
  // It's always first, can't be pinned, can't be removed.
  const meEntry = { id: myId, full_name: 'Me', _isMe: true };

  // Build ordered list: Me first, then pinned, then rest alphabetically
  const pinnedTeam  = pinnedIds.filter(id => team.some(m => m.id === id)).map(id => team.find(m => m.id === id));
  const unpinned    = team.filter(m => !pinnedSet.has(m.id)).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const orderedTeam = [meEntry, ...pinnedTeam, ...unpinned];

  // ── Resolve active person ──────────────────────────────────────────────────
  const allIds = [...orderedTeam.map(m => m.id), ...pendingInvites.map(i => 'invite_' + i.id)];
  const personId = allIds.includes(activePersonId) ? activePersonId : myId;

  // ── Tab strip ──────────────────────────────────────────────────────────────
  const confirmedTabs = orderedTeam.map(member => {
    const isMe     = !!member._isMe;
    const isPinned = !isMe && pinnedSet.has(member.id);
    const pinIcon  = isPinned
      ? `<svg class="tab-pin-icon" viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
           <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H18v-2c-1.66 0-3-1.34-3-3z"/>
         </svg>`
      : '';
    const initial = escapeHTML((isMe ? 'M' : (member.full_name.trim()[0]?.toUpperCase() || '?')));
    return `
      <div class="tab-wrapper">
        <button class="person-tab ${member.id === personId ? 'person-tab--active' : ''}"
                data-person-id="${member.id}">
          <span class="tab-avatar">${initial}</span>${pinIcon}${escapeHTML(member.full_name)}
        </button>
        ${editMode && !isMe ? `<button class="tab-delete-btn" data-person-id="${member.id}" aria-label="Remove ${escapeHTML(member.full_name)}">&#x2715;</button>` : ''}
      </div>
    `;
  }).join('');

  const pendingTabs = pendingInvites.map(inv => {
    const initial = escapeHTML(inv.name.trim()[0]?.toUpperCase() || '?');
    return `
    <div class="tab-wrapper">
      <button class="person-tab person-tab--pending ${('invite_' + inv.id) === personId ? 'person-tab--active' : ''}"
              data-invite-id="${inv.id}">
        <span class="tab-avatar">${initial}</span>${escapeHTML(inv.name)}
        <span class="tab-pending-badge">Invited</span>
      </button>
      ${editMode ? `<button class="tab-delete-btn" data-invite-id="${inv.id}" aria-label="Cancel invite for ${escapeHTML(inv.name)}">&#x2715;</button>` : ''}
    </div>
  `;
  }).join('');

  tabsEl.innerHTML = confirmedTabs + pendingTabs +
    `<button class="add-person-tab-btn" id="add-person-btn">+ Invite</button>`;

  // ── Invite form (between tabs and main) ───────────────────────────────────
  addAreaEl.innerHTML = renderInviteForm(showAddPerson);

  // ── Pending invite panel ───────────────────────────────────────────────────
  if (personId && personId.startsWith('invite_')) {
    const invId = personId.replace('invite_', '');
    const inv   = pendingInvites.find(i => i.id === invId);
    if (inv) {
      mainEl.innerHTML = renderPendingPanel(inv);
      return personId;
    }
  }

  // ── Confirmed team member tasks (or personal tasks when Me is active) ─────
  const member      = orderedTeam.find(m => m.id === personId);
  const isMeActive  = !!member?._isMe;
  const personTasks = isMeActive
    ? tasks.filter(t => t.assigner_id === myId && t.assignee_id === myId)
    : tasks.filter(t => t.assignee_id === personId || (!t.assignee_id && t.assignee === member?.full_name));

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  // Use the shared sortByDateTime helper — it already sorts urgent first then date.
  const sortAsc  = arr => sortByDateTime(arr, 'asc');
  const sortDesc = arr => sortByDateTime(arr, 'desc');

  const groupOverdue  = [], groupToday = [], groupUpcoming = [], groupNoDate = [], groupDone = [];

  for (const task of personTasks) {
    if (task.status === 'completed') { groupDone.push(task); continue; }
    if (!task.dueDate) { groupNoDate.push(task); continue; }
    const due = new Date(task.dueDate + 'T00:00:00');
    if (isNaN(due)) { groupNoDate.push(task); continue; }
    if (due < today) groupOverdue.push(task);
    else if (due.getTime() === today.getTime()) groupToday.push(task);
    else groupUpcoming.push(task);
  }

  function pipelineSection(label, cls, list, emptyMsg) {
    if (!list.length && emptyMsg === null) return '';
    return `
      <div class="pipeline-section-header pipeline-section-header--${cls}">${label}</div>
      ${list.map(t => pipelineCardHTML(t, editMode, editingTaskId)).join('')
        || (emptyMsg ? `<div class="empty-section">${emptyMsg}</div>` : '')}
    `;
  }

  const sectionsHTML = [
    pipelineSection('Overdue',  'overdue',  sortAsc(groupOverdue),  null),
    pipelineSection('Today',    'today',    sortAsc(groupToday),    null),
    pipelineSection('Upcoming', 'upcoming', sortAsc(groupUpcoming), null),
    pipelineSection('No Date',  'nodate',   groupNoDate,            null),
    pipelineSection('Done',     'done',     sortDesc(groupDone),    null),
  ].join('');

  const emptyMsg = isMeActive
    ? 'No personal tasks yet. Tap + to add one.'
    : 'No tasks for this person yet. Tap + to add one.';
  mainEl.innerHTML = sectionsHTML || `<div class="empty-section">${emptyMsg}</div>`;
  return personId;
}

// ── Single pipeline card ───────────────────────────────────────────────────────
function pipelineCardHTML(task, editMode, editingTaskId) {
  const status      = getComputedStatus(task);
  const isCompleted = status === 'completed';
  const isOverdue   = status === 'overdue';
  const dateTime    = formatDateTime(task.dueDate, task.time);
  const dateLabel   = formatDate(task.dueDate);
  const isToday     = dateLabel === 'Today';
  const isEditing   = editingTaskId === task.id;
  const selfAdded   = task.added_by && task.added_by === task.assignee_id;

  const editBtnHTML = editMode
    ? `<button class="pipeline-task-edit-btn" data-id="${task.id}" aria-label="Edit task">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
       </button>`
    : '';

  const deleteBtnHTML = editMode
    ? `<button class="pipeline-task-delete-btn" data-id="${task.id}" aria-label="Delete task">&#x2715;</button>`
    : '';

  const editRecurOpts = RECURRENCE_OPTIONS.map(o =>
    `<option value="${o.value}" ${task.recurrence === o.value ? 'selected' : ''}>${escapeHTML(o.label)}</option>`
  ).join('');
  const editFormHTML = isEditing ? `
    <div class="pipeline-edit-form">
      <input type="text" class="pipeline-edit-desc" value="${escapeHTML(task.description)}"/>
      <div class="pipeline-edit-row">
        <input type="date" class="pipeline-edit-date" value="${task.dueDate || ''}"/>
        <input type="time" class="pipeline-edit-time" value="${task.time || ''}"/>
      </div>
      <label class="add-task-field-label" for="edit-${task.id}-recurrence">Repeat</label>
      <select id="edit-${task.id}-recurrence" class="add-task-input add-task-select pipeline-edit-recurrence" data-custom-wrap="edit-${task.id}-custom-recur">${editRecurOpts}</select>
      <div class="custom-recur-wrap ${task.recurrence === 'custom' ? '' : 'is-hidden'}" id="edit-${task.id}-custom-recur-wrap">${customRuleFormHTML(task.recurrence_rule, `edit-${task.id}`)}</div>
      <label class="pipeline-edit-urgent-row">
        <input type="checkbox" class="pipeline-edit-urgent" ${task.priority === 'urgent' ? 'checked' : ''}/>
        Mark as urgent
      </label>
      ${notesAndSubtasksFormHTML(task, `edit-${task.id}`)}
      <div class="pipeline-edit-actions">
        <button class="pipeline-edit-save btn-primary" data-id="${task.id}">Save</button>
        <button class="pipeline-edit-cancel btn-secondary">Cancel</button>
      </div>
    </div>
  ` : '';

  const createdLabel = formatCreatedAt(task.createdAt);
  const recurLabel   = recurrenceLabel(task.recurrence, task.recurrence_rule);
  const urgentMark   = task.priority === 'urgent' ? '<span class="task-urgent-mark" title="Urgent">!</span>' : '';
  const progress     = subtaskProgress(task);
  const progressBadge = progress ? `<span class="subtask-progress">${progress.done}/${progress.total}</span>` : '';

  return `
    <div class="pipeline-card ${isOverdue ? 'pipeline-card--overdue' : ''}">
      <button class="check-btn ${isCompleted ? 'check-btn--checked' : ''}" data-id="${task.id}" aria-label="Toggle complete">
        ${isCompleted ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <div class="pipeline-card-info">
        <div class="pipeline-card-desc ${isCompleted ? 'pipeline-card-desc--done' : ''}">${urgentMark}${escapeHTML(task.description)}${progressBadge}</div>
        ${dateTime ? `<div class="pipeline-card-date ${isOverdue ? 'pipeline-card-date--overdue' : isToday ? 'pipeline-card-date--today' : ''}">${dateTime}</div>` : ''}
        ${notesPreviewHTML(task)}
        ${subtasksHTML(task)}
        ${recurLabel ? `<div class="task-recur-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="10" height="10"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>${escapeHTML(recurLabel)}</div>` : ''}
        ${createdLabel ? `<div class="task-added-at">Added ${escapeHTML(createdLabel)}</div>` : ''}
        ${selfAdded ? `<div class="pipeline-card-self-added">Added by assignee</div>` : ''}
      </div>
      ${editBtnHTML}${deleteBtnHTML}
    </div>
    ${editFormHTML}
  `;
}

// ── Pending invite panel (shown when a pending invite tab is selected) ─────────
function renderPendingPanel(invite) {
  return `
    <div class="pending-invite-panel">
      <div class="pending-invite-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="44" height="44">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
      </div>
      <p class="pending-invite-name">${escapeHTML(invite.name)}</p>
      <p class="pending-invite-email">${escapeHTML(invite.email)}</p>
      <p class="pending-invite-status">Invite sent — waiting for them to join</p>
      <div class="pending-invite-actions">
        <button class="pending-copy-btn" data-token="${invite.token}">Copy invite link</button>
        <button class="pending-share-btn" data-token="${invite.token}" data-name="${escapeHTML(invite.name)}">Share</button>
      </div>
    </div>
  `;
}

// ── Invite bottom sheet (shown when showAddPerson=true) ────────────────────────
function renderInviteForm(show) {
  if (!show) return '';
  return `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet add-person-form">
      <div class="sheet-grabber"></div>
      <p class="sheet-title">Invite team member</p>
      <input type="text"  id="invite-name"  class="add-task-input" placeholder="Name"  autocomplete="off"/>
      <input type="email" id="invite-email" class="add-task-input" placeholder="Email" autocomplete="off" inputmode="email"/>
      <button id="invite-submit" class="add-task-btn">Send Invite</button>
      <div id="invite-result" class="invite-result hidden"></div>
    </div>
  `;
}

// ── Pin panel (same as v1) ─────────────────────────────────────────────────────
function renderPinPanel(show, team, pinnedIds) {
  const panel = document.getElementById('pin-select-panel');
  if (!panel) return;
  if (!show) { panel.innerHTML = ''; panel.classList.add('hidden'); return; }

  if (!team.length) {
    panel.innerHTML = `
      <div class="pin-panel-header">
        <span class="pin-panel-title">Pin People</span>
        <button id="pin-panel-close" class="pin-panel-close">&#x2715;</button>
      </div>
      <p class="pin-panel-empty">No people to pin yet.</p>
    `;
    panel.classList.remove('hidden');
    return;
  }

  const pinnedSet = new Set(pinnedIds);
  panel.innerHTML = `
    <div class="pin-panel-header">
      <span class="pin-panel-title">Pin People</span>
      <button id="pin-panel-close" class="pin-panel-close">&#x2715;</button>
    </div>
    <div class="pin-select-list">
      ${team.map(m => {
        const isPinned = pinnedSet.has(m.id);
        return `
          <button class="pin-select-item ${isPinned ? 'pin-select-item--pinned' : ''}"
                  data-pin-id="${m.id}">
            ${isPinned ? `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H18v-2c-1.66 0-3-1.34-3-3z"/></svg>` : ''}
            ${escapeHTML(m.full_name)}
          </button>
        `;
      }).join('')}
    </div>
  `;
  panel.classList.remove('hidden');
}
