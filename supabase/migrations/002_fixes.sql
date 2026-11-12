-- =========================================================================
-- Migration 002: Security & Defect Fixes (Idempotent & Re-runnable)
-- Application: Tickvere (https://tickvere.com)
--
-- IMPORTANT PRE-MIGRATION WARNING:
-- 1. Take a full database backup before running (Supabase Dashboard -> Database -> Backups, or pg_dump).
-- 2. Export any vip_keys / vip_codes data you still need BEFORE executing,
--    as legacy tables should be archived prior to strict schema cutover.
-- =========================================================================

-- 1. TRIGGER UPDATE: ON CONFLICT (email) DO NOTHING
-- A person must NEVER be able to take over an existing profile row (credits, VIP, ADMIN)
-- by signing up with someone else's email. If an email already exists in public.users,
-- the trigger does nothing.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_raw_username TEXT;
    v_clean_username VARCHAR(50);
    v_default_credits INTEGER := 10;
BEGIN
    -- Extract and sanitize username
    v_raw_username := NEW.raw_user_meta_data->>'username';
    IF v_raw_username IS NOT NULL AND v_raw_username ~ '^[a-zA-Z0-9_.-]{3,30}$' THEN
        v_clean_username := v_raw_username;
    ELSE
        v_clean_username := regexp_replace(split_part(NEW.email, '@', 1), '[^a-zA-Z0-9_.-]', '', 'g');
        IF length(v_clean_username) < 3 THEN
            v_clean_username := 'trader';
        END IF;
        v_clean_username := substring(v_clean_username, 1, 24) || '_' || substring(md5(random()::text), 1, 4);
    END IF;

    -- Avoid username collisions
    IF EXISTS (SELECT 1 FROM public.users WHERE username = v_clean_username) THEN
        v_clean_username := substring(v_clean_username, 1, 22) || '_' || substring(md5(random()::text), 1, 6);
    END IF;

    -- STRICT ON CONFLICT DO NOTHING: never overwrite an existing profile
    INSERT INTO public.users (
        auth_user_id,
        username,
        email,
        role,
        credits,
        is_vip,
        vip_expires_at,
        registration_ip
    )
    VALUES (
        NEW.id,
        v_clean_username,
        LOWER(TRIM(NEW.email)),
        'USER',
        v_default_credits,
        FALSE,
        NULL,
        'supabase_auth'
    )
    ON CONFLICT (email) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. IDEMPOTENT BACKFILL: REPAIR ORPHANED AUTH USERS
-- Recreates a safe public.users profile (role 'USER', is_vip false, credits 10)
-- for any auth.users account that is currently missing a profile row.
-- Never grants ADMIN here.
INSERT INTO public.users (
    auth_user_id,
    username,
    email,
    role,
    credits,
    is_vip,
    vip_expires_at,
    registration_ip
)
SELECT 
    au.id,
    COALESCE(
        NULLIF(regexp_replace(split_part(au.email, '@', 1), '[^a-zA-Z0-9_.-]', '', 'g'), ''),
        'trader'
    ) || '_' || substring(md5(au.id::text), 1, 4),
    LOWER(TRIM(au.email)),
    'USER',
    10,
    FALSE,
    NULL,
    'backfill_migration'
FROM auth.users au
LEFT JOIN public.users pu ON pu.email = LOWER(TRIM(au.email)) OR pu.auth_user_id = au.id
WHERE pu.id IS NULL
ON CONFLICT (email) DO NOTHING;

-- 3. ATOMIC IP REGISTRATION TRACKER: bump_ip_registration(p_ip TEXT)
-- Atomically tracks registration counts per IP in one atomic statement.
-- Resets the 24-hour window when first_registered_at is older than 24 hours.
CREATE OR REPLACE FUNCTION public.bump_ip_registration(p_ip TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_ip VARCHAR(64);
    v_new_count INTEGER;
BEGIN
    v_clean_ip := SUBSTRING(TRIM(COALESCE(p_ip, '127.0.0.1')), 1, 64);

    INSERT INTO public.ip_registrations (
        ip_address,
        count,
        first_registered_at,
        last_registered_at
    )
    VALUES (
        v_clean_ip,
        1,
        NOW(),
        NOW()
    )
    ON CONFLICT (ip_address) DO UPDATE SET
        count = CASE
            WHEN ip_registrations.first_registered_at < NOW() - INTERVAL '24 hours' THEN 1
            ELSE ip_registrations.count + 1
        END,
        first_registered_at = CASE
            WHEN ip_registrations.first_registered_at < NOW() - INTERVAL '24 hours' THEN NOW()
            ELSE ip_registrations.first_registered_at
        END,
        last_registered_at = NOW()
    RETURNING count INTO v_new_count;

    RETURN v_new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_ip_registration(TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_ip_registration(TEXT) TO service_role;

-- 4. ATOMIC RATE LIMITER: rate_limit_hit(p_key TEXT, p_max INT, p_window_seconds INT)
-- Race-condition-free single-statement atomic rate limiter.
-- Resets window when expired, increments hit counter atomically, returns status.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
    p_key TEXT,
    p_max INT DEFAULT 10,
    p_window_seconds INT DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_key VARCHAR(128);
    v_max INT := GREATEST(1, COALESCE(p_max, 10));
    v_window INT := GREATEST(1, COALESCE(p_window_seconds, 300));
    v_record public.rate_limits%ROWTYPE;
    v_allowed BOOLEAN;
    v_remaining INT;
    v_retry_after INT := 0;
BEGIN
    v_key := SUBSTRING(TRIM(COALESCE(p_key, 'default_key')), 1, 128);

    INSERT INTO public.rate_limits (key, hits, reset_at)
    VALUES (v_key, 1, NOW() + (v_window || ' seconds')::INTERVAL)
    ON CONFLICT (key) DO UPDATE SET
        hits = CASE 
            WHEN rate_limits.reset_at < NOW() THEN 1 
            ELSE rate_limits.hits + 1 
        END,
        reset_at = CASE 
            WHEN rate_limits.reset_at < NOW() THEN NOW() + (v_window || ' seconds')::INTERVAL 
            ELSE rate_limits.reset_at 
        END
    RETURNING * INTO v_record;

    IF v_record.hits > v_max THEN
        v_allowed := FALSE;
        v_remaining := 0;
        v_retry_after := GREATEST(1, EXTRACT(EPOCH FROM (v_record.reset_at - NOW()))::INT);
    ELSE
        v_allowed := TRUE;
        v_remaining := GREATEST(0, v_max - v_record.hits);
    END IF;

    RETURN jsonb_build_object(
        'allowed', v_allowed,
        'remaining', v_remaining,
        'retry_after', v_retry_after,
        'hits', v_record.hits
    );
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit(TEXT, INT, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INT, INT) TO service_role;

-- 5. SERVER-CONTROLLED CREDIT COST: consume_credit(p_profile TEXT)
-- First drop the legacy integer signature to prevent ambiguous function call errors when invoking consume_credit() with 0 arguments.
DROP FUNCTION IF EXISTS public.consume_credit(INT);

CREATE OR REPLACE FUNCTION public.consume_credit(p_profile TEXT DEFAULT 'binary')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user public.users%ROWTYPE;
    v_profile TEXT := LOWER(TRIM(COALESCE(p_profile, 'binary')));
    v_cost INT := 1;
    v_balance_after INT;
    v_setting_row JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Unauthenticated');
    END IF;

    -- Read server-defined pricing from app_settings
    SELECT value INTO v_setting_row FROM public.app_settings WHERE key = 'credit_costs';
    IF v_profile = 'mt5' THEN
        v_cost := COALESCE((v_setting_row->>'mt5')::INT, 2);
    ELSE
        v_cost := COALESCE((v_setting_row->>'binary')::INT, 1);
    END IF;

    -- Row lock on user record
    SELECT * INTO v_user
    FROM public.users
    WHERE auth_user_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'User profile not found');
    END IF;

    -- Admin or active VIP: zero deduction
    IF v_user.role = 'ADMIN' OR (v_user.is_vip AND (v_user.vip_expires_at IS NULL OR v_user.vip_expires_at > NOW())) THEN
        RETURN jsonb_build_object(
            'ok', true,
            'credits', v_user.credits,
            'unlimited', true,
            'cost', 0,
            'error', NULL
        );
    END IF;

    IF v_user.credits < v_cost THEN
        RETURN jsonb_build_object(
            'ok', false,
            'credits', v_user.credits,
            'unlimited', false,
            'cost', v_cost,
            'error', 'Insufficient credits. Upgrade to VIP or top up credits.'
        );
    END IF;

    v_balance_after := v_user.credits - v_cost;

    UPDATE public.users
    SET credits = v_balance_after,
        updated_at = NOW()
    WHERE id = v_user.id;

    -- Record immutable ledger debit
    INSERT INTO public.credit_ledger (
        user_id,
        delta,
        reason,
        balance_after
    ) VALUES (
        v_user.id,
        -v_cost,
        'signal_computation_' || v_profile,
        v_balance_after
    );

    RETURN jsonb_build_object(
        'ok', true,
        'credits', v_balance_after,
        'unlimited', false,
        'cost', v_cost,
        'error', NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_credit(TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.consume_credit(TEXT) TO authenticated, service_role;

-- Seed server-defined credit costs in app_settings
INSERT INTO public.app_settings (key, value)
VALUES ('credit_costs', '{"binary": 1, "mt5": 2}'::JSONB)
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    updated_at = NOW();
