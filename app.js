// ─────────────────────────────────────────────────────────────────────────────
//  app.js — Main application controller for TaskVoice v2
//
//  Auth routing:
//    No session        → #screen-auth
//    Session, no profile → #screen-onboarding
//    Session, assigner  → #screen-assigner-app
//    Session, assignee  → #screen-assignee-app
// ─────────────────────────────────────────────────────────────────────────────

const App = {
  state: {
    // Shared
    tasks:         [],
    // Assigner-specific
    team:          [],   // [{ id, full_name }]
    pendingInvites:[],
    nameMap:       {},   // { [id]: full_name }
    activePersonId: null,
    pipelineEditMode: false,
    pipelinePinMode:  false,
    showAddPerson:    false,
    editingTaskId:    null,
    pinnedIds: (() => {
      try { return JSON.parse(localStorage.getItem('vtm_v2_pinned') || '[]'); } catch { return []; }
    })(),
    currentPage: 'home',
    taskFilter: 'all',
    voiceContext: 'general',
    // Assignee-specific
    assigners:     [],   // [{ id, full_name }]
    activeAssignerId: null,
    editingAssigneeTaskId: null,
    showAssigneeAddForm: false,
    // Invite token from URL (set before auth resolves)
    pendingInviteToken: null
  },

  // Guards: auth fires SIGNED_IN/TOKEN_REFRESHED repeatedly — booting more
  // than once would stack duplicate event listeners (every click/voice action
  // would then fire N times, creating duplicate tasks)
  _booted: false,
  _assignerUIBound: false,
  _assigneeUIBound: false,

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  async init() {
    // Capture invite token from URL first; fall back to sessionStorage which
    // survives the magic-link redirect (the redirect wipes ?invite= from the URL)
    this.state.pendingInviteToken =
      Invite.getTokenFromURL() ||
      sessionStorage.getItem('vtm_pending_invite') ||
      null;
    sessionStorage.removeItem('vtm_pending_invite');

    // Auth listener fires for SIGNED_IN (magic link callback) and SIGNED_OUT
    document.addEventListener('auth:signed-in',  () => this._onSignedIn());
    document.addEventListener('auth:signed-out', () => this._onSignedOut());

    // Settings gear opens the settings sheet (replaces the bell + signout buttons)
    ['assigner-settings-btn', 'assignee-settings-btn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this._openSettings());
    });

    // Single delegated handler for sheet interactions (open or closed safely)
    document.body.addEventListener('click', async e => {
      if (e.target.closest('[data-close-settings]')) {
        this._closeSettings();
        return;
      }
      if (e.target.closest('#settings-signout-btn')) {
        this._closeSettings();
        if (!confirm('Sign out?')) return;
        try { await Auth.signOut(); } catch (err) { console.warn('Sign out error:', err); }
        this._booted = false;
        this._resetAuthScreen();
        this._showScreen('auth');
        return;
      }

      // ─ Subtask interactions ────────────────────────────────────────
      // Toggle a subtask checkbox on a rendered task card
      const subCheck = e.target.closest('.subtask-check');
      if (subCheck) {
        this._toggleSubtaskOnCard(subCheck.dataset.taskId, subCheck.dataset.subtaskId);
        return;
      }
      // Remove a subtask row inside an editor (Type sheet or inline edit form)
      const removeBtn = e.target.closest('.subtask-edit-remove');
      if (removeBtn) {
        removeBtn.closest('.subtask-edit-row')?.remove();
        return;
      }
      // Click '+ Add' button next to subtask-add-input
      const addBtn = e.target.closest('.subtask-add-btn');
      if (addBtn) {
        this._appendSubtaskRowFromInput(addBtn);
        return;
      }
      // "Break into steps with AI"
      const breakBtn = e.target.closest('.break-into-steps-btn');
      if (breakBtn) {
        e.preventDefault();
        await this._breakIntoSteps(breakBtn);
        return;
      }
    });

    document.body.addEventListener('change', async e => {
      const t = e.target;
      if (!t || !t.id) return;

      if (t.id === 'settings-notif-enabled') {
        await this._handleNotifToggle(t);
      } else if (t.id === 'settings-daily-enabled') {
        await this._handleDailyToggle(t);
      } else if (t.id === 'settings-daily-time') {
        if (t.value) {
          await Sync.savePreference('daily_reminder_time', t.value);
          this.showToast(`Reminder time set to ${t.value}`);
        }
      }
    });

    // Enter inside a "Add a subtask…" input — add the row
    document.body.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const input = e.target.closest && e.target.closest('.subtask-add-input');
      if (!input) return;
      e.preventDefault();
      const addBtn = input.parentElement?.querySelector('.subtask-add-btn');
      if (addBtn) this._appendSubtaskRowFromInput(addBtn);
    });

    // iOS suspends standalone PWAs in the background and kills the realtime
    // socket — re-pull whenever the app returns to the foreground
    const refreshOnResume = () => {
      if (document.visibilityState === 'visible' && this._booted) this._pullAll();
    };
    document.addEventListener('visibilitychange', refreshOnResume);
    window.addEventListener('pageshow', refreshOnResume);

    const session = await Auth.init();

    if (!session) {
      // Check if we arrived via invite link → prefetch invite data for display
      if (this.state.pendingInviteToken) {
        await this._showInviteAuthScreen(this.state.pendingInviteToken);
      } else {
        this._showScreen('auth');
      }
      return;
    }

    await this._onSignedIn();
  },

  async _onSignedIn() {
    if (this._booted) return; // already running (e.g. TOKEN_REFRESHED) — realtime keeps data fresh
    const profile = await Auth.loadProfile();

    if (!profile) {
      // No profile could also mean a stale local session whose user was
      // deleted server-side — verify before offering onboarding
      if (!(await Auth.verifySession())) {
        await Auth.signOut();
        if (this.state.pendingInviteToken) {
          await this._showInviteAuthScreen(this.state.pendingInviteToken);
        } else {
          this._showScreen('auth');
        }
        return;
      }
      // New user — determine role from invite token or let them choose
      await this._showOnboarding();
      return;
    }

    if (profile.role === 'assigner') {
      await this._bootAssigner();
    } else {
      await this._bootAssignee();
    }
  },

  _onSignedOut() {
    this._booted = false;
    this._resetAuthScreen();
    this._showScreen('auth');
  },

  // Reset the auth screen to its initial email-entry state — without this,
  // the OTP form stays visible (with the previous code) on sign-out.
  _resetAuthScreen() {
    document.getElementById('auth-form-wrap')?.classList.remove('hidden');
    document.getElementById('auth-otp-wrap')?.classList.add('hidden');
    document.getElementById('auth-title')?.classList.remove('hidden');
    document.getElementById('auth-subtitle')?.classList.remove('hidden');
    const emailIn = document.getElementById('auth-email');
    const otpIn   = document.getElementById('auth-otp-input');
    const sendBtn = document.getElementById('auth-btn');
    const verifyBtn = document.getElementById('auth-otp-btn');
    if (emailIn) { emailIn.value = ''; emailIn.readOnly = false; }
    if (otpIn) otpIn.value = '';
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send Code'; }
    if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = 'Verify & Sign In'; }
    const otpEmail = document.getElementById('auth-otp-email');
    if (otpEmail) otpEmail.textContent = '';
  },

  // ── Settings sheet ─────────────────────────────────────────────────────────
  _settingsSlot() {
    return document.querySelector('.screen--active [id$="-settings-sheet-slot"]');
  },

  async _openSettings() {
    const slot = this._settingsSlot();
    if (!slot) return;
    slot.innerHTML = this._renderSettingsHTML();
    await this._loadSettingsState();
  },

  _closeSettings() {
    document.querySelectorAll('[id$="-settings-sheet-slot"]').forEach(s => s.innerHTML = '');
  },

  _renderSettingsHTML() {
    const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    const isIOS        = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const hasAPI       = 'Notification' in window;
    const denied       = hasAPI && Notification.permission === 'denied';

    let notifSub  = 'Required for any reminder push to work';
    let notifLock = false;
    if (isIOS && !isStandalone) {
      notifSub = 'Add this app to your Home Screen to enable notifications';
      notifLock = true;
    } else if (!hasAPI) {
      notifSub = 'Not supported in this browser';
      notifLock = true;
    } else if (denied) {
      notifSub = 'Blocked in browser settings — enable there first';
      notifLock = true;
    }

    return `
      <div class="sheet-backdrop" data-close-settings></div>
      <div class="sheet settings-sheet">
        <div class="sheet-grabber"></div>
        <p class="sheet-title">Settings</p>

        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-info">
              <p class="settings-row-title">Notifications</p>
              <p class="settings-row-sub">${notifSub}</p>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" id="settings-notif-enabled" ${notifLock ? 'disabled' : ''}/>
              <span class="settings-toggle-track"></span>
            </label>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-row">
            <div class="settings-row-info">
              <p class="settings-row-title">Daily reminder</p>
              <p class="settings-row-sub">One push notification each day summarizing today's pending tasks</p>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" id="settings-daily-enabled"/>
              <span class="settings-toggle-track"></span>
            </label>
          </div>
          <div class="settings-row" id="settings-daily-time-row">
            <span class="settings-row-label">Time</span>
            <input type="time" id="settings-daily-time" class="add-task-date settings-time-input" value="08:00"/>
          </div>
        </div>

        <button id="settings-signout-btn" class="settings-signout-btn">Sign out</button>
      </div>
    `;
  },

  async _loadSettingsState() {
    // Notifications toggle reflects: permission granted AND a push subscription exists
    const notifToggle = document.getElementById('settings-notif-enabled');
    if (notifToggle && !notifToggle.disabled) {
      const granted = ('Notification' in window) && Notification.permission === 'granted';
      const subbed  = granted && await Notifications.isSubscribed();
      notifToggle.checked = !!subbed;
    }

    // Daily reminder prefs
    const dailyEnabled = await Sync.loadPreference('daily_reminder_enabled');
    const dailyTime    = await Sync.loadPreference('daily_reminder_time');
    const enabledEl    = document.getElementById('settings-daily-enabled');
    const timeEl       = document.getElementById('settings-daily-time');
    const timeRow      = document.getElementById('settings-daily-time-row');
    if (enabledEl) enabledEl.checked = dailyEnabled === '1';
    if (timeEl)    timeEl.value      = dailyTime || '08:00';
    if (timeRow)   timeRow.classList.toggle('hidden', dailyEnabled !== '1');
  },

  async _handleNotifToggle(input) {
    if (input.checked) {
      if (!('Notification' in window)) { input.checked = false; return; }
      if (Notification.permission === 'denied') {
        input.checked = false;
        this.showToast('Notifications blocked in browser settings', true);
        return;
      }
      let perm = Notification.permission;
      if (perm !== 'granted') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        input.checked = false;
        this.showToast(perm === 'denied' ? 'Notifications blocked in browser settings' : 'Permission needed', true);
        return;
      }
      await Notifications._subscribePush();
      this.showToast('Notifications enabled');
    } else {
      await Notifications.unsubscribe();
      // Disabling notifications also turns off the daily reminder (nothing to deliver)
      const dailyEl = document.getElementById('settings-daily-enabled');
      if (dailyEl?.checked) {
        dailyEl.checked = false;
        await Sync.savePreference('daily_reminder_enabled', '0');
        document.getElementById('settings-daily-time-row')?.classList.add('hidden');
      }
      this.showToast('Notifications disabled');
    }
  },

  async _handleDailyToggle(input) {
    const timeRow = document.getElementById('settings-daily-time-row');
    if (input.checked) {
      // Daily reminder needs an active push subscription
      const granted = ('Notification' in window) && Notification.permission === 'granted';
      const subbed  = granted && await Notifications.isSubscribed();
      if (!subbed) {
        input.checked = false;
        this.showToast('Enable notifications first', true);
        return;
      }
      const time = document.getElementById('settings-daily-time')?.value || '08:00';
      const tz   = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      await Promise.all([
        Sync.savePreference('daily_reminder_enabled', '1'),
        Sync.savePreference('daily_reminder_time',    time),
        Sync.savePreference('daily_reminder_tz',      tz)
      ]);
      timeRow?.classList.remove('hidden');
      this.showToast(`Daily reminder set for ${time}`);
    } else {
      await Sync.savePreference('daily_reminder_enabled', '0');
      timeRow?.classList.add('hidden');
      this.showToast('Daily reminder off');
    }
  },

  // ── Auth screen ────────────────────────────────────────────────────────────
  _showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('screen--active'));
    const el = document.getElementById('screen-' + name);
    if (el) el.classList.add('screen--active');
  },

  async _showInviteAuthScreen(token) {
    const invite = await Invite.fetchByToken(token);
    const authScreen = document.getElementById('screen-auth');

    if (invite && invite.status === 'pending') {
      document.getElementById('auth-title').textContent   = 'You\'ve been invited!';
      document.getElementById('auth-subtitle').textContent = `${invite.assigner?.full_name || 'Your manager'} has invited you to TaskVoice.`;
      document.getElementById('auth-email').value = invite.email;
      document.getElementById('auth-email').readOnly = true;
      document.getElementById('auth-btn').textContent = 'Accept & Get Started';
    }
    this._showScreen('auth');
  },

  // ── Onboarding screen ──────────────────────────────────────────────────────
  async _showOnboarding() {
    const token  = this.state.pendingInviteToken;
    let inviteData = null;

    if (token) {
      inviteData = await Invite.fetchByToken(token);
    }

    const nameInput    = document.getElementById('onboard-name');
    const roleSection  = document.getElementById('onboard-role-section');
    const titleEl      = document.getElementById('onboard-title');

    if (inviteData && inviteData.status === 'pending') {
      // Pre-fill name, hide role picker — this person is an assignee
      nameInput.value         = inviteData.name;
      roleSection.classList.add('hidden');
      titleEl.textContent     = `Welcome, ${inviteData.name}!`;
      nameInput.dataset.forceRole = 'assignee';
      nameInput.dataset.inviteId  = inviteData.id;
      nameInput.dataset.assignerId = inviteData.assigner_id;
    } else {
      titleEl.textContent = 'Welcome to TaskVoice!';
      roleSection.classList.remove('hidden');
    }

    this._showScreen('onboarding');
  },

  // ── Assigner boot ──────────────────────────────────────────────────────────
  async _bootAssigner() {
    this._booted = true;
    this._showScreen('assigner-app');

    if (!this._assignerUIBound) {
      this._assignerUIBound = true;
      this._bindAssignerNav();
      this._bindAssignerMic();
      this._bindPipelineFAB();
      this._bindPipelineEvents();
      this._bindTaskEvents();
      this._bindSyncEvents();
      this.voice = new VoiceRecorder();
      this._bindVoiceEvents();
      Sync.subscribe(() => this._pullAll());
    }

    await this._pullAll();
    this.navigateTo(localStorage.getItem('vtm_v2_page') || 'home');
    Notifications.init(this.state.tasks);
  },

  // ── Assignee boot ──────────────────────────────────────────────────────────
  async _bootAssignee() {
    this._booted = true;
    this._showScreen('assignee-app');

    if (!this._assigneeUIBound) {
      this._assigneeUIBound = true;
      this.voice = this.voice || new VoiceRecorder();
      this._bindVoiceEvents();
      this._bindAssigneeEvents();
      this._bindAssigneeNav();
      Sync.subscribe(() => this._pullAll());
    }

    // Accept any pending invite (handles the case where the user already had a
    // profile but the invite was never accepted, e.g. re-opening the invite link)
    if (this.state.pendingInviteToken) {
      await Invite.autoAcceptPending(this.state.pendingInviteToken);
      this.state.pendingInviteToken = null;
    }

    // Safety net: accept pending invites matching this user's email even if
    // the invite token was lost along the way
    await Invite.acceptAllForEmail();

    await this._pullAll();
    Notifications.init(this.state.tasks);
  },

  // ── Pull all data from Supabase ────────────────────────────────────────────
  async _pullAll() {
    if (!Sync.configured) return;
    this._setSyncStatus('syncing');
    try {
      const [tasks, team] = await Promise.all([
        Sync.pull(),
        Sync.pullTeam()
      ]);

      if (tasks)  {
        this.state.tasks = tasks;
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(tasks));
      }
      if (team) {
        if (Auth.profile?.role === 'assigner') {
          this.state.team   = team;
          this.state.nameMap = Object.fromEntries(team.map(m => [m.id, m.full_name]));
          this.state.pendingInvites = await Sync.pullPendingInvites();
          // Load pinned preference
          const pinnedJson = await Sync.loadPreference('pinned_people');
          if (pinnedJson) {
            try { this.state.pinnedIds = JSON.parse(pinnedJson); } catch {}
            localStorage.setItem('vtm_v2_pinned', JSON.stringify(this.state.pinnedIds));
          }
        } else {
          this.state.assigners = team;
        }
      }

      this._refreshCurrentPage();
      this._setSyncStatus('ok');
    } catch {
      this._setSyncStatus('error');
    }
  },

  // ── Navigation (assigner) ──────────────────────────────────────────────────
  navigateTo(page, opts = {}) {
    if (this.voice?.listening) {
      this.voice.stop();
      this.state.voiceContext = 'general';
      this._setMicState('idle');
    }
    // Close any open speed dial when navigating
    this._togglePipelineFAB(false);
    this._toggleAssigneeFAB(false);

    document.querySelectorAll('#assigner-app .page').forEach(p => p.classList.remove('page--active'));
    document.querySelectorAll('#assigner-nav .nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
    document.getElementById('page-' + page)?.classList.add('page--active');
    document.querySelector(`#assigner-nav .nav-btn[data-page="${page}"]`)?.classList.add('nav-btn--active');
    this.state.currentPage = page;
    localStorage.setItem('vtm_v2_page', page);

    if (page === 'home')  renderHomePage(this.state.tasks, this.state.nameMap);
    if (page === 'tasks') renderTaskPage(this.state.tasks, this.state.nameMap);

    if (page === 'pipeline') {
      if (!opts.keepState) {
        this.state.pipelineEditMode = false;
        this.state.pipelinePinMode  = false;
        this.state.showAddPerson    = false;
        this.state.editingTaskId    = null;
        if (this.state.pinnedIds.length && !this.state.activePersonId) {
          this.state.activePersonId = this.state.pinnedIds[0];
        }
      }
      if (opts.personId) this.state.activePersonId = opts.personId;
      this._syncEditBtn();
      this._syncPinBtn();
      renderPinPanel(this.state.pipelinePinMode, this.state.team, this.state.pinnedIds);
      this.state.activePersonId = renderPipelinePage(
        this.state.tasks,
        this.state.activePersonId,
        this.state.pipelineEditMode,
        this.state.showAddPerson,
        this.state.pinnedIds,
        this.state.editingTaskId,
        this.state.team,
        this.state.pendingInvites,
        this.state.nameMap
      );
      this._updatePipelineFAB();
    }
  },

  _bindAssignerNav() {
    document.querySelectorAll('#assigner-nav .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.navigateTo(btn.dataset.page));
    });
  },

  // ── Mic (home page) ────────────────────────────────────────────────────────
  _bindAssignerMic() {
    document.getElementById('mic-btn')?.addEventListener('click', () => {
      if (this.state.voiceContext === 'fab' && this.voice.listening) return;
      if (!this.voice.listening) this.state.voiceContext = 'general';
      this.voice.start();
    });
  },

  // ── Pipeline FAB speed dial (Team page) ───────────────────────────────────
  _bindPipelineFAB() {
    const dial = document.getElementById('pipeline-fab');
    if (!dial) return;

    dial.querySelector('.fab-trigger')?.addEventListener('click', () => {
      this._togglePipelineFAB();
    });

    dial.querySelector('.fab-actions')?.addEventListener('click', e => {
      const pill = e.target.closest('.fab-pill');
      if (!pill) return;
      const action = pill.dataset.fabAction;
      this._togglePipelineFAB(false);
      if (action === 'type')  this._openManagerTypeSheet();
      if (action === 'speak') this._startManagerSpeak();
    });

    document.getElementById('pipeline-fab-backdrop')?.addEventListener('click', () => {
      this._togglePipelineFAB(false);
    });

    // Close sheet via backdrop or after submit
    document.getElementById('add-task-sheet-slot')?.addEventListener('click', async e => {
      if (e.target.closest('[data-close-sheet]')) {
        this._closeManagerTypeSheet();
        return;
      }
      const submit = e.target.closest('#add-task-submit');
      if (submit) {
        e.preventDefault();
        await this._submitManagerTypedTask();
      }
    });
  },

  _togglePipelineFAB(open) {
    const dial = document.getElementById('pipeline-fab');
    const backdrop = document.getElementById('pipeline-fab-backdrop');
    if (!dial) return;
    const next = open !== undefined ? open : !dial.classList.contains('open');
    dial.classList.toggle('open', next);
    backdrop?.classList.toggle('open', next);
  },

  _openManagerTypeSheet() {
    const slot = document.getElementById('add-task-sheet-slot');
    if (!slot) return;
    const pid = this.state.activePersonId;
    const myId = Auth.profile?.id;
    const isMe = pid === myId;
    const member = isMe
      ? { id: myId, full_name: Auth.profile.full_name }
      : this.state.team.find(m => m.id === pid);
    if (!member) return;

    const ctx = isMe ? 'Personal task' : `For <strong>${escapeHTML(member.full_name)}</strong>`;
    const recurOpts = RECURRENCE_OPTIONS.map(o =>
      `<option value="${o.value}">${escapeHTML(o.label)}</option>`
    ).join('');
    slot.innerHTML = `
      <div class="sheet-backdrop" data-close-sheet></div>
      <div class="sheet">
        <div class="sheet-grabber"></div>
        <p class="sheet-title">Add a task</p>
        <p class="sheet-context">${ctx}</p>
        <input type="text" id="add-task-desc" class="add-task-input" placeholder="Task description…" autocomplete="off"/>
        <label class="add-task-field-label" for="add-task-date">Date</label>
        <input type="date" id="add-task-date" class="add-task-date"/>
        <label class="add-task-field-label" for="add-task-time">Time</label>
        <input type="time" id="add-task-time" class="add-task-date"/>
        <label class="add-task-field-label" for="add-task-recurrence">Repeat</label>
        <select id="add-task-recurrence" class="add-task-input add-task-select">${recurOpts}</select>
        <label class="add-task-urgent-row">
          <input type="checkbox" id="add-task-urgent"/>
          <span>Mark as urgent</span>
        </label>
        ${notesAndSubtasksFormHTML(null, 'add-task')}
        <button id="add-task-submit" class="add-task-btn" data-target-id="${member.id}">Add Task</button>
      </div>
    `;
    setTimeout(() => document.getElementById('add-task-desc')?.focus(), 50);
  },

  _closeManagerTypeSheet() {
    const slot = document.getElementById('add-task-sheet-slot');
    if (slot) slot.innerHTML = '';
  },

  async _submitManagerTypedTask() {
    const descInput = document.getElementById('add-task-desc');
    const dateInput = document.getElementById('add-task-date');
    const timeInput = document.getElementById('add-task-time');
    const submit    = document.getElementById('add-task-submit');
    const desc = descInput?.value.trim();
    if (!desc) { descInput?.focus(); return; }

    const targetId = submit?.dataset.targetId;
    const myId = Auth.profile?.id;
    const isMe = targetId === myId;
    const member = isMe
      ? { id: myId, full_name: Auth.profile.full_name }
      : this.state.team.find(m => m.id === targetId);
    if (!member) return;

    const _date  = dateInput.value || new Date().toISOString().split('T')[0];
    const _time  = timeInput?.value || new Date().toTimeString().slice(0, 5);
    const _recur = document.getElementById('add-task-recurrence')?.value || 'none';
    const _urgent = document.getElementById('add-task-urgent')?.checked || false;
    const _notes  = document.getElementById('add-task-notes')?.value.trim() || '';
    const _subs   = readSubtasksFromForm(document.getElementById('add-task-subtasks'));

    const newTask = {
      id:          crypto.randomUUID(),
      raw:         '',
      description: desc,
      assignee:    member.full_name,
      assignee_id: member.id,
      assigner_id: Auth.profile.id,
      added_by:    Auth.profile.id,
      dueDate:     _date,
      time:        _time,
      dueAt:       new Date(`${_date}T${_time}`).getTime(),
      status:      'pending',
      recurrence:  _recur,
      priority:    _urgent ? 'urgent' : 'normal',
      notes:       _notes,
      subtasks:    _subs,
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString()
    };

    this.state.tasks = Storage.add(newTask);
    Notifications.scheduleLocal(newTask);
    this._closeManagerTypeSheet();
    this._renderPipeline();
    this._updatePipelineBadge();
    const toastMsg = _urgent
      ? 'Urgent task added!'
      : (_recur !== 'none' ? `Recurring task added (${recurrenceLabel(_recur).toLowerCase()})` : 'Task added!');
    this.showToast(toastMsg);
  },

  // ── Subtask interactions (shared between manager + assignee) ──────────────

  // Tick/untick a subtask on a rendered task card. Updates the task's
  // subtasks JSON and re-renders the current page.
  _toggleSubtaskOnCard(taskId, subtaskId) {
    if (!taskId || !subtaskId) return;
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) return;
    const subs = (task.subtasks || []).map(s =>
      s.id === subtaskId ? { ...s, done: !s.done } : s
    );
    this.state.tasks = Storage.update(taskId, { subtasks: subs });
    this._refreshCurrentPage();
  },

  // Used by both the + Add button and Enter-in-input: read the input value,
  // append a row to the matching subtask list, clear the input.
  _appendSubtaskRowFromInput(btnOrAddBtn) {
    const targetId = btnOrAddBtn.dataset.target;
    const list     = document.getElementById(targetId);
    const input    = btnOrAddBtn.closest('.subtask-add-row')?.querySelector('.subtask-add-input');
    const text     = input?.value.trim();
    if (!list || !text) { input?.focus(); return; }
    list.appendChild(makeSubtaskRow(text, false));
    if (input) { input.value = ''; input.focus(); }
  },

  // Ask Groq to break the current task description into 3-6 subtasks,
  // append them all to the matching subtask list.
  async _breakIntoSteps(btn) {
    const targetId = btn.dataset.target;
    const list     = document.getElementById(targetId);
    if (!list) return;

    // Find the description input that this Break-into-steps button belongs to.
    // Try the closest sheet first (creation flow), then closest edit form (edit flow).
    const container = btn.closest('.sheet') || btn.closest('.pipeline-edit-form');
    const desc = container?.querySelector('.add-task-input[id$="-desc"], .pipeline-edit-desc, #add-task-desc, #add-assignee-task-desc')?.value.trim();

    if (!desc) {
      this.showToast('Add a task description first', true);
      return;
    }

    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Thinking…';

    try {
      const steps = await Parser.breakIntoSteps(desc);
      if (!steps?.length) {
        this.showToast('Could not break it down — try again', true);
        return;
      }
      steps.forEach(text => list.appendChild(makeSubtaskRow(text, false)));
      this.showToast(`Added ${steps.length} step${steps.length === 1 ? '' : 's'}`);
    } catch (err) {
      this.showToast(err.message || 'AI breakdown failed', true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  },

  // When a recurring task gets marked complete, create the next instance.
  // Skips silently for non-recurring tasks.
  _maybeGenerateNextRecurrence(task) {
    if (!task || !task.recurrence || task.recurrence === 'none') return;
    const next = nextDueDateForRecurrence(task.dueDate, task.time, task.recurrence);
    if (!next) return;
    const nowIso  = new Date().toISOString();
    const nextTask = {
      ...task,
      id:          crypto.randomUUID(),
      status:      'pending',
      dueDate:     next.dueDate,
      time:        next.time,
      dueAt:       next.dueDate && next.time ? new Date(`${next.dueDate}T${next.time}`).getTime() : null,
      createdAt:   nowIso,
      updatedAt:   nowIso
    };
    this.state.tasks = Storage.add(nextTask);
    Notifications.scheduleLocal(nextTask);
  },

  _startManagerSpeak() {
    if (!this.state.activePersonId) return;
    const myId = Auth.profile?.id;
    this.state.voiceContext = this.state.activePersonId === myId ? 'me-speak' : 'fab';
    this.voice.start();
  },

  _updatePipelineFAB() {
    const dial  = document.getElementById('pipeline-fab');
    const label = document.getElementById('pipeline-fab-label');
    const pid   = this.state.activePersonId;
    const myId  = Auth.profile?.id;
    const isMe  = pid === myId;
    const member = isMe
      ? { id: myId, full_name: 'Me', _isMe: true }
      : this.state.team.find(m => m.id === pid);
    if (member) {
      dial?.classList.remove('hidden');
      if (label) label.textContent = isMe ? 'Personal task' : `For ${member.full_name}`;
    } else {
      dial?.classList.add('hidden');
      dial?.classList.remove('open');
      document.getElementById('pipeline-fab-backdrop')?.classList.remove('open');
    }
  },

  // ── Voice events ───────────────────────────────────────────────────────────
  _showVoiceOverlay(show, text) {
    const overlay = document.getElementById('voice-overlay');
    if (!overlay) return;
    overlay.classList.toggle('hidden', !show);
    if (text !== undefined) {
      const t = document.getElementById('voice-overlay-text');
      if (t) t.textContent = text;
    }
  },

  // phase: 'listening' | 'processing' | 'saved'
  _setVoiceOverlayPhase(phase) {
    const mic    = document.getElementById('voice-overlay-mic');
    const eq     = document.getElementById('voice-overlay-eq');
    const stop   = document.getElementById('voice-overlay-stop');
    const hint   = document.getElementById('voice-overlay-hint');
    const text   = document.getElementById('voice-overlay-text');
    const result = document.getElementById('voice-overlay-result');
    if (!mic) return;
    const listening = phase === 'listening';
    mic.classList.toggle('hidden',    phase === 'saved');
    eq?.classList.toggle('hidden',    !listening);
    stop?.classList.toggle('hidden',  !listening);
    text?.classList.toggle('hidden',  phase === 'saved');
    result?.classList.toggle('hidden', phase !== 'saved');
    if (hint) hint.textContent = phase === 'processing' ? 'Saving…' : listening ? 'Listening…' : '';
  },

  _showVoiceOverlayResult(tasks) {
    const result = document.getElementById('voice-overlay-result');
    if (!result) return;
    result.innerHTML = `
      <p class="preview-label">✓ ${tasks.length > 1 ? tasks.length + ' tasks saved' : 'Task saved'}</p>
      ${tasks.map(t => {
        const recurLbl = recurrenceLabel(t.recurrence);
        const isUrgent = t.priority === 'urgent';
        return `
        <div class="preview-item">
          <p class="preview-desc">${isUrgent ? '<span class="task-urgent-mark">!</span>' : ''}${escapeHTML(t.description)}</p>
          <div class="preview-meta">
            <span class="chip chip--assignee">${escapeHTML(t.assignee)}</span>
            ${t.dueDate ? `<span class="chip chip--date">${formatDate(t.dueDate)}${t.time ? ' · ' + formatTime(t.time) : ''}</span>` : ''}
            ${recurLbl ? `<span class="chip chip--recur">↻ ${escapeHTML(recurLbl)}</span>` : ''}
            ${isUrgent ? '<span class="chip chip--urgent">Urgent</span>' : ''}
          </div>
        </div>
      `; }).join('')}
    `;
    this._setVoiceOverlayPhase('saved');
    clearTimeout(this._overlayCloseTimer);
    this._overlayCloseTimer = setTimeout(() => {
      this._showVoiceOverlay(false);
      this._setVoiceOverlayPhase('listening');
    }, 2800);
  },

  _bindVoiceEvents() {
    document.getElementById('voice-overlay-stop')?.addEventListener('click', () => {
      this.voice?.stop();
    });

    document.addEventListener('voice:start', () => {
      this._setMicState('listening');
      clearTimeout(this._overlayCloseTimer);
      this._setVoiceOverlayPhase('listening');
      this._showVoiceOverlay(true, 'Listening…');
    });

    document.addEventListener('voice:interim', e => {
      if (e.detail) this._showVoiceOverlay(true, `“${e.detail}”`);
    });

    document.addEventListener('voice:result', async e => {
      const transcript = e.detail;
      const ctx = this.state.voiceContext;
      this.state.voiceContext = 'general';

      this._setMicState('processing');
      this._showVoiceOverlay(true, `“${transcript}”`);
      this._setVoiceOverlayPhase('processing');

      try {
        const myId = Auth.profile?.id;
        let tasks;

        if (ctx === 'me-speak') {
          // Manager dictating personal task on Me chip
          tasks = await Parser.parseSimple(transcript);
          tasks = tasks.map(t => ({
            ...t,
            assignee:    Auth.profile.full_name,
            assignee_id: myId,
            assigner_id: myId,
            added_by:    myId
          }));
        } else if (ctx === 'assignee-speak') {
          // Team member dictating; assigner = active manager (or self if Me chip)
          tasks = await Parser.parseSimple(transcript);
          const targetAssigner = this.state.activeAssignerId || myId;
          tasks = tasks.map(t => ({
            ...t,
            assignee:    Auth.profile.full_name,
            assignee_id: myId,
            assigner_id: targetAssigner,
            added_by:    myId
          }));
        } else {
          // Manager Home mic or FAB on a team member
          tasks = await Parser.parse(transcript, this.state.team);
          if (ctx === 'fab' && this.state.activePersonId) {
            const member = this.state.team.find(m => m.id === this.state.activePersonId);
            if (member) {
              tasks = tasks.map(t => ({
                ...t,
                assignee:    member.full_name,
                assignee_id: member.id
              }));
            }
          }
        }

        tasks = tasks.map(t => ({
          ...t,
          dueAt: t.dueDate && t.time ? new Date(`${t.dueDate}T${t.time}`).getTime() : null
        }));

        tasks.forEach(task => {
          this.state.tasks = Storage.add(task);
          Notifications.scheduleLocal(task);
        });

        this._showVoiceOverlayResult(tasks);

        let msg;
        if (ctx === 'me-speak' || ctx === 'assignee-speak') {
          msg = tasks.length > 1 ? `${tasks.length} tasks saved!` : 'Task saved!';
        } else {
          const activeMember = ctx === 'fab' ? this.state.team.find(m => m.id === this.state.activePersonId) : null;
          msg = activeMember
            ? `Task${tasks.length > 1 ? 's' : ''} assigned to ${activeMember.full_name}!`
            : (tasks.length > 1 ? `${tasks.length} tasks saved!` : 'Task saved!');
        }
        this.showToast(msg);
        this._refreshCurrentPage();
        this._updatePipelineBadge();
        this._updateAssigneeBadge();
      } catch (err) {
        this._showVoiceOverlay(false);
        this._setVoiceOverlayPhase('listening');
        this.showToast(err.message || 'Could not parse task. Try again.', true);
      } finally {
        this._setMicState('idle');
      }
    });

    document.addEventListener('voice:error', e => {
      this.state.voiceContext = 'general';
      this._showVoiceOverlay(false);
      this._setVoiceOverlayPhase('listening');
      this.showToast(e.detail, true);
      this._setMicState('idle');
    });

    document.addEventListener('voice:end', () => {
      if (!this.voice._transcript?.trim()) {
        this._showVoiceOverlay(false);
        this._setMicState('idle');
      }
    });
  },

  // ── Sync events ────────────────────────────────────────────────────────────
  _bindSyncEvents() {
    document.addEventListener('sync:pending', () => this._setSyncStatus('syncing'));
    document.addEventListener('sync:ok',      () => this._setSyncStatus('ok'));
    document.addEventListener('sync:error',   () => this._setSyncStatus('error'));
  },

  _setSyncStatus(status) {
    if (!Sync.configured) return;
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = 'sync-indicator sync-indicator--' + status;
    el.title = { syncing: 'Syncing…', ok: 'Synced', error: 'Sync failed — cached data shown' }[status] || '';
  },

  // ── Tasks page + Home list events ──────────────────────────────────────────
  _bindTaskEvents() {
    const handler = e => {
      const seg    = e.target.closest('.seg-btn');
      const check  = e.target.closest('.check-btn');
      const remove = e.target.closest('.delete-btn');

      if (seg) {
        this.state.taskFilter = seg.dataset.filter;
        renderTaskPage(this.state.tasks, this.state.nameMap);
        return;
      }

      if (check) {
        const task = this.state.tasks.find(t => t.id === check.dataset.id);
        if (task) {
          const next = task.status === 'completed' ? 'pending' : 'completed';
          this.state.tasks = Storage.update(task.id, { status: next });
          if (next === 'completed') {
            Notifications.cancelLocal(task.id);
            this._maybeGenerateNextRecurrence(task);
          } else {
            Notifications.scheduleLocal({ ...task, status: 'pending' });
          }
          this._refreshCurrentPage();
        }
      }

      if (remove) {
        const taskId = remove.dataset.id;
        const taskToDelete = this.state.tasks.find(t => t.id === taskId);
        if (!taskToDelete) return;
        const tasksCopy = [...this.state.tasks];
        const syncHandle = { timer: null };
        this._deleteWithUndo(
          taskToDelete.description.slice(0, 30),
          () => {
            Notifications.cancelLocal(taskId);
            this.state.tasks = Storage.removeLocal(taskId);
            this._refreshCurrentPage();
            syncHandle.timer = setTimeout(() => { Sync.deleteRemote(taskId); Sync.push(this.state.tasks); }, 4500);
          },
          () => {
            clearTimeout(syncHandle.timer);
            this.state.tasks = tasksCopy;
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(tasksCopy));
            Notifications.scheduleLocal(taskToDelete);
            this._refreshCurrentPage();
          }
        );
      }
    };

    document.getElementById('tasks-main')?.addEventListener('click', handler);
    document.getElementById('home-tasks')?.addEventListener('click', handler);
  },

  // ── Pipeline events ────────────────────────────────────────────────────────
  _bindPipelineEvents() {
    // Edit / Done toggle
    document.getElementById('pipeline-edit-btn')?.addEventListener('click', () => {
      this.state.pipelineEditMode = !this.state.pipelineEditMode;
      if (!this.state.pipelineEditMode) this.state.showAddPerson = false;
      this.state.editingTaskId = null;
      this.state.pipelinePinMode = false;
      this._syncPinBtn();
      this._syncEditBtn();
      renderPinPanel(false, this.state.team, this.state.pinnedIds);
      this._renderPipeline();
    });

    // Pin button
    document.getElementById('pipeline-pin-btn')?.addEventListener('click', () => {
      this.state.pipelinePinMode = !this.state.pipelinePinMode;
      this._syncPinBtn();
      renderPinPanel(this.state.pipelinePinMode, this.state.team, this.state.pinnedIds);
    });

    // Pin panel clicks
    document.getElementById('pin-select-panel')?.addEventListener('click', e => {
      if (e.target.closest('#pin-panel-close')) {
        this.state.pipelinePinMode = false;
        this._syncPinBtn();
        renderPinPanel(false, this.state.team, this.state.pinnedIds);
        return;
      }
      const item = e.target.closest('[data-pin-id]');
      if (item) this._togglePin(item.dataset.pinId);
    });

    // Tab strip clicks
    document.getElementById('pipeline-tabs')?.addEventListener('click', async e => {
      const tab        = e.target.closest('.person-tab[data-person-id]');
      const invTab     = e.target.closest('.person-tab[data-invite-id]');
      const deleteTab  = e.target.closest('.tab-delete-btn[data-person-id]');
      const deleteInvT = e.target.closest('.tab-delete-btn[data-invite-id]');
      const addBtn     = e.target.closest('#add-person-btn');

      if (deleteTab) {
        const pid    = deleteTab.dataset.personId;
        const member = this.state.team.find(m => m.id === pid);
        const name   = member?.full_name || 'this person';
        if (!confirm(`Remove ${name} from your team? All tasks between you two will be deleted.`)) return;
        if (SupabaseClient && Auth.profile) {
          // Unlink. Other managers linked to this person stay unaffected.
          await SupabaseClient.from('assigner_assignee_map')
            .delete().eq('assigner_id', Auth.profile.id).eq('assignee_id', pid);
          // Delete every task between us — covers tasks I created AND tasks
          // they self-added under me (the diff-delete in sync wouldn't catch
          // the latter because it scopes to added_by=me)
          await SupabaseClient.from('tasks')
            .delete().eq('assigner_id', Auth.profile.id).eq('assignee_id', pid);
        }
        this.state.team = this.state.team.filter(m => m.id !== pid);
        this.state.tasks = this.state.tasks.filter(t => t.assignee_id !== pid);
        this.state.nameMap = Object.fromEntries(this.state.team.map(m => [m.id, m.full_name]));
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(this.state.tasks));
        if (this.state.activePersonId === pid) this.state.activePersonId = null;
        this._renderPipeline();
        this._updatePipelineBadge();
        this.showToast(`${name} removed from your team`);
        return;
      }

      if (deleteInvT) {
        const invId = deleteInvT.dataset.inviteId;
        if (SupabaseClient) {
          await SupabaseClient.from('invites').delete().eq('id', invId);
        }
        this.state.pendingInvites = this.state.pendingInvites.filter(i => i.id !== invId);
        this._renderPipeline();
        return;
      }

      if (addBtn) {
        this.state.showAddPerson = !this.state.showAddPerson;
        this._renderPipeline();
        if (this.state.showAddPerson) setTimeout(() => document.getElementById('invite-name')?.focus(), 50);
        return;
      }

      if (tab) {
        this.state.activePersonId = tab.dataset.personId;
        this.state.showAddPerson  = false;
        this.state.editingTaskId  = null;
        this._renderPipeline();
      }

      if (invTab) {
        this.state.activePersonId = 'invite_' + invTab.dataset.inviteId;
        this.state.showAddPerson  = false;
        this._renderPipeline();
      }
    });

    // Invite form submission (+ Add Person area)
    document.getElementById('add-person-area')?.addEventListener('click', async e => {
      if (e.target.closest('[data-close-sheet]')) {
        this.state.showAddPerson = false;
        this._renderPipeline();
        return;
      }
      const submitBtn = e.target.closest('#invite-submit');
      if (!submitBtn) return;

      const nameInput  = document.getElementById('invite-name');
      const emailInput = document.getElementById('invite-email');
      const name  = nameInput?.value.trim();
      const email = emailInput?.value.trim();
      if (!name)  { nameInput?.focus();  return; }
      if (!email) { emailInput?.focus(); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      const resultEl = document.getElementById('invite-result');

      try {
        const { invite, link } = await Invite.create(name, email);

        // Send via Edge Function: links instantly if the member is already
        // registered, otherwise emails the invite
        let result = null;
        try {
          result = await Invite.sendEmail(invite);
        } catch (mailErr) {
          console.warn('Invite email failed:', mailErr);
        }

        if (result?.linked) {
          const memberName = result.name || name;
          if (resultEl) {
            resultEl.classList.remove('hidden');
            resultEl.innerHTML = `
              <p class="invite-result-label">${escapeHTML(memberName)} is already on TaskVoice — added to your team!</p>
            `;
          }
          this.showToast(`${memberName} added to your team!`);
          await this._pullAll();
          this._renderPipeline();
        } else {
          this.state.pendingInvites.push(invite);
          const emailSent = !!result?.sent;
          if (resultEl) {
            resultEl.classList.remove('hidden');
            resultEl.innerHTML = emailSent
              ? `
              <p class="invite-result-label">Invite email sent to ${escapeHTML(email)}</p>
              <div class="invite-result-actions">
                <button class="invite-copy-now" data-token="${invite.token}">Copy Backup Link</button>
              </div>
            `
              : `
              <p class="invite-result-label">Email could not be sent — share this link instead</p>
              <p class="invite-result-link">${escapeHTML(link)}</p>
              <div class="invite-result-actions">
                <button class="invite-copy-now" data-token="${invite.token}">Copy Link</button>
                <button class="invite-share-now" data-token="${invite.token}" data-name="${escapeHTML(name)}">Share</button>
              </div>
            `;
          }
          this.showToast(emailSent ? `Invite emailed to ${name}!` : `Invite created for ${name}`);
          this.state.activePersonId = 'invite_' + invite.id;
          this._renderPipeline();
        }
      } catch (err) {
        this.showToast(err.message || 'Could not create invite', true);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Invite';
      }
    });

    // Invite result: copy / share buttons
    document.getElementById('add-person-area')?.addEventListener('click', async e => {
      const copyBtn  = e.target.closest('.invite-copy-now');
      const shareBtn = e.target.closest('.invite-share-now');
      if (copyBtn) {
        const ok = await Invite.copyLink(copyBtn.dataset.token);
        this.showToast(ok ? 'Link copied!' : 'Copy failed — please copy manually');
      }
      if (shareBtn) {
        await Invite.share(shareBtn.dataset.name, shareBtn.dataset.token);
      }
    });

    // Pending invite panel: copy / share
    document.getElementById('pipeline-main')?.addEventListener('click', async e => {
      const copyBtn  = e.target.closest('.pending-copy-btn');
      const shareBtn = e.target.closest('.pending-share-btn');
      if (copyBtn) {
        const ok = await Invite.copyLink(copyBtn.dataset.token);
        this.showToast(ok ? 'Link copied!' : 'Copy failed — please copy manually');
      }
      if (shareBtn) await Invite.share(shareBtn.dataset.name, shareBtn.dataset.token);
    });

    // Pipeline main: task actions
    document.getElementById('pipeline-main')?.addEventListener('click', e => {
      const editBtn   = e.target.closest('.pipeline-task-edit-btn');
      const saveBtn   = e.target.closest('.pipeline-edit-save');
      const cancelBtn = e.target.closest('.pipeline-edit-cancel');
      const checkBtn  = e.target.closest('.check-btn');
      const deleteBtn = e.target.closest('.pipeline-task-delete-btn');
      const addBtn    = e.target.closest('#add-task-submit');

      if (editBtn) {
        this.state.editingTaskId = this.state.editingTaskId === editBtn.dataset.id ? null : editBtn.dataset.id;
        this._renderPipeline();
        return;
      }

      if (saveBtn) {
        const form  = saveBtn.closest('.pipeline-edit-form');
        const id    = saveBtn.dataset.id;
        const desc  = form.querySelector('.pipeline-edit-desc').value.trim();
        const date  = form.querySelector('.pipeline-edit-date').value;
        const time  = form.querySelector('.pipeline-edit-time').value;
        if (!desc) return;
        const dueAt    = date && time ? new Date(`${date}T${time}`).getTime() : null;
        const urgentEl = form.querySelector('.pipeline-edit-urgent');
        const priority = urgentEl?.checked ? 'urgent' : 'normal';
        const notes    = form.querySelector(`#edit-${id}-notes`)?.value.trim() || '';
        const subtasks = readSubtasksFromForm(form.querySelector(`#edit-${id}-subtasks`));
        this.state.tasks = Storage.update(id, { description: desc, dueDate: date || null, time: time || null, dueAt, priority, notes, subtasks });
        Sync.push(this.state.tasks);
        Notifications.cancelLocal(id);
        const updated = this.state.tasks.find(t => t.id === id);
        if (updated) Notifications.scheduleLocal(updated);
        this.state.editingTaskId = null;
        this._renderPipeline();
        this._updatePipelineBadge();
        this.showToast('Task updated');
        return;
      }

      if (cancelBtn) {
        this.state.editingTaskId = null;
        this._renderPipeline();
        return;
      }

      if (checkBtn) {
        const task = this.state.tasks.find(t => t.id === checkBtn.dataset.id);
        if (task) {
          const next = task.status === 'completed' ? 'pending' : 'completed';
          this.state.tasks = Storage.update(task.id, { status: next });
          if (next === 'completed') {
            Notifications.cancelLocal(task.id);
            this._maybeGenerateNextRecurrence(task);
          } else {
            Notifications.scheduleLocal({ ...task, status: 'pending' });
          }
          this._renderPipeline();
          this._updatePipelineBadge();
        }
        return;
      }

      if (deleteBtn) {
        const taskId       = deleteBtn.dataset.id;
        const taskToDelete = this.state.tasks.find(t => t.id === taskId);
        if (!taskToDelete) return;
        const tasksCopy  = [...this.state.tasks];
        const syncHandle = { timer: null };
        this._deleteWithUndo(
          taskToDelete.description.slice(0, 30),
          () => {
            Notifications.cancelLocal(taskId);
            this.state.tasks = Storage.removeLocal(taskId);
            this.state.editingTaskId = null;
            this._renderPipeline();
            this._updatePipelineBadge();
            syncHandle.timer = setTimeout(() => { Sync.deleteRemote(taskId); Sync.push(this.state.tasks); }, 4500);
          },
          () => {
            clearTimeout(syncHandle.timer);
            this.state.tasks = tasksCopy;
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(tasksCopy));
            Notifications.scheduleLocal(taskToDelete);
            this._renderPipeline();
            this._updatePipelineBadge();
          }
        );
        return;
      }

      if (addBtn) {
        const descInput = document.getElementById('add-task-desc');
        const dateInput = document.getElementById('add-task-date');
        const timeInput = document.getElementById('add-task-time');
        const desc = descInput?.value.trim();
        if (!desc) { descInput?.focus(); return; }

        const isMeActive = this.state.activePersonId === Auth.profile?.id;
        const member = isMeActive
          ? { id: Auth.profile.id, full_name: Auth.profile.full_name }
          : this.state.team.find(m => m.id === this.state.activePersonId);
        if (!member) return;

        const _date = dateInput.value || new Date().toISOString().split('T')[0];
        const _time = timeInput?.value || new Date().toTimeString().slice(0, 5);

        const newTask = {
          id:          crypto.randomUUID(),
          raw:         '',
          description: desc,
          assignee:    member.full_name,
          assignee_id: member.id,
          assigner_id: Auth.profile.id,
          added_by:    Auth.profile.id,
          dueDate:     _date,
          time:        _time,
          dueAt:       new Date(`${_date}T${_time}`).getTime(),
          status:      'pending',
          createdAt:   new Date().toISOString(),
          updatedAt:   new Date().toISOString()
        };

        this.state.tasks = Storage.add(newTask);
        Notifications.scheduleLocal(newTask);
        this._renderPipeline();
        this._updatePipelineBadge();
        this.showToast('Task added!');
      }
    });
  },

  // ── Assignee events ────────────────────────────────────────────────────────
  _bindAssigneeEvents() {
    const main = document.getElementById('assignee-main');
    if (!main) return;

    // Render add form in the dedicated slot
    const formSlot = document.getElementById('assignee-add-form-slot');

    main.addEventListener('click', e => {
      const mgrTab   = e.target.closest('.person-tab[data-assigner-id]');
      const checkBtn = e.target.closest('.check-btn');
      const editBtn  = e.target.closest('.assignee-edit-btn');
      const saveBtn  = e.target.closest('.pipeline-edit-save');
      const cancelBtn = e.target.closest('.pipeline-edit-cancel');

      if (mgrTab) {
        this.state.activeAssignerId = mgrTab.dataset.assignerId;
        this.state.editingAssigneeTaskId = null;
        renderAssigneeTasksPage(this.state.tasks, this.state.assigners, null);
        return;
      }

      if (checkBtn) {
        const task = this.state.tasks.find(t => t.id === checkBtn.dataset.id);
        if (task) {
          const next = task.status === 'completed' ? 'pending' : 'completed';
          this.state.tasks = Storage.update(task.id, { status: next });
          if (next === 'completed') {
            Notifications.cancelLocal(task.id);
            this._maybeGenerateNextRecurrence(task);
          } else {
            Notifications.scheduleLocal({ ...task, status: 'pending' });
          }
          renderAssigneeTasksPage(this.state.tasks, this.state.assigners, this.state.editingAssigneeTaskId);
          this._updateAssigneeBadge();
        }
      }

      if (editBtn) {
        this.state.editingAssigneeTaskId = this.state.editingAssigneeTaskId === editBtn.dataset.id ? null : editBtn.dataset.id;
        renderAssigneeTasksPage(this.state.tasks, this.state.assigners, this.state.editingAssigneeTaskId);
      }

      if (saveBtn) {
        const form = saveBtn.closest('.pipeline-edit-form');
        const id   = saveBtn.dataset.id;
        const desc = form.querySelector('.pipeline-edit-desc').value.trim();
        const date = form.querySelector('.pipeline-edit-date').value;
        const time = form.querySelector('.pipeline-edit-time').value;
        if (!desc) return;
        const dueAt    = date && time ? new Date(`${date}T${time}`).getTime() : null;
        const urgentEl = form.querySelector('.pipeline-edit-urgent');
        const priority = urgentEl?.checked ? 'urgent' : 'normal';
        const notes    = form.querySelector(`#edit-${id}-notes`)?.value.trim() || '';
        const subtasks = readSubtasksFromForm(form.querySelector(`#edit-${id}-subtasks`));
        this.state.tasks = Storage.update(id, { description: desc, dueDate: date || null, time: time || null, dueAt, priority, notes, subtasks });
        Sync.push(this.state.tasks);
        this.state.editingAssigneeTaskId = null;
        renderAssigneeTasksPage(this.state.tasks, this.state.assigners, null);
        this.showToast('Task updated');
      }

      if (cancelBtn) {
        this.state.editingAssigneeTaskId = null;
        renderAssigneeTasksPage(this.state.tasks, this.state.assigners, null);
      }
    });

    // FAB speed dial — trigger toggle
    const fabDial = document.getElementById('assignee-fab');
    fabDial?.querySelector('.fab-trigger')?.addEventListener('click', () => {
      this._toggleAssigneeFAB();
    });
    fabDial?.querySelector('.fab-actions')?.addEventListener('click', e => {
      const pill = e.target.closest('.fab-pill');
      if (!pill) return;
      const action = pill.dataset.fabAction;
      this._toggleAssigneeFAB(false);
      if (action === 'type') {
        this.state.showAssigneeAddForm = true;
        if (formSlot) formSlot.innerHTML = renderAssigneeAddTaskForm(this.state.assigners, this.state.activeAssignerId);
      } else if (action === 'speak') {
        this.state.voiceContext = 'assignee-speak';
        this.voice.start();
      }
    });
    document.getElementById('assignee-fab-backdrop')?.addEventListener('click', () => {
      this._toggleAssigneeFAB(false);
    });

    document.getElementById('assignee-app')?.addEventListener('click', async e => {
      if (e.target.closest('[data-close-sheet]')) {
        this.state.showAssigneeAddForm = false;
        const slot = document.getElementById('assignee-add-form-slot');
        if (slot) slot.innerHTML = '';
        return;
      }
      const submitBtn = e.target.closest('#add-assignee-task-submit');
      if (!submitBtn) return;

      const descInput = document.getElementById('add-assignee-task-desc');
      const dateInput = document.getElementById('add-assignee-task-date');
      const timeInput = document.getElementById('add-assignee-task-time');

      const assignerId = submitBtn.dataset.assignerId;
      const desc       = descInput?.value.trim();
      if (!desc || !assignerId) { descInput?.focus(); return; }

      const _date   = dateInput.value || new Date().toISOString().split('T')[0];
      const _time   = timeInput?.value || new Date().toTimeString().slice(0, 5);
      const _recur  = document.getElementById('add-assignee-task-recurrence')?.value || 'none';
      const _urgent = document.getElementById('add-assignee-task-urgent')?.checked || false;
      const _notes  = document.getElementById('add-assignee-task-notes')?.value.trim() || '';
      const _subs   = readSubtasksFromForm(document.getElementById('add-assignee-task-subtasks'));

      const newTask = {
        id:          crypto.randomUUID(),
        raw:         '',
        description: desc,
        assignee:    Auth.profile.full_name,
        assignee_id: Auth.profile.id,
        assigner_id: assignerId,
        added_by:    Auth.profile.id,
        dueDate:     _date,
        time:        _time,
        dueAt:       new Date(`${_date}T${_time}`).getTime(),
        status:      'pending',
        recurrence:  _recur,
        priority:    _urgent ? 'urgent' : 'normal',
        notes:       _notes,
        subtasks:    _subs,
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString()
      };

      this.state.tasks = Storage.add(newTask);
      Notifications.scheduleLocal(newTask);
      this.state.showAssigneeAddForm = false;
      if (formSlot) formSlot.innerHTML = '';
      renderAssigneeTasksPage(this.state.tasks, this.state.assigners, null);
      this._updateAssigneeBadge();
      const toastMsg = _urgent
        ? 'Urgent task added!'
        : (_recur !== 'none' ? `Recurring task added (${recurrenceLabel(_recur).toLowerCase()})` : 'Task added!');
      this.showToast(toastMsg);
    });
  },

  _bindAssigneeNav() {
    document.querySelectorAll('#assignee-nav .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#assignee-nav .nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
        btn.classList.add('nav-btn--active');
      });
    });
  },

  // ── Page refresh helpers ───────────────────────────────────────────────────
  _refreshCurrentPage() {
    if (Auth.profile?.role === 'assigner') {
      if (this.state.currentPage === 'home')     renderHomePage(this.state.tasks, this.state.nameMap);
      if (this.state.currentPage === 'tasks')    renderTaskPage(this.state.tasks, this.state.nameMap);
      if (this.state.currentPage === 'pipeline') this._renderPipeline();
      this._updatePipelineBadge();
    } else {
      renderAssigneeTasksPage(this.state.tasks, this.state.assigners, this.state.editingAssigneeTaskId);
      this._updateAssigneeBadge();
    }
  },

  _renderPipeline() {
    this.state.activePersonId = renderPipelinePage(
      this.state.tasks,
      this.state.activePersonId,
      this.state.pipelineEditMode,
      this.state.showAddPerson,
      this.state.pinnedIds,
      this.state.editingTaskId,
      this.state.team,
      this.state.pendingInvites,
      this.state.nameMap
    );
    this._updatePipelineFAB();
    this._syncPinBtn();
  },

  // ── Badges ─────────────────────────────────────────────────────────────────
  _updatePipelineBadge() {
    const badge = document.getElementById('pipeline-badge');
    if (!badge) return;
    const myId = Auth.profile?.id;
    const count = this.state.tasks.filter(t =>
      t.status !== 'completed' && !isPersonalTask(t, myId)
    ).length;
    if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  },

  _updateAssigneeBadge() {
    const badge = document.getElementById('assignee-badge');
    if (!badge) return;
    const myId = Auth.profile?.id;
    const count = this.state.tasks.filter(t =>
      t.assignee_id === myId && t.status !== 'completed' && !isPersonalTask(t, myId)
    ).length;
    if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  },

  // ── Delete with undo ───────────────────────────────────────────────────────
  _deleteWithUndo(label, deleteFn, undoFn) {
    deleteFn();
    this.showToast(`${label} deleted`, false, undoFn);
  },

  // ── Pin helpers ────────────────────────────────────────────────────────────
  _togglePin(id) {
    const arr = [...this.state.pinnedIds];
    const idx = arr.indexOf(id);
    if (idx >= 0) { arr.splice(idx, 1); this.showToast('Unpinned'); }
    else           { arr.push(id);       this.showToast('Pinned'); }
    this.state.pinnedIds = arr;
    localStorage.setItem('vtm_v2_pinned', JSON.stringify(arr));
    Sync.savePreference('pinned_people', arr.length ? JSON.stringify(arr) : null);
    renderPinPanel(this.state.pipelinePinMode, this.state.team, this.state.pinnedIds);
    this._renderPipeline();
  },

  _syncPinBtn() {
    const btn = document.getElementById('pipeline-pin-btn');
    if (!btn) return;
    const active = this.state.pinnedIds.length > 0 || this.state.pipelinePinMode;
    btn.classList.toggle('header-pin-btn--active', active);
  },

  _syncEditBtn() {
    const btn = document.getElementById('pipeline-edit-btn');
    if (!btn) return;
    btn.textContent = this.state.pipelineEditMode ? 'Done' : 'Edit';
    btn.classList.toggle('header-edit-btn--active', this.state.pipelineEditMode);
  },

  // ── Mic state helpers ──────────────────────────────────────────────────────
  _setMicState(state) {
    const btn    = document.getElementById('mic-btn');
    const label  = document.getElementById('mic-label');
    const micSvg = document.getElementById('mic-icon');
    const stopSvg = document.getElementById('stop-icon');
    const spinner = document.getElementById('mic-spinner');
    if (!btn) return;

    btn.className = 'mic-btn';
    micSvg?.classList.remove('hidden');
    stopSvg?.classList.add('hidden');
    spinner?.classList.add('hidden');

    if (state === 'listening') {
      btn.classList.add('mic-btn--listening');
      micSvg?.classList.add('hidden');
      stopSvg?.classList.remove('hidden');
      if (label) label.textContent = 'Tap to stop';
    } else if (state === 'processing') {
      btn.classList.add('mic-btn--processing');
      micSvg?.classList.add('hidden');
      spinner?.classList.remove('hidden');
      if (label) label.textContent = 'Parsing…';
    } else {
      if (label) label.textContent = 'Tap to speak a task';
    }
  },

  _toggleAssigneeFAB(open) {
    const dial = document.getElementById('assignee-fab');
    const backdrop = document.getElementById('assignee-fab-backdrop');
    if (!dial) return;
    const next = open !== undefined ? open : !dial.classList.contains('open');
    dial.classList.toggle('open', next);
    backdrop?.classList.toggle('open', next);
  },

  // ── Preview card ───────────────────────────────────────────────────────────
  // ── Toast ──────────────────────────────────────────────────────────────────
  showToast(msg, isError = false, undoFn = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(this._toastTimer);

    if (undoFn) {
      toast.innerHTML = `<span>${escapeHTML(msg)}</span><button class="toast-undo-btn">Undo</button>`;
      toast.className = 'toast toast--show' + (isError ? ' toast--error' : '');
      const undoBtn = toast.querySelector('.toast-undo-btn');
      const cleanup = () => { clearTimeout(this._toastTimer); toast.className = 'toast'; undoBtn.removeEventListener('click', onUndo); };
      const onUndo  = () => { cleanup(); undoFn(); };
      undoBtn.addEventListener('click', onUndo);
      this._toastTimer = setTimeout(cleanup, 4000);
    } else {
      toast.textContent = msg;
      toast.className   = 'toast toast--show' + (isError ? ' toast--error' : '');
      this._toastTimer  = setTimeout(() => { toast.className = 'toast'; }, 3200);
    }
  },

};

