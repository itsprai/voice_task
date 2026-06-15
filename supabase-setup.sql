-- ─────────────────────────────────────────────────────────────────────────────
--  TaskVoice v2 — Supabase Setup Script
--
--  Run this once in:
--    Supabase Dashboard → SQL Editor → New Query → paste → Run
--
--  Works on a FRESH Supabase project (no prior tables needed).
--  Also safe to run on an existing v1 database — all statements are
--  idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
--  Structure: ALL table DDL first → ALL policies last.
--  This avoids pre-validation errors on columns added by ALTER TABLE.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
--  PHASE 1 — TABLE STRUCTURE
--  (extensions, CREATE TABLE, ALTER TABLE, indexes, enable RLS)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ── profiles ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT        NOT NULL,
  role       TEXT        NOT NULL CHECK (role IN ('assigner', 'assignee')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;


-- ── invites ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invites (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  assigner_id UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  token       UUID        NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;


-- ── assigner_assignee_map ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assigner_assignee_map (
  assigner_id UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assignee_id UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (assigner_id, assignee_id)
);
ALTER TABLE public.assigner_assignee_map ENABLE ROW LEVEL SECURITY;


-- ── tasks ─────────────────────────────────────────────────────────────────────
--  CREATE TABLE covers fresh DB; ALTER TABLE covers v1 → v2 upgrade.
CREATE TABLE IF NOT EXISTS public.tasks (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  description TEXT        NOT NULL,
  assignee    TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  "dueDate"   TEXT,
  time        TEXT,
  "dueAt"     BIGINT,      -- epoch milliseconds (matches app's Date.getTime())
  raw         TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  assigner_id UUID        REFERENCES public.profiles(id),
  assignee_id UUID        REFERENCES public.profiles(id),
  added_by    UUID        REFERENCES public.profiles(id)
);
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS assigner_id UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS assignee_id UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS added_by    UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS recurrence  TEXT  NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS priority    TEXT  NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS notes       TEXT  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS subtasks    JSONB NOT NULL DEFAULT '[]'::jsonb;

-- CHECK constraints (re-runnable: dropped + readded)
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_recurrence_check
  CHECK (recurrence IN ('none','hourly','daily','weekdays','weekends','weekly','fortnightly','monthly','quarterly','biannually','yearly'));

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_priority_check
  CHECK (priority IN ('normal','urgent'));

CREATE INDEX IF NOT EXISTS idx_tasks_assigner ON public.tasks (assigner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks (assignee_id);
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;


-- ── push_subscriptions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  endpoint   TEXT        PRIMARY KEY,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  user_id    UUID        REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- v1 → v2 upgrade: v1 table existed without user_id
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;


-- ── sent_notifications ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sent_notifications (
  task_id TEXT        PRIMARY KEY,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.sent_notifications ENABLE ROW LEVEL SECURITY;


-- ── user_preferences ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id UUID  NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  key     TEXT  NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════
--  PHASE 2 — ROW LEVEL SECURITY POLICIES
--  (all table structure is committed above; column lookups are safe here)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── profiles policies ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "profiles_self_read"  ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_team_read"  ON public.profiles;

CREATE POLICY "profiles_self_read" ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

CREATE POLICY "profiles_self_insert" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_self_update" ON public.profiles
  FOR UPDATE TO authenticated USING (id = auth.uid());

-- Other users' profiles are readable (team display, invite lookup)
CREATE POLICY "profiles_team_read" ON public.profiles
  FOR SELECT TO authenticated USING (true);


-- ── invites policies ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "invites_assigner_all"      ON public.invites;
DROP POLICY IF EXISTS "invites_anon_read_by_token" ON public.invites;
DROP POLICY IF EXISTS "invites_assignee_accept"    ON public.invites;

CREATE POLICY "invites_assigner_all" ON public.invites
  FOR ALL TO authenticated
  USING (assigner_id = auth.uid())
  WITH CHECK (assigner_id = auth.uid());

CREATE POLICY "invites_anon_read_by_token" ON public.invites
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "invites_assignee_accept" ON public.invites
  FOR UPDATE TO authenticated
  USING (true) WITH CHECK (status = 'accepted');


-- ── assigner_assignee_map policies ────────────────────────────────────────────
DROP POLICY IF EXISTS "map_assigner_read"    ON public.assigner_assignee_map;
DROP POLICY IF EXISTS "map_assignee_read"    ON public.assigner_assignee_map;
DROP POLICY IF EXISTS "map_insert_on_accept" ON public.assigner_assignee_map;
DROP POLICY IF EXISTS "map_assigner_delete"  ON public.assigner_assignee_map;
DROP POLICY IF EXISTS "map_assignee_delete"  ON public.assigner_assignee_map;

CREATE POLICY "map_assigner_read" ON public.assigner_assignee_map
  FOR SELECT TO authenticated USING (assigner_id = auth.uid());

CREATE POLICY "map_assignee_read" ON public.assigner_assignee_map
  FOR SELECT TO authenticated USING (assignee_id = auth.uid());

CREATE POLICY "map_insert_on_accept" ON public.assigner_assignee_map
  FOR INSERT TO authenticated WITH CHECK (assignee_id = auth.uid());

-- DELETE: managers can remove team members; team members can unlink themselves
CREATE POLICY "map_assigner_delete" ON public.assigner_assignee_map
  FOR DELETE TO authenticated USING (assigner_id = auth.uid());

CREATE POLICY "map_assignee_delete" ON public.assigner_assignee_map
  FOR DELETE TO authenticated USING (assignee_id = auth.uid());


-- ── tasks policies ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_tasks"       ON public.tasks;
DROP POLICY IF EXISTS "tasks_all_access"     ON public.tasks;
DROP POLICY IF EXISTS "tasks_visibility"     ON public.tasks;
DROP POLICY IF EXISTS "tasks_assigner_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks_assignee_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks_update"         ON public.tasks;
DROP POLICY IF EXISTS "tasks_delete"         ON public.tasks;

-- SELECT: only tasks you're part of (as assigner or assignee)
CREATE POLICY "tasks_visibility" ON public.tasks
  FOR SELECT TO authenticated
  USING (
    assigner_id = auth.uid()
    OR assignee_id = auth.uid()
  );

CREATE POLICY "tasks_assigner_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    assigner_id = auth.uid()
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'assigner'
  );

CREATE POLICY "tasks_assignee_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    assignee_id = auth.uid()
    AND added_by = auth.uid()
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'assignee'
  );

CREATE POLICY "tasks_update" ON public.tasks
  FOR UPDATE TO authenticated
  USING (assigner_id = auth.uid() OR assignee_id = auth.uid());

CREATE POLICY "tasks_delete" ON public.tasks
  FOR DELETE TO authenticated
  USING (assigner_id = auth.uid() OR added_by = auth.uid());


-- ── push_subscriptions policies ───────────────────────────────────────────────
DROP POLICY IF EXISTS "push_user_manage"       ON public.push_subscriptions;
DROP POLICY IF EXISTS "anon_upsert_subscription" ON public.push_subscriptions;
DROP POLICY IF EXISTS "anon_read_subscription"   ON public.push_subscriptions;

CREATE POLICY "push_user_manage" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ── user_preferences policies ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "prefs_self" ON public.user_preferences;

CREATE POLICY "prefs_self" ON public.user_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ═══════════════════════════════════════════════════════════════════════════
--  MIGRATION NOTE (v1 → v2 only — skip on fresh DB)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  After running this script:
--  1. Sign up as the owner assigner account in the app
--  2. Copy that user's UUID from: Dashboard → Authentication → Users → User UID
--  3. Run the following in a new SQL Editor query (replace OWNER_UUID):
--
--  UPDATE public.tasks
--    SET assigner_id = 'OWNER_UUID', added_by = 'OWNER_UUID'
--    WHERE assigner_id IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
--  PUSH NOTIFICATION CRON (run separately AFTER deploying Edge Function)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;
--  CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
--
--  SELECT cron.unschedule('send-task-reminders-v2')
--    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-task-reminders-v2');
--
--  SELECT cron.schedule(
--    'send-task-reminders-v2', '*/5 * * * *',
--    $$
--    SELECT net.http_post(
--      url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/send-reminders',
--      headers := jsonb_build_object(
--        'Authorization', 'Bearer <YOUR_SERVICE_ROLE_KEY>',
--        'Content-Type',  'application/json'
--      ),
--      body    := '{}'::jsonb
--    );
--    $$
--  );


-- ─────────────────────────────────────────────────────────────────────────────
--  Done! Next steps:
--  1. Dashboard → Authentication → Providers → Email → Enable, Confirm email OFF
--  2. Dashboard → Authentication → URL Configuration
--     → Site URL = your app URL  (e.g. http://localhost:8080/webapp-v2/)
--     → Redirect URLs → Add same URL
--  3. Fill in webapp-v2/config.js with your project URL + anon key
-- ─────────────────────────────────────────────────────────────────────────────
