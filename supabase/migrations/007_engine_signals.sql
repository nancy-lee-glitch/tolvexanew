-- =========================================================================
-- STAGE 3 MIGRATION 007: Engine Contract Fields & Extended Signal Logging
-- =========================================================================
-- Safe additive updates to public.signals for shared Binary / MT5 engine
-- outputs (engine, profile, platform, expiry, strength, inputs_snapshot,
-- feed_source, valid_until) and WAIT / nullable uncalibrated confidence.

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS engine TEXT,
  ADD COLUMN IF NOT EXISTS profile TEXT,
  ADD COLUMN IF NOT EXISTS platform TEXT,
  ADD COLUMN IF NOT EXISTS expiry TEXT,
  ADD COLUMN IF NOT EXISTS strength TEXT,
  ADD COLUMN IF NOT EXISTS inputs_snapshot JSONB DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS feed_source TEXT,
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- Allow 'WAIT' signals to be audited in addition to directional signals
ALTER TABLE public.signals
  DROP CONSTRAINT IF EXISTS signals_direction_check;

ALTER TABLE public.signals
  ADD CONSTRAINT signals_direction_check
  CHECK (direction IN ('CALL', 'PUT', 'BUY', 'SELL', 'WAIT'));

-- Validate strength labels if supplied
ALTER TABLE public.signals
  DROP CONSTRAINT IF EXISTS signals_strength_check;

ALTER TABLE public.signals
  ADD CONSTRAINT signals_strength_check
  CHECK (strength IS NULL OR strength IN ('Low', 'Medium', 'High'));

-- Validate profile if supplied
ALTER TABLE public.signals
  DROP CONSTRAINT IF EXISTS signals_profile_check;

ALTER TABLE public.signals
  ADD CONSTRAINT signals_profile_check
  CHECK (profile IS NULL OR profile IN ('BINARY_QUICK', 'MT5'));

-- Confidence percentage must not be required before Stage 4 calibration
ALTER TABLE public.signals
  ALTER COLUMN confidence DROP NOT NULL,
  ALTER COLUMN confidence SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_signals_profile_engine ON public.signals(profile, engine);
CREATE INDEX IF NOT EXISTS idx_signals_user_created ON public.signals(user_id, created_at DESC);
