-- =========================================================================
-- STAGE 3 PART 2 MIGRATION 008: MT5 Risk Profile & Instrument Specifications
-- =========================================================================
-- 1. Adds per-user MT5 risk & account settings to public.users.
-- 2. Exposes SECURITY DEFINER RPC `update_trading_profile` so authenticated
--    users can safely persist ONLY their risk/account profile without ever
--    gaining UPDATE permission on role, credits, or VIP columns.
-- 3. Expands default public.instrument_specs coverage (Gold, Silver, FX
--    crosses, Indices, Crypto, and 24/7 Synthetics).
-- =========================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS account_currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS account_balance NUMERIC(14, 2) NOT NULL DEFAULT 1000.00,
  ADD COLUMN IF NOT EXISTS risk_pct NUMERIC(5, 2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS broker_spread_pips NUMERIC(8, 2) NOT NULL DEFAULT 1.20,
  ADD COLUMN IF NOT EXISTS contract_size_overrides JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$
BEGIN
  ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_account_currency_check;
  ALTER TABLE public.users ADD CONSTRAINT users_account_currency_check
    CHECK (account_currency IN ('USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF'));

  ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_account_balance_check;
  ALTER TABLE public.users ADD CONSTRAINT users_account_balance_check
    CHECK (account_balance >= 0);

  ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_risk_pct_check;
  ALTER TABLE public.users ADD CONSTRAINT users_risk_pct_check
    CHECK (risk_pct >= 0.10 AND risk_pct <= 3.00);

  ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_leverage_check;
  ALTER TABLE public.users ADD CONSTRAINT users_leverage_check
    CHECK (leverage >= 1 AND leverage <= 2000);

  ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_broker_spread_pips_check;
  ALTER TABLE public.users ADD CONSTRAINT users_broker_spread_pips_check
    CHECK (broker_spread_pips >= 0 AND broker_spread_pips <= 500);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Safe RPC for updating ONLY the authenticated user's own trading risk profile
CREATE OR REPLACE FUNCTION public.update_trading_profile(
  p_account_currency TEXT DEFAULT NULL,
  p_account_balance NUMERIC DEFAULT NULL,
  p_risk_pct NUMERIC DEFAULT NULL,
  p_leverage INTEGER DEFAULT NULL,
  p_broker_spread_pips NUMERIC DEFAULT NULL,
  p_contract_size_overrides JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_ccy TEXT;
  v_bal NUMERIC;
  v_risk NUMERIC;
  v_lev INTEGER;
  v_spread NUMERIC;
  v_overrides JSONB;
  v_row public.users%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Authentication required.');
  END IF;

  SELECT * INTO v_row FROM public.users WHERE auth_user_id = v_uid LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'User profile not found.');
  END IF;

  v_ccy := UPPER(COALESCE(NULLIF(TRIM(p_account_currency), ''), v_row.account_currency, 'USD'));
  IF v_ccy NOT IN ('USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unsupported account currency.');
  END IF;

  v_bal := COALESCE(p_account_balance, v_row.account_balance, 1000.00);
  IF v_bal < 0 OR v_bal > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Account balance out of allowed range.');
  END IF;

  v_risk := COALESCE(p_risk_pct, v_row.risk_pct, 1.00);
  IF v_risk < 0.10 OR v_risk > 3.00 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Risk % per trade must be between 0.1% and 3.0%.');
  END IF;

  v_lev := COALESCE(p_leverage, v_row.leverage, 100);
  IF v_lev < 1 OR v_lev > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Leverage must be between 1 and 2000.');
  END IF;

  v_spread := COALESCE(p_broker_spread_pips, v_row.broker_spread_pips, 1.20);
  IF v_spread < 0 OR v_spread > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Spread assumption must be between 0 and 500 pips.');
  END IF;

  v_overrides := COALESCE(p_contract_size_overrides, v_row.contract_size_overrides, '{}'::JSONB);
  IF jsonb_typeof(v_overrides) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'contract_size_overrides must be a JSON object.');
  END IF;

  UPDATE public.users
  SET
    account_currency = v_ccy,
    account_balance = ROUND(v_bal::NUMERIC, 2),
    risk_pct = ROUND(v_risk::NUMERIC, 2),
    leverage = v_lev,
    broker_spread_pips = ROUND(v_spread::NUMERIC, 2),
    contract_size_overrides = v_overrides,
    updated_at = NOW()
  WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'ok', true,
    'account_currency', v_ccy,
    'account_balance', ROUND(v_bal::NUMERIC, 2),
    'risk_pct', ROUND(v_risk::NUMERIC, 2),
    'leverage', v_lev,
    'broker_spread_pips', ROUND(v_spread::NUMERIC, 2),
    'contract_size_overrides', v_overrides
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_trading_profile(TEXT, NUMERIC, NUMERIC, INTEGER, NUMERIC, JSONB) FROM public;
GRANT EXECUTE ON FUNCTION public.update_trading_profile(TEXT, NUMERIC, NUMERIC, INTEGER, NUMERIC, JSONB) TO authenticated, service_role;

-- Expand default instrument_specs for metals, FX crosses, crypto & synthetics
INSERT INTO public.instrument_specs (symbol, contract_size, min_lot, lot_step, quote_ccy, pip_size, decimals)
VALUES
  ('EUR/USD', 100000, 0.01, 0.01, 'USD', 0.00010, 5),
  ('GBP/USD', 100000, 0.01, 0.01, 'USD', 0.00010, 5),
  ('USD/JPY', 100000, 0.01, 0.01, 'JPY', 0.010, 3),
  ('AUD/USD', 100000, 0.01, 0.01, 'USD', 0.00010, 5),
  ('USD/CAD', 100000, 0.01, 0.01, 'CAD', 0.00010, 5),
  ('USD/CHF', 100000, 0.01, 0.01, 'CHF', 0.00010, 5),
  ('EUR/GBP', 100000, 0.01, 0.01, 'GBP', 0.00010, 5),
  ('GBP/JPY', 100000, 0.01, 0.01, 'JPY', 0.010, 3),
  ('EUR/JPY', 100000, 0.01, 0.01, 'JPY', 0.010, 3),
  ('XAU/USD', 100, 0.01, 0.01, 'USD', 0.010, 2),
  ('XAG/USD', 5000, 0.01, 0.01, 'USD', 0.0010, 3),
  ('BTC/USD', 1, 0.001, 0.001, 'USD', 1.00, 2),
  ('ETH/USD', 1, 0.01, 0.01, 'USD', 0.10, 2),
  ('R_100', 1, 0.01, 0.01, 'USD', 0.01, 2),
  ('R_75', 1, 0.01, 0.01, 'USD', 0.01, 2),
  ('R_50', 1, 0.01, 0.01, 'USD', 0.01, 2),
  ('R_25', 1, 0.01, 0.01, 'USD', 0.01, 2),
  ('R_10', 1, 0.01, 0.01, 'USD', 0.001, 3),
  ('1HZ100V', 1, 0.01, 0.01, 'USD', 0.01, 2)
ON CONFLICT (symbol) DO UPDATE SET
  contract_size = EXCLUDED.contract_size,
  min_lot = EXCLUDED.min_lot,
  lot_step = EXCLUDED.lot_step,
  quote_ccy = EXCLUDED.quote_ccy,
  pip_size = EXCLUDED.pip_size,
  decimals = EXCLUDED.decimals,
  updated_at = NOW();
