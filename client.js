// Shared Supabase JS v2 client — imported by Auth, Sync, Invite
// Loaded immediately after config.js so all modules can reference SupabaseClient.

const SupabaseClient = (
  CONFIG.SUPABASE_URL &&
  CONFIG.SUPABASE_URL !== 'https://your-project.supabase.co' &&
  window.supabase
)
  ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession:   true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;
