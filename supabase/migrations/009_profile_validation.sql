-- =========================================================================
-- STAGE 3.3 MIGRATION 009: Validate contract_size_overrides in RPC
-- =========================================================================
-- Replaces update_trading_profile so p_contract_size_overrides is strictly
-- validated:
--   - Must be a JSON object
--   - At most 20 keys
--   - Each key 1..20 characters
--   - Each value a JSON number > 0 and <= 10000000
--   - Serialized JSONB text <= 2048 bytes (2 KB)
-- Returns {ok: false, error: ...} on invalid input. Everything else identical.
-- =========================================================================

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
  v_key TEXT;
  v_val JSONB;
  v_val_num NUMERIC;
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

  IF octet_length(v_overrides::TEXT) > 2048 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'contract_size_overrides exceeds maximum serialized size of 2 KB.');
  END IF;

  IF (SELECT COUNT(*) FROM jsonb_object_keys(v_overrides)) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'contract_size_overrides can have at most 20 entries.');
  END IF;

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(v_overrides)
  LOOP
    IF char_length(v_key) = 0 OR char_length(v_key) > 20 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Each contract_size_overrides key must be 1 to 20 characters.');
    END IF;
    IF jsonb_typeof(v_val) <> 'number' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Each contract_size_overrides value must be a number.');
    END IF;
    v_val_num := (v_val #>> '{}')::NUMERIC;
    IF v_val_num <= 0 OR v_val_num > 10000000 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Each contract_size_overrides value must be > 0 and <= 10000000.');
    END IF;
  END LOOP;

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
