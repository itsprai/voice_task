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

    // Sign out buttons (both roles) — switch screens immediately, don't wait
    // for the auth event
    ['assigner-signout-btn', 'assignee-signout-btn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', async () => {
        if (!confirm('Sign out?')) return;
        try { await Auth.signOut(); } catch (e) { console.warn('Sign out error:', e); }
        this._showScreen('auth');
      });
    });

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
    this._showScreen('auth');
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
      document.getElementById('auth-title').textContent   = '👋 You\'ve been invited!';
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
      this._initNotifBanner();
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
      this._setPipelineFABState('idle');
    }

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

  // ── Pipeline FAB mic ───────────────────────────────────────────────────────
  _bindPipelineFAB() {
    document.getElementById('pipeline-fab-btn')?.addEventListener('click', () => {
      if (!this.state.activePersonId) return;
      if (this.state.voiceContext === 'general' && this.voice.listening) return;
      this.state.voiceContext = 'fab';
      this.voice.start();
    });
  },

  _updatePipelineFAB() {
    const wrapper = document.getElementById('pipeline-fab-wrapper');
    const label   = document.getElementById('pipeline-fab-label');
    const pid     = this.state.activePersonId;
    const member  = this.state.team.find(m => m.id === pid);
    if (member) {
      wrapper?.classList.remove('hidden');
      if (label) label.textContent = `For ${member.full_name}`;
    } else {
      wrapper?.classList.add('hidden');
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

  _bindVoiceEvents() {
    document.getElementById('voice-overlay-stop')?.addEventListener('click', () => {
      this.voice?.stop();
    });

    document.addEventListener('voice:start', () => {
      if (this.state.voiceContext === 'fab') {
        this._setPipelineFABState('listening');
      } else {
        this._setMicState('listening');
        this._showVoiceOverlay(true, 'Listening…');
        const tt = document.getElementById('transcript-text');
        if (tt) tt.textContent = 'Listening…';
        document.getElementById('task-preview')?.classList.add('hidden');
      }
    });

    document.addEventListener('voice:interim', e => {
      if (this.state.voiceContext === 'fab') return;
      if (e.detail) this._showVoiceOverlay(true, `“${e.detail}”`);
      const tt = document.getElementById('transcript-text');
      if (tt && e.detail) tt.textContent = e.detail;
    });

    document.addEventListener('voice:result', async e => {
      const transcript = e.detail;
      const isFAB = this.state.voiceContext === 'fab';
      this.state.voiceContext = 'general';
      this._showVoiceOverlay(false);

      if (!isFAB) {
        const tt = document.getElementById('transcript-text');
        if (tt) tt.textContent = transcript;
        this._setMicState('processing');
      } else {
        this._setPipelineFABState('processing');
      }

      try {
        let tasks = await Parser.parse(transcript, this.state.team);

        // Pipeline FAB: override assignee with the active tab's member
        if (isFAB && this.state.activePersonId) {
          const member = this.state.team.find(m => m.id === this.state.activePersonId);
          if (member) {
            tasks = tasks.map(t => ({
              ...t,
              assignee:    member.full_name,
              assignee_id: member.id
            }));
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

        if (!isFAB) this._showPreview(tasks);

        const activeMember = isFAB ? this.state.team.find(m => m.id === this.state.activePersonId) : null;
        const msg = activeMember
          ? `Task${tasks.length > 1 ? 's' : ''} assigned to ${activeMember.full_name}!`
          : (tasks.length > 1 ? `${tasks.length} tasks saved!` : 'Task saved!');
        this.showToast(msg);
        this._refreshCurrentPage();
        this._updatePipelineBadge();
      } catch (err) {
        this.showToast(err.message || 'Could not parse task. Try again.', true);
      } finally {
        this._setMicState('idle');
        this._setPipelineFABState('idle');
      }
    });

    document.addEventListener('voice:error', e => {
      this.state.voiceContext = 'general';
      this._showVoiceOverlay(false);
      this.showToast(e.detail, true);
      this._setMicState('idle');
      this._setPipelineFABState('idle');
    });

    document.addEventListener('voice:end', () => {
      if (this.state.voiceContext === 'fab') return;
      this._showVoiceOverlay(false);
      if (!this.voice._transcript?.trim()) this._setMicState('idle');
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
          if (next === 'completed') Notifications.cancelLocal(task.id);
          else Notifications.scheduleLocal({ ...task, status: 'pending' });
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
        const pid = deleteTab.dataset.personId;
        // Remove from team: delete from assigner_assignee_map + remove tasks from local
        if (!confirm(`Remove this person from your team? Their tasks will be deleted.`)) return;
        if (SupabaseClient && Auth.profile) {
          await SupabaseClient.from('assigner_assignee_map')
            .delete().eq('assigner_id', Auth.profile.id).eq('assignee_id', pid);
        }
        this.state.team = this.state.team.filter(m => m.id !== pid);
        this.state.tasks = this.state.tasks.filter(t => t.assignee_id !== pid);
        this.state.nameMap = Object.fromEntries(this.state.team.map(m => [m.id, m.full_name]));
        if (this.state.activePersonId === pid) this.state.activePersonId = null;
        this._renderPipeline();
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
              <p class="invite-result-label">✅ ${escapeHTML(memberName)} is already on TaskVoice — added to your team!</p>
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
              <p class="invite-result-label">✉️ Invite email sent to ${escapeHTML(email)}</p>
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
        const dueAt = date && time ? new Date(`${date}T${time}`).getTime() : null;
        this.state.tasks = Storage.update(id, { description: desc, dueDate: date || null, time: time || null, dueAt });
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
          if (next === 'completed') Notifications.cancelLocal(task.id);
          else Notifications.scheduleLocal({ ...task, status: 'pending' });
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

        const member = this.state.team.find(m => m.id === this.state.activePersonId);
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
          if (next === 'completed') Notifications.cancelLocal(task.id);
          else Notifications.scheduleLocal({ ...task, status: 'pending' });
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
        const dueAt = date && time ? new Date(`${date}T${time}`).getTime() : null;
        this.state.tasks = Storage.update(id, { description: desc, dueDate: date || null, time: time || null, dueAt });
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

    // Add task form
    document.getElementById('assignee-add-task-btn')?.addEventListener('click', () => {
      this.state.showAssigneeAddForm = !this.state.showAssigneeAddForm;
      if (formSlot) {
        formSlot.innerHTML = this.state.showAssigneeAddForm
          ? renderAssigneeAddTaskForm(this.state.assigners, this.state.activeAssignerId)
          : '';
      }
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

      const _date = dateInput.value || new Date().toISOString().split('T')[0];
      const _time = timeInput?.value || new Date().toTimeString().slice(0, 5);

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
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString()
      };

      this.state.tasks = Storage.add(newTask);
      Notifications.scheduleLocal(newTask);
      this.state.showAssigneeAddForm = false;
      if (formSlot) formSlot.innerHTML = '';
      renderAssigneeTasksPage(this.state.tasks, this.state.assigners, null);
      this._updateAssigneeBadge();
      this.showToast('Task added!');
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
    const count = this.state.tasks.filter(t => t.status !== 'completed').length;
    if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  },

  _updateAssigneeBadge() {
    const badge = document.getElementById('assignee-badge');
    if (!badge) return;
    const count = this.state.tasks.filter(t => t.assignee_id === Auth.profile?.id && t.status !== 'completed').length;
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

  _setPipelineFABState(state) {
    const btn     = document.getElementById('pipeline-fab-btn');
    const micSvg  = document.getElementById('pipeline-fab-mic');
    const stopSvg = document.getElementById('pipeline-fab-stop');
    const spinner = document.getElementById('pipeline-fab-spinner');
    if (!btn) return;

    btn.className = 'pipeline-fab-btn';
    micSvg?.classList.remove('hidden');
    stopSvg?.classList.add('hidden');
    spinner?.classList.add('hidden');

    if (state === 'listening') {
      btn.classList.add('pipeline-fab-btn--listening');
      micSvg?.classList.add('hidden');
      stopSvg?.classList.remove('hidden');
    } else if (state === 'processing') {
      btn.classList.add('pipeline-fab-btn--processing');
      micSvg?.classList.add('hidden');
      spinner?.classList.remove('hidden');
    }
  },

  // ── Preview card ───────────────────────────────────────────────────────────
  _showPreview(tasks) {
    const el = document.getElementById('task-preview');
    if (!el) return;
    el.innerHTML = `
      <p class="preview-label">${tasks.length > 1 ? tasks.length + ' tasks saved' : 'Task saved'}</p>
      ${tasks.map(t => `
        <div class="preview-item">
          <p class="preview-desc">${escapeHTML(t.description)}</p>
          <div class="preview-meta">
            <span class="chip chip--assignee">${escapeHTML(t.assignee)}</span>
            ${t.dueDate ? `<span class="chip chip--date">${formatDate(t.dueDate)}</span>` : ''}
          </div>
        </div>
      `).join('')}
    `;
    el.classList.remove('hidden');
  },

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

  // ── Notification bell (home header) ────────────────────────────────────────
  async _initNotifBanner() {
    const btn = document.getElementById('notif-bell-btn');
    if (!btn) return;

    const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    const isIOS  = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const hasAPI = 'Notification' in window;

    const setOn  = () => { btn.classList.add('notif-bell--on');    btn.title = 'Notifications on — tap to disable'; };
    const setOff = () => { btn.classList.remove('notif-bell--on'); btn.title = 'Enable notifications'; };

    if ((isIOS && !isStandalone) || !hasAPI) {
      btn.addEventListener('click', () => {
        this.showToast(isIOS ? 'Add to Home Screen to enable notifications' : 'Notifications not supported in this browser', true);
      });
      return;
    }
    const subscribed = Notification.permission === 'granted' && await Notifications.isSubscribed();
    if (subscribed) setOn();

    btn.addEventListener('click', () => {
      if (Notification.permission === 'denied') { this.showToast('Enable notifications in your browser settings'); return; }
      if (btn.classList.contains('notif-bell--on')) {
        Notifications.unsubscribe().then(() => { setOff(); this.showToast('Notifications disabled'); });
        return;
      }
      if (Notification.permission === 'granted') {
        Notifications._subscribePush().then(() => { setOn(); this.showToast('Notifications enabled'); });
        return;
      }
      Notification.requestPermission().then(async result => {
        if (result === 'granted') { await Notifications._subscribePush(); setOn(); this.showToast('Notifications enabled'); }
        else if (result === 'denied') { this.showToast('Notifications blocked in browser settings', true); }
      });
    });
  }
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
    // CSS anchors all screens to var(--real-height); env() handles safe areas
    root.style.setProperty('--real-height', `${window.innerHeight}px`);
    root.style.setProperty('--safe-bottom-px', `${measureSafeBottom()}px`);
  }

  function run() { applyLayout(); setTimeout(applyLayout, 80); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  window.addEventListener('resize', applyLayout, { passive: true });
})();
