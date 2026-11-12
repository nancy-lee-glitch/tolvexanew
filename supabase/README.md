# Supabase Database & Security Guide (Tickvere)

**Notice**: The `supabase/migrations/` directory is the **single source of truth** for all database tables, policies, triggers, and RPC functions. Legacy root schema files (such as `supabase_schema.sql` or `schema.sql`) have been completely retired.

---

## 0. Pre-Migration Safety Rules

1. **Backup First**: Before applying migrations, perform a database backup via **Supabase Dashboard** -> **Database** -> **Backups** (or run `pg_dump`).
2. **Export Legacy Keys**: If you have active keys in legacy tables, export them before running Migration 001, as legacy tables are cleaned up.

---

## 1. Apply Migrations

Run migrations in sequence in **Supabase Dashboard** -> **SQL Editor** (or via Supabase CLI `supabase db push`):

1. **`supabase/migrations/001_hardening.sql`**:
   - Enables RLS on all tables.
   - Defines `is_admin()` with `SECURITY DEFINER, STABLE` (eliminating RLS infinite recursion).
   - Creates `credit_ledger`, `audit_logs`, `rate_limits`, `direct_orders`, `broker_assets`, `instrument_specs`, `market_events`, `ip_registrations`.
   - Strips sensitive tables (`vip_codes`, `payment_orders`) from the realtime publication.

2. **`supabase/migrations/002_fixes.sql`**:
   - Updates `handle_new_user()` trigger to use `ON CONFLICT (email) DO NOTHING` to prevent profile takeovers.
   - Performs idempotent backfill creating safe profile records for any orphaned auth users.
   - Creates atomic functions `bump_ip_registration(p_ip)` and `rate_limit_hit(p_key, p_max, p_window)`.
   - Redefines `consume_credit(p_profile)` so credit cost is strictly server-controlled via `app_settings` (ignoring client numbers).

---

## 2. Authentication & URL Configuration

In Supabase Dashboard, navigate to **Authentication** -> **URL Configuration**:

1. **Site URL**:
   ```
   https://tickvere.com
   ```

2. **Redirect URLs** (Add each of these):
   ```
   https://tickvere.com/**
   https://tickvere.com/?view=reset-password
   http://localhost:3000/**
   http://localhost:5173/**
   ```

3. **Email Confirmation**:
   In **Authentication** -> **Providers** -> **Email**:
   - Keep **Confirm email** turned **ON**.
   - Registration creates users via client `auth.signUp` requiring email confirmation before sign-in.

---

## 3. Enable Cloudflare Turnstile / Bot Protection

To prevent automated bot registrations:
1. Navigate to **Authentication** -> **Bot Protection / Security**.
2. Select **Cloudflare Turnstile**.
3. Obtain your Turnstile Site Key and Secret Key from [Cloudflare Dashboard](https://dash.cloudflare.com).
4. Enter them into Supabase and configure `VITE_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Vercel.
5. In production, registration fails closed if `TURNSTILE_SECRET_KEY` is not configured.

---

## 4. Custom SMTP Setup (Branded Tickvere Emails)

To ensure confirmation and password reset emails land in user inboxes:
1. Navigate to **Project Settings** -> **Authentication** -> **SMTP Settings**.
2. Enable Custom SMTP using your transactional provider (Resend, SendGrid, Postmark, AWS SES):
   - **Sender Email**: `noreply@tickvere.com` or `support@tickvere.com`
   - **Sender Name**: `Tickvere Security`
   - **Port**: `587`
3. Send a test email to verify DNS DKIM/SPF records.

---

## 5. How to Safely Promote the FIRST Admin Account

Because Tickvere follows zero-trust security and hardcodes no credentials:

1. Sign up on the website (`https://tickvere.com`) and confirm your email.
2. In Supabase Dashboard, open **SQL Editor** and run:

```sql
UPDATE public.users
SET role = 'ADMIN',
    is_vip = TRUE,
    vip_expires_at = NOW() + INTERVAL '365 days',
    credits = 9999,
    updated_at = NOW()
WHERE email = 'your-verified-email@example.com';
```

3. Log in to Tickvere. The server verifies your `ADMIN` role from `public.users` and displays the Admin Console.
