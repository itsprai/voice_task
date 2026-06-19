// ─────────────────────────────────────────────────────────────────────────────
//  invite.js — Invite flow
//
//  Assigner side:  create invite → get shareable link
//  Assignee side:  read invite by token → magic-link login → accept invite
// ─────────────────────────────────────────────────────────────────────────────

const Invite = {

  // ── Parse invite token from current URL ──────────────────────────────────
  // Returns null if no ?invite=TOKEN param is present.
  getTokenFromURL() {
    return new URLSearchParams(window.location.search).get('invite') || null;
  },

  // ── Fetch invite data by token ────────────────────────────────────────────
  // Calls the SECURITY DEFINER function get_invite() — the invites table no
  // longer allows direct SELECT for anon, so this controlled function is the
  // only way to read an invite by its token.
  async fetchByToken(token) {
    if (!SupabaseClient || !token) return null;
    const { data, error } = await SupabaseClient
      .rpc('get_invite', { _token: token });
    if (error || !data) return null;
    // rpc returns the invite row directly (function is SETOF-less, returns
    // a single composite row). Older Supabase JS clients sometimes wrap in
    // array — handle both shapes defensively.
    const invite = Array.isArray(data) ? data[0] : data;
    if (!invite) return null;

    // The old query joined assigner_id → profiles.full_name. RPC can't do
    // joins, so fetch the manager's name separately. Profile reads are
    // already permitted to authenticated users via profiles_team_read.
    if (invite.assigner_id) {
      const { data: prof } = await SupabaseClient
        .from('profiles')
        .select('full_name')
        .eq('id', invite.assigner_id)
        .single();
      invite.assigner = prof ? { full_name: prof.full_name } : null;
    }
    return invite;
  },

  // ── Assigner: create a new invite and return the shareable link ───────────
  async create(name, email) {
    if (!SupabaseClient || !Auth.profile) throw new Error('Not authenticated');
    const { data, error } = await SupabaseClient
      .from('invites')
      .insert({
        assigner_id: Auth.profile.id,
        name:        name.trim(),
        email:       email.trim().toLowerCase()
      })
      .select()
      .single();
    if (error) throw error;
    return { invite: data, link: this._makeLink(data.token) };
  },

  // ── Email the invite to the team member via Edge Function ─────────────────
  // Returns { sent, existing? }. Throws if the email could not be sent.
  async sendEmail(invite) {
    if (!SupabaseClient) throw new Error('Supabase not configured');
    const { data, error } = await SupabaseClient.functions.invoke('send-invite', {
      body: {
        email:       invite.email,
        name:        invite.name,
        inviteToken: invite.token,
        appUrl:      CONFIG.APP_URL
      }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  },

  // ── Fetch all invites created by the current assigner ────────────────────
  async listByAssigner() {
    if (!SupabaseClient || !Auth.profile) return [];
    const { data } = await SupabaseClient
      .from('invites')
      .select('id, name, email, token, status, created_at')
      .eq('assigner_id', Auth.profile.id)
      .order('created_at', { ascending: false });
    return data ?? [];
  },

  // ── Assignee: accept invite and link to assigner ──────────────────────────
  // Called after the assignee has completed onboarding (profile created).
  async accept(inviteId, assignerId) {
    if (!SupabaseClient || !Auth.profile) throw new Error('Not authenticated');

    // 1. Create the assigner↔assignee relationship.
    // ignoreDuplicates → ON CONFLICT DO NOTHING: the map table has no UPDATE
    // policy, so a plain upsert 403s when the row already exists.
    const { error: mapErr } = await SupabaseClient
      .from('assigner_assignee_map')
      .upsert(
        { assigner_id: assignerId, assignee_id: Auth.profile.id },
        { ignoreDuplicates: true }
      );
    if (mapErr) throw mapErr;

    // 2. Mark invite as accepted
    const { error: updErr } = await SupabaseClient
      .from('invites')
      .update({ status: 'accepted' })
      .eq('id', inviteId);
    if (updErr) throw updErr;
  },

  // ── Accept any pending invites addressed to this user's email ─────────────
  // Safety net for sessions where the invite token was lost (e.g. the user
  // logged in directly instead of via the invite link).
  async acceptAllForEmail() {
    if (!SupabaseClient || !Auth.profile || !Auth.user?.email) return;
    const { data } = await SupabaseClient
      .from('invites')
      .select('id, assigner_id')
      .eq('email', Auth.user.email.toLowerCase())
      .eq('status', 'pending');
    for (const inv of data ?? []) {
      try { await this.accept(inv.id, inv.assigner_id); }
      catch (e) { console.warn('Invite auto-accept failed:', e); }
    }
  },

  // ── Check for pending invites for this user's email and auto-accept ───────
  // Called after onboarding when the user registered via an invite link.
  async autoAcceptPending(inviteToken) {
    if (!inviteToken || !Auth.profile) return;
    const invite = await this.fetchByToken(inviteToken);
    if (!invite || invite.status === 'accepted') return;
    await this.accept(invite.id, invite.assigner_id);
  },

  // ── Generate a shareable invite link ─────────────────────────────────────
  _makeLink(token) {
    const base = CONFIG.APP_URL.replace(/\/$/, '');
    return `${base}/?invite=${token}`;
  },

  // ── Copy link to clipboard, return true on success ────────────────────────
  async copyLink(token) {
    const link = this._makeLink(token);
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false;
    }
  },

  // ── Native share (if supported) ───────────────────────────────────────────
  async share(name, token) {
    const link = this._makeLink(token);
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join me on TaskVoice',
          text:  `${Auth.profile?.full_name || 'Your manager'} has invited you to TaskVoice. Tap to get started.`,
          url:   link
        });
        return true;
      } catch { /* user cancelled */ }
    }
    return false;
  }
};
