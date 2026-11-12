-- =========================================================================
-- Migration 003: IP Registration Count Read Function (Idempotent)
-- Application: Tickvere (https://tickvere.com)
--
-- Adds a service-role-only SQL function to inspect the current 24-hour
-- registration count for an IP address WITHOUT incrementing or modifying rows.
-- If the 24-hour window has expired or the IP has no registrations, returns 0.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.ip_registration_count(p_ip TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_ip VARCHAR(64);
    v_count INTEGER := 0;
    v_first_reg TIMESTAMPTZ;
BEGIN
    v_clean_ip := SUBSTRING(TRIM(COALESCE(p_ip, '127.0.0.1')), 1, 64);

    SELECT count, first_registered_at
    INTO v_count, v_first_reg
    FROM public.ip_registrations
    WHERE ip_address = v_clean_ip;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- If the record is older than 24 hours, the window has expired (effective count = 0)
    IF v_first_reg < NOW() - INTERVAL '24 hours' THEN
        RETURN 0;
    END IF;

    RETURN COALESCE(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.ip_registration_count(TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ip_registration_count(TEXT) TO service_role;
