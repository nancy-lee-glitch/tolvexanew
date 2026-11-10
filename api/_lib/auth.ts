import { getSupabaseAdmin } from './supabaseAdmin.js';

export interface AuthContext {
  userId: number;
  authUserId: string;
  email: string;
  username: string;
  role: 'USER' | 'ADMIN';
  isAdmin: boolean;
  isVip: boolean;
  credits: number;
}

/**
 * Validates the caller Bearer token via supabase.auth.getUser()
 * and retrieves verified role from public.users using the service-role client.
 */
export async function authenticateRequest(req: any): Promise<AuthContext | null> {
  const headers = req.headers || {};
  const authHeader = headers['authorization'] || headers['Authorization'];
  let token = '';

  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (headers['x-access-token']) {
    token = String(headers['x-access-token']).trim();
  }

  if (!token) return null;

  try {
    const supabase = getSupabaseAdmin();
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return null;

    const { data: dbUser, error: dbErr } = await supabase
      .from('users')
      .select('id, auth_user_id, email, username, role, is_vip, vip_expires_at, credits')
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();

    if (dbErr || !dbUser) return null;

    let isVip = Boolean(dbUser.is_vip);
    if (isVip && dbUser.vip_expires_at) {
      if (new Date(dbUser.vip_expires_at).getTime() <= Date.now()) {
        isVip = false;
      }
    }

    const isAdmin = dbUser.role === 'ADMIN';

    return {
      userId: dbUser.id,
      authUserId: dbUser.auth_user_id,
      email: dbUser.email,
      username: dbUser.username,
      role: dbUser.role,
      isAdmin,
      isVip,
      credits: dbUser.credits,
    };
  } catch (err) {
    console.warn('[authenticateRequest Warning]', err);
    return null;
  }
}

/**
 * Middleware gate requiring verified ADMIN status.
 */
export async function requireAdmin(req: any, res: any): Promise<AuthContext | null> {
  const auth = await authenticateRequest(req);
  if (!auth || !auth.isAdmin) {
    res.status(403).json({
      ok: false,
      error: 'Forbidden: Verified Administrator privileges required.',
    });
    return null;
  }
  return auth;
}
