-- =========================================================================
-- STAGE 4I MIGRATION 011: Minimum Actionable Setup Strength Setting
-- =========================================================================
-- Safe to run multiple times (idempotent).
-- Adds app_settings key 'min_actionable_strength' (default 'Medium')
-- and permits public SELECT on that safe non-secret key.
-- =========================================================================

INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('min_actionable_strength', to_jsonb('Medium'::text), NOW())
ON CONFLICT (key) DO NOTHING;

DROP POLICY IF EXISTS "app_settings_public_select" ON public.app_settings;

CREATE POLICY "app_settings_public_select" ON public.app_settings
    FOR SELECT USING (
        key IN ('site_branding', 'external_broker', 'min_actionable_strength')
        OR public.is_admin()
        OR auth.jwt()->>'role' = 'service_role'
    );
