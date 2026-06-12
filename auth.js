// ─────────────────────────────────────────────────────────────────────────────
//  auth.js — Supabase Auth wrapper
//  Handles session, email-OTP login, profile creation, sign-out.
// ─────────────────────────────────────────────────────────────────────────────

const Auth = {
  _session: null,
  _profile: null,

  get session()  { return this._session; },
  get profile()  { return this._profile; },
  get user()     { return this._session?.user ?? null; },
  get isAuthed() { return !!this._session; },

  // ── Call once from App.init() ─────────────────────────────────────────────
  // Sets up the auth state listener and resolves the initial session.
  // Returns the current session (or null if not logged in).
  async init() {
    if (!SupabaseClient) return null;

    // Listen for auth state changes (magic-link callback, token refresh, etc.)
    SupabaseClient.auth.onAuthStateChange(async (event, session) => {
      this._session = session;
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        document.dispatchEvent(new CustomEvent('auth:signed-in', { detail: session }));
      } else if (event === 'SIGNED_OUT') {
        this._profile = null;
        document.dispatchEvent(new CustomEvent('auth:signed-out'));
      }
    });

    const { data: { session } } = await SupabaseClient.auth.getSession();
    this._session = session;
    return session;
  },

  // ── Send 6-digit OTP code to email ────────────────────────────────────────
  async sendOtp(email) {
    if (!SupabaseClient) throw new Error('Supabase not configured');
    const { error } = await SupabaseClient.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: CONFIG.APP_URL }
    });
    if (error) throw error;
  },

  // ── Verify OTP code and create the session ───────────────────────────────
  async verifyOtp(email, code) {
    if (!SupabaseClient) throw new Error('Supabase not configured');
    const { data, error } = await SupabaseClient.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type:  'email'
    });
    if (error) throw error;
    return data.session;
  },

  // ── Sign out ──────────────────────────────────────────────────────────────
  async signOut() {
    if (!SupabaseClient) return;
    await SupabaseClient.auth.signOut();
    this._session = null;
    this._profile = null;
    localStorage.removeItem(CONFIG.STORAGE_KEY);
    localStorage.removeItem('vtm_v2_pinned');
    localStorage.removeItem('vtm_v2_page');
  },

  // ── Load this user's profile from DB ─────────────────────────────────────
  async loadProfile() {
    if (!SupabaseClient || !this.user) return null;
    const { data, error } = await SupabaseClient
      .from('profiles')
      .select('*')
      .eq('id', this.user.id)
      .single();
    if (error || !data) return null;
    this._profile = data;
    return data;
  },

  // ── Create profile during onboarding ─────────────────────────────────────
  async createProfile(fullName, role) {
    if (!SupabaseClient || !this.user) throw new Error('Not authenticated');
    const { data, error } = await SupabaseClient
      .from('profiles')
      .insert({ id: this.user.id, full_name: fullName.trim(), role })
      .select()
      .single();
    if (error) throw error;
    this._profile = data;
    return data;
  },

  // ── JWT token for REST API calls ──────────────────────────────────────────
  get token() {
    return this._session?.access_token ?? CONFIG.SUPABASE_ANON_KEY;
  }
};
