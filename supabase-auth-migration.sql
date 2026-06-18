-- Quantum Leaps Subscription Table — v2 (user_id based)
-- Run this in Supabase SQL Editor
-- This migration adds user_id column and migrates primary key from email to user_id

-- 1. Add user_id column (nullable at first for migration)
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Add index for fast lookup by user_id
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

-- 3. Update plan check to remove monthly (no longer offered)
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('lifetime'));

-- 4. Drop old public read-all policy (too permissive — anyone could read anyone's subscription)
DROP POLICY IF EXISTS "Allow public read by email" ON subscriptions;

-- 5. New RLS: users can only read their own subscription
CREATE POLICY "Users read own subscription" ON subscriptions
  FOR SELECT USING (
    auth.uid() = user_id
    OR auth.role() = 'service_role'
  );

-- 6. Service role can do everything (for webhook activation)
-- Already exists: "Allow service role all"
