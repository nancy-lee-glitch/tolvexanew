# Supabase Database & Security Setup Guide (Tickvere)

This guide provides the exact operational steps to apply migrations, configure authentication, and manage admin privileges for **Tickvere** (`https://tickvere.com`).

---

## 1. Apply Migration 001

### Option A: Supabase Web Dashboard (Recommended)
1. Open your Supabase Project Dashboard (`https://supabase.com/dashboard/project/<your-project-id>`).
2. In the left sidebar, click **SQL Editor**.
3. Click **New Query**.
4. Paste the entire content of `supabase/migrations/001_hardening.sql`.
5. Click **Run** (or press `Ctrl+Enter` / `Cmd+Enter`).
6. Confirm the console displays: `Success. No rows returned`.

### Option B: Supabase CLI
```bash
# Link project if not already linked
supabase link --project-ref <your-project-id>

# Push the migration
supabase db push
```

---

## 2. Authentication & URL Configuration

In Supabase Dashboard, go to **Authentication** -> **URL Configuration**:

1. **Site URL**:
   Set to:
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

3. **Email Provider Configuration** (**Authentication** -> **Providers** -> **Email**):
   - **Enable Email Provider**: Checked
   - **Confirm Email**: If you want users to trade immediately upon sign-up without email verification delays, uncheck **Confirm email**. If enabled, ensure custom SMTP is configured below so emails do not land in spam.

---

## 3. Enable Cloudflare Turnstile / CAPTCHA (Bot Protection)

To prevent automated credential stuffing and bot registrations:
1. Navigate to **Authentication** -> **Bot Protection / Security**.
2. Select **Cloudflare Turnstile** (or hCaptcha).
3. Obtain your Turnstile Site Key and Secret Key from [Cloudflare Dashboard](https://dash.cloudflare.com).
4. Enter the credentials in Supabase and toggle **Enable Turnstile Protection**.
5. Add `TURNSTILE_SECRET_KEY` into your Vercel Project Environment Variables.

---

## 4. Custom SMTP Setup (Branded Tickvere Emails)

By default, Supabase sends verification and password reset emails with a rate limit of 3 emails/hour from `noreply@mail.app.supabase.io`. To ensure high deliverability:
1. Navigate to **Project Settings** -> **Authentication** -> **SMTP Settings**.
2. Toggle **Enable Custom SMTP**.
3. Configure your transactional email provider (e.g. Resend, SendGrid, Amazon SES, Postmark):
   - **Sender Email**: `noreply@tickvere.com` or `support@tickvere.com`
   - **Sender Name**: `Tickvere Security`
   - **Host**: (e.g., `smtp.resend.com` or `smtp.sendgrid.net`)
   - **Port**: `587` (or `465` with SSL)
   - **Username**: `apikey` (or your provider username)
   - **Password**: Your SMTP API Key
4. Save and send a test email.

---

## 5. How to Safely Promote the FIRST Admin Account

Because Tickvere follows zero-trust security and does not hardcode admin credentials or backdoors:

1. Sign up on the website (`https://tickvere.com` or your local development instance) using your intended admin email.
2. In Supabase Dashboard, open **SQL Editor** and run the following command replacing `'your-email@example.com'` with your actual signed-up email:

```sql
UPDATE public.users
SET role = 'ADMIN',
    is_vip = TRUE,
    vip_expires_at = NOW() + INTERVAL '365 days',
    credits = 9999,
    updated_at = NOW()
WHERE email = 'your-email@example.com';
```

3. Verify admin promotion:
```sql
SELECT id, username, email, role, is_vip, credits 
FROM public.users 
WHERE email = 'your-email@example.com';
```
4. Log out and log back in on Tickvere. Your session now holds verified `ADMIN` privileges.
