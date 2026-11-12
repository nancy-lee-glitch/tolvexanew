/**
 * Extract trustworthy client IP address.
 *
 * Per Vercel infrastructure documentation:
 * `x-vercel-forwarded-for` is injected and sanitized by Vercel Edge Network proxies;
 * it cannot be spoofed by external incoming request headers.
 *
 * Evaluation order:
 * 1. `x-vercel-forwarded-for` (trusted edge IP on Vercel)
 * 2. `x-real-ip` (standard reverse proxy upstream IP)
 * 3. `x-forwarded-for` (leftmost client IP)
 * 4. Raw socket remote address (local development fallback)
 */
export function getClientIp(req: any): string {
  const headers = req?.headers || {};

  const vercelIp = headers['x-vercel-forwarded-for'];
  if (typeof vercelIp === 'string' && vercelIp.trim()) {
    return vercelIp.split(',')[0].trim();
  }

  const realIp = headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  const socketIp = req?.socket?.remoteAddress;
  if (typeof socketIp === 'string' && socketIp.trim()) {
    return socketIp.trim();
  }

  return '127.0.0.1';
}
