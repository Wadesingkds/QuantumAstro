-- ============================================================================
-- UTM Attribution Migration
-- Tracks signup source for marketing analytics
-- Run in Supabase SQL Editor
-- ============================================================================

-- 1. Create attribution table
CREATE TABLE IF NOT EXISTS signup_attribution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  referrer TEXT,
  landing_page TEXT,
  user_agent TEXT,
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_attr_source ON signup_attribution(utm_source);
CREATE INDEX IF NOT EXISTS idx_attr_campaign ON signup_attribution(utm_campaign);
CREATE INDEX IF NOT EXISTS idx_attr_signed_up ON signup_attribution(signed_up_at DESC);
CREATE INDEX IF NOT EXISTS idx_attr_user_id ON signup_attribution(user_id);

-- 3. RLS — only service role + user themselves can read
ALTER TABLE signup_attribution ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own attribution" ON signup_attribution;
CREATE POLICY "Users read own attribution" ON signup_attribution
  FOR SELECT USING (
    auth.uid() = user_id
    OR auth.role() = 'service_role'
  );

DROP POLICY IF EXISTS "Service role insert" ON signup_attribution;
CREATE POLICY "Service role insert" ON signup_attribution
  FOR INSERT WITH CHECK (auth.role() = 'service_role' OR auth.uid() = user_id);

-- 4. Trigger function — auto-extract from auth.users.raw_user_meta_data
CREATE OR REPLACE FUNCTION capture_signup_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  has_utm BOOLEAN;
BEGIN
  -- Skip if no UTM data
  has_utm := (
    NEW.raw_user_meta_data->>'utm_source' IS NOT NULL
    OR NEW.raw_user_meta_data->>'utm_campaign' IS NOT NULL
    OR NEW.raw_user_meta_data->>'utm_medium' IS NOT NULL
  );
  IF NOT has_utm THEN
    RETURN NEW;
  END IF;

  -- Insert if not exists (handles both signUp INSERT and Google OAuth UPDATE)
  INSERT INTO signup_attribution (
    user_id, email,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    referrer, landing_page, user_agent
  ) VALUES (
    NEW.id, NEW.email,
    NEW.raw_user_meta_data->>'utm_source',
    NEW.raw_user_meta_data->>'utm_medium',
    NEW.raw_user_meta_data->>'utm_campaign',
    NEW.raw_user_meta_data->>'utm_content',
    NEW.raw_user_meta_data->>'utm_term',
    NEW.raw_user_meta_data->>'referrer',
    NEW.raw_user_meta_data->>'landing_page',
    NEW.raw_user_meta_data->>'user_agent'
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Don't block signup if attribution fails
  RAISE WARNING 'Attribution capture failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- Unique constraint to prevent duplicate attribution per user
ALTER TABLE signup_attribution
  DROP CONSTRAINT IF EXISTS signup_attribution_user_id_key;
ALTER TABLE signup_attribution
  ADD CONSTRAINT signup_attribution_user_id_key UNIQUE (user_id);

-- 5. Trigger on new user creation AND user metadata update
DROP TRIGGER IF EXISTS on_auth_user_created_attribution ON auth.users;
CREATE TRIGGER on_auth_user_created_attribution
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION capture_signup_attribution();

DROP TRIGGER IF EXISTS on_auth_user_metadata_update ON auth.users;
CREATE TRIGGER on_auth_user_metadata_update
  AFTER UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW
  WHEN (OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data)
  EXECUTE FUNCTION capture_signup_attribution();

-- ============================================================================
-- ANALYTICS QUERIES (save these for later)
-- ============================================================================

-- Signups by source (last 30 days)
-- SELECT
--   COALESCE(utm_source, '(direct)') as source,
--   COALESCE(utm_campaign, '(none)') as campaign,
--   COUNT(*) as signups
-- FROM signup_attribution
-- WHERE signed_up_at > NOW() - INTERVAL '30 days'
-- GROUP BY 1, 2
-- ORDER BY signups DESC;

-- Conversion: signups -> paying customers by source
-- SELECT
--   COALESCE(a.utm_source, '(direct)') as source,
--   COALESCE(a.utm_campaign, '(none)') as campaign,
--   COUNT(DISTINCT a.user_id) as signups,
--   COUNT(DISTINCT s.user_id) FILTER (WHERE s.status = 'active') as paying,
--   ROUND(100.0 * COUNT(DISTINCT s.user_id) FILTER (WHERE s.status = 'active')
--     / NULLIF(COUNT(DISTINCT a.user_id), 0), 2) as conv_rate_pct
-- FROM signup_attribution a
-- LEFT JOIN subscriptions s ON s.user_id = a.user_id
-- GROUP BY 1, 2
-- ORDER BY paying DESC NULLS LAST;
