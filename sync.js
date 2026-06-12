// ─────────────────────────────────────────────────────────────────────────────
//  sync.js — Supabase data sync with JWT auth headers (RLS-aware)
// ─────────────────────────────────────────────────────────────────────────────

const Sync = {
  _latest:      null,
  _timer:       null,
  _lastFlushAt: 0,

  get configured() {
    return !!SupabaseClient;
  },

  // Headers using the current user's JWT so RLS policies apply
  _headers() {
    return {
      'Content-Type':  'application/json',
      'apikey':        CONFIG.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${Auth.token}`
    };
  },

  // ── Pull tasks visible to the current user ─────────────────────────────────
  async pull() {
    if (!this.configured) return null;
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/tasks?select=*&order=createdAt.asc`,
      { headers: this._headers() }
    );
    if (!res.ok) throw new Error('DB unreachable');
    return res.json();
  },

  // ── Fetch the current assigner's confirmed team ───────────────────────────
  // Returns [{ id, full_name }] for each confirmed assignee.
  async pullTeam() {
    if (!this.configured || !Auth.profile) return [];
    const profile = Auth.profile;

    if (profile.role === 'assigner') {
      // Get assignee IDs from assigner_assignee_map
      const mapRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/assigner_assignee_map?assigner_id=eq.${profile.id}&select=assignee_id`,
        { headers: this._headers() }
      );
      if (!mapRes.ok) return [];
      const rows = await mapRes.json();
      if (!rows.length) return [];

      // Fetch profiles for those IDs
      const ids = rows.map(r => r.assignee_id).join(',');
      const profRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/profiles?id=in.(${ids})&select=id,full_name`,
        { headers: this._headers() }
      );
      return profRes.ok ? profRes.json() : [];
    }

    if (profile.role === 'assignee') {
      // Get assigner IDs this user belongs to
      const mapRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/assigner_assignee_map?assignee_id=eq.${profile.id}&select=assigner_id`,
        { headers: this._headers() }
      );
      if (!mapRes.ok) return [];
      const rows = await mapRes.json();
      if (!rows.length) return [];

      const ids = rows.map(r => r.assigner_id).join(',');
      const profRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/profiles?id=in.(${ids})&select=id,full_name`,
        { headers: this._headers() }
      );
      return profRes.ok ? profRes.json() : [];
    }

    return [];
  },

  // ── Pull pending invites for the current assigner ─────────────────────────
  async pullPendingInvites() {
    if (!this.configured || Auth.profile?.role !== 'assigner') return [];
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/invites?assigner_id=eq.${Auth.profile.id}&status=eq.pending&select=id,name,email,token`,
      { headers: this._headers() }
    );
    return res.ok ? res.json() : [];
  },

  // ── Push (debounced upsert) ────────────────────────────────────────────────
  push(tasks) {
    if (!this.configured) return;
    this._latest = tasks;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 900);
  },

  _normalize(task) {
    return {
      id:          task.id          ?? null,
      description: task.description ?? '',
      assignee:    task.assignee    ?? '',
      assigner_id: task.assigner_id ?? null,
      assignee_id: task.assignee_id ?? null,
      added_by:    task.added_by    ?? null,
      status:      task.status      ?? 'pending',
      dueDate:     task.dueDate     ?? null,
      time:        task.time        ?? null,
      dueAt:       task.dueAt ? new Date(task.dueAt).getTime() : null,
      raw:         task.raw         ?? '',
      createdAt:   task.createdAt   ?? new Date().toISOString(),
      updatedAt:   new Date().toISOString()
    };
  },

  async _flush() {
    const all = this._latest ?? [];
    this._dispatch('sync:pending');
    try {
      // Only push rows this user is allowed to upsert — one RLS-rejected row
      // would fail the entire batch and nothing would be saved.
      const me = Auth.profile;
      if (!me) { this._dispatch('sync:error'); return; }
      const mine = me.role === 'assigner'
        ? all.filter(t => t.assigner_id === me.id)
        : all.filter(t => t.assignee_id === me.id);

      if (mine.length > 0) {
        const normalized = mine.map(t => this._normalize(t));
        const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/tasks`, {
          method:  'POST',
          headers: { ...this._headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body:    JSON.stringify(normalized)
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error('[Sync] upsert failed:', res.status, errBody);
          throw new Error('Upsert failed');
        }
      }

      // Assigner only: delete remote rows that no longer exist locally.
      // Scoped to added_by=me so tasks created by assignees (which carry this
      // assigner's id but aren't in the local list yet) are never wiped.
      if (me.role === 'assigner') {
        const ids = mine.map(t => t.id);
        const deleteUrl = ids.length > 0
          ? `${CONFIG.SUPABASE_URL}/rest/v1/tasks?id=not.in.(${ids.join(',')})&assigner_id=eq.${me.id}&added_by=eq.${me.id}`
          : `${CONFIG.SUPABASE_URL}/rest/v1/tasks?assigner_id=eq.${me.id}&added_by=eq.${me.id}`;
        await fetch(deleteUrl, { method: 'DELETE', headers: this._headers() });
      }

      this._lastFlushAt = Date.now();
      this._dispatch('sync:ok');
    } catch {
      this._dispatch('sync:error');
    }
  },

  // ── Explicit single-task remote delete ─────────────────────────────────────
  // Used by the delete-with-undo flow; covers rows the diff-delete can't
  // (e.g. an assigner removing a task an assignee created).
  async deleteRemote(id) {
    if (!this.configured || !id) return;
    try {
      await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, {
        method: 'DELETE', headers: this._headers()
      });
      this._lastFlushAt = Date.now();
    } catch (err) {
      console.warn('[Sync] deleteRemote failed:', err);
    }
  },

  // ── Real-time subscription ─────────────────────────────────────────────────
  subscribe(onRemoteChange) {
    if (!SupabaseClient) return;
    const guard = () => {
      if (Date.now() - this._lastFlushAt < 2000) return;
      onRemoteChange();
    };
    SupabaseClient
      .channel('taskvoice-v2-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' },               guard)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invites' },              guard)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assigner_assignee_map' }, guard)
      .subscribe();
  },

  // ── Per-user preferences ───────────────────────────────────────────────────
  async savePreference(key, value) {
    if (!this.configured || !Auth.profile) return;
    try {
      if (value === null || value === '') {
        await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${Auth.profile.id}&key=eq.${encodeURIComponent(key)}`,
          { method: 'DELETE', headers: this._headers() }
        );
      } else {
        await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/user_preferences`, {
          method:  'POST',
          headers: { ...this._headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body:    JSON.stringify({ user_id: Auth.profile.id, key, value })
        });
      }
    } catch (err) {
      console.warn('[Sync] savePreference failed:', err);
    }
  },

  async loadPreference(key) {
    if (!this.configured || !Auth.profile) return null;
    try {
      const res = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${Auth.profile.id}&key=eq.${encodeURIComponent(key)}&select=value`,
        { headers: this._headers() }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data[0]?.value ?? null;
    } catch {
      return null;
    }
  },

  _dispatch(name) {
    document.dispatchEvent(new CustomEvent(name));
  }
};
