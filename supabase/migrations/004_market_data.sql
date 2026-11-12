-- =========================================================================
-- Migration 004: User Favorites & Market Data Support
-- Application: Tickvere (https://tickvere.com)
--
-- Enables user-specific asset starring persisted to PostgreSQL with strict RLS.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.user_favorites (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE,
    symbol VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_user_favorites_user_id ON public.user_favorites(user_id);

ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_favorites_select_own" ON public.user_favorites;
DROP POLICY IF EXISTS "user_favorites_insert_own" ON public.user_favorites;
DROP POLICY IF EXISTS "user_favorites_delete_own" ON public.user_favorites;

CREATE POLICY "user_favorites_select_own" ON public.user_favorites
    FOR SELECT USING (
        user_id = public.get_current_user_id()
        OR public.is_admin()
        OR auth.jwt()->>'role' = 'service_role'
    );

CREATE POLICY "user_favorites_insert_own" ON public.user_favorites
    FOR INSERT WITH CHECK (
        user_id = public.get_current_user_id()
        OR auth.jwt()->>'role' = 'service_role'
    );

CREATE POLICY "user_favorites_delete_own" ON public.user_favorites
    FOR DELETE USING (
        user_id = public.get_current_user_id()
        OR auth.jwt()->>'role' = 'service_role'
    );
