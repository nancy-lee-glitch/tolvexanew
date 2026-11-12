/**
 * Verify Cloudflare Turnstile token server-side.
 *
 * In production or Vercel deployment:
 * If TURNSTILE_SECRET_KEY is missing, fails closed (rejects registration).
 */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp: string
): Promise<{ success: boolean; error?: string }> {
  const secretKey = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  // In production, failure to configure TURNSTILE_SECRET_KEY fails closed
  if (!secretKey) {
    if (isProduction) {
      return {
        success: false,
        error: 'Security challenge configuration error. Registration blocked.',
      };
    }
    // In local non-production development without Turnstile secret, allow bypass
    console.warn('[Turnstile Notice] TURNSTILE_SECRET_KEY is not set in development. Bypassing check.');
    return { success: true };
  }

  if (!token || typeof token !== 'string' || token.trim() === '') {
    return {
      success: false,
      error: 'Please complete the security challenge verification.',
    };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token.trim());
    if (remoteIp) {
      formData.append('remoteip', remoteIp);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Cloudflare Turnstile verification service error (${response.status}).`,
      };
    }

    const data = await response.json();
    if (data.success === true) {
      return { success: true };
    }

    const errorCodes = Array.isArray(data['error-codes']) ? data['error-codes'].join(', ') : 'Verification failed';
    return {
      success: false,
      error: `Security verification failed (${errorCodes}). Please retry.`,
    };
  } catch (err: any) {
    console.error('[Turnstile Verification Exception]', err);
    return {
      success: false,
      error: 'Security challenge verification error. Please retry.',
    };
  }
}
