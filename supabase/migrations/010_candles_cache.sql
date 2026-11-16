-- =========================================================================
-- STAGE 4A MIGRATION 010: Persistent Multi-Timeframe Candle Cache
-- =========================================================================
-- Safe to run multiple times (idempotent).
-- Public market OHLC data is readable by anon/authenticated clients;
-- inserts/updates/deletes are strictly restricted to service_role via server API.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.candles_cache (
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL CHECK (tf IN ('M5', 'M15', 'H1', 'H4', 'D1')),
  open_time BIGINT NOT NULL,
  o NUMERIC NOT NULL,
  h NUMERIC NOT NULL,
  l NUMERIC NOT NULL,
  c NUMERIC NOT NULL,
  PRIMARY KEY (symbol, tf, open_time)
);

CREATE INDEX IF NOT EXISTS idx_candles_cache_sym_tf_open_desc
  ON public.candles_cache (symbol, tf, open_time DESC);

CREATE TABLE IF NOT EXISTS public.candles_refresh_log (
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL CHECK (tf IN ('M5', 'M15', 'H1', 'H4', 'D1')),
  last_refreshed_at TIMESTAMPTZ,
  last_error TEXT,
  PRIMARY KEY (symbol, tf)
);

-- Enable Row-Level Security on both tables
ALTER TABLE public.candles_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candles_refresh_log ENABLE ROW LEVEL SECURITY;

-- Public market data: allow SELECT to anon and authenticated, deny direct client writes
GRANT SELECT ON TABLE public.candles_cache TO anon, authenticated;
GRANT ALL ON TABLE public.candles_cache TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.candles_cache FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.candles_refresh_log TO anon, authenticated;
GRANT ALL ON TABLE public.candles_refresh_log TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.candles_refresh_log FROM PUBLIC, anon, authenticated;

-- Idempotent RLS Policies for public.candles_cache
DROP POLICY IF EXISTS "candles_cache_public_select" ON public.candles_cache;
DROP POLICY IF EXISTS "candles_cache_service_write" ON public.candles_cache;

CREATE POLICY "candles_cache_public_select" ON public.candles_cache
  FOR SELECT
  USING (true);

CREATE POLICY "candles_cache_service_write" ON public.candles_cache
  FOR ALL
  TO service_role
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- Idempotent RLS Policies for public.candles_refresh_log
DROP POLICY IF EXISTS "candles_refresh_log_public_select" ON public.candles_refresh_log;
DROP POLICY IF EXISTS "candles_refresh_log_service_write" ON public.candles_refresh_log;

CREATE POLICY "candles_refresh_log_public_select" ON public.candles_refresh_log
  FOR SELECT
  USING (true);

CREATE POLICY "candles_refresh_log_service_write" ON public.candles_refresh_log
  FOR ALL
  TO service_role
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');