// ── Auth screen event bindings ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Auth form — send OTP code to email
  document.getElementById('auth-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('auth-email')?.value.trim();
    if (!email) return;
    const btn = document.getElementById('auth-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      // Persist invite token in case the user signs in via the email link instead
      if (App.state.pendingInviteToken) {
        sessionStorage.setItem('vtm_pending_invite', App.state.pendingInviteToken);
      }
      await Auth.sendOtp(email);
      document.getElementById('auth-form-wrap').classList.add('hidden');
      document.getElementById('auth-title')?.classList.add('hidden');
      document.getElementById('auth-subtitle')?.classList.add('hidden');
      document.getElementById('auth-otp-email').textContent = email;
      document.getElementById('auth-otp-wrap').classList.remove('hidden');
      setTimeout(() => document.getElementById('auth-otp-input')?.focus(), 50);
    } catch (err) {
      App.showToast(err.message || 'Could not send code', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Code';
    }
  });

  // OTP form — verify the code
  document.getElementById('auth-otp-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('auth-otp-email')?.textContent.trim();
    const code  = document.getElementById('auth-otp-input')?.value.trim();
    if (!email || !code) return;
    const btn = document.getElementById('auth-otp-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';

    try {
      await Auth.verifyOtp(email, code);
      // SIGNED_IN auth event takes over routing from here
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In';
      App.showToast(err.message || 'Invalid or expired code', true);
      const input = document.getElementById('auth-otp-input');
      if (input) { input.value = ''; input.focus(); }
    }
  });

  // Back to email entry
  document.getElementById('auth-otp-back')?.addEventListener('click', () => {
    document.getElementById('auth-otp-wrap').classList.add('hidden');
    document.getElementById('auth-form-wrap').classList.remove('hidden');
    document.getElementById('auth-title')?.classList.remove('hidden');
    document.getElementById('auth-subtitle')?.classList.remove('hidden');
  });

  // Onboarding form
  document.getElementById('onboard-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const nameInput = document.getElementById('onboard-name');
    const name = nameInput?.value.trim();
    if (!name) { nameInput?.focus(); return; }

    const forceRole  = nameInput?.dataset.forceRole;
    const inviteId   = nameInput?.dataset.inviteId;
    const assignerId = nameInput?.dataset.assignerId;

    let role = forceRole;
    if (!role) {
      const roleInput = document.querySelector('input[name="role"]:checked');
      role = roleInput?.value;
    }
    if (!role) { App.showToast('Please select a role', true); return; }

    const btn = document.getElementById('onboard-btn');
    btn.disabled = true;
    btn.textContent = 'Setting up…';

    try {
      await Auth.createProfile(name, role);

      // Accept pending invite if we arrived via invite link
      if (inviteId && assignerId) {
        await Invite.accept(inviteId, assignerId);
      } else if (App.state.pendingInviteToken) {
        await Invite.autoAcceptPending(App.state.pendingInviteToken);
      }

      // Boot the right app
      if (role === 'assigner') await App._bootAssigner();
      else                      await App._bootAssignee();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Continue';
      App.showToast(err.message || 'Could not create profile', true);
    }
  });

  App.init();
});

// ── iOS safe-area layout fix (same as v1) ──────────────────────────────────────
(function fixIOSLayout() {
  const root = document.documentElement;

  function measureSafeBottom() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:-9999px;width:1px;height:0;padding-bottom:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden';
    document.body.appendChild(probe);
    const value = probe.getBoundingClientRect().height || 0;
    document.body.removeChild(probe);
    return value;
  }

  function applyLayout() {
    // Browser mode only — standalone mode is handled in CSS with 100vh,
    // the sole viewport unit that is correct on PWA cold start (dvh and
    // innerHeight report stale values until the device is rotated).
    root.style.setProperty('--real-height', `${window.innerHeight}px`);
    root.style.setProperty('--safe-bottom-px', `${measureSafeBottom()}px`);
  }

  function run() { applyLayout(); setTimeout(applyLayout, 80); setTimeout(applyLayout, 400); setTimeout(applyLayout, 1200); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  window.addEventListener('resize', applyLayout, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(applyLayout, 120), { passive: true });
  window.visualViewport?.addEventListener('resize', applyLayout, { passive: true });
})();
