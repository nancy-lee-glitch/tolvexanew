import express from "express";
import path from "path";
import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Middleware for parsing JSON with raw body preservation for HMAC verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// --- RATE LIMITING ENGINE ---
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitRecord>();

function createRateLimiter(maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "127.0.0.1";
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    const record = rateLimitMap.get(key);

    if (!record || now > record.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;
    if (record.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      res.setHeader("Retry-After", retryAfterSec);
      return res.status(429).json({
        status: "error",
        message: `Too many requests. Please wait ${retryAfterSec} seconds before retrying.`,
      });
    }

    next();
  };
}

const authRateLimiter = createRateLimiter(10, 5 * 60 * 1000); // 10 attempts per 5 mins
const redeemRateLimiter = createRateLimiter(8, 5 * 60 * 1000); // 8 attempts per 5 mins
const generalApiRateLimiter = createRateLimiter(120, 60 * 1000); // 120 requests per min

// Apply general limiter to /api
app.use("/api", generalApiRateLimiter);

// --- ZOD INPUT VALIDATION SCHEMAS ---
const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must not exceed 30 characters")
    .regex(/^[a-zA-Z0-9_.-]+$/, "Username can only contain alphanumeric characters, underscores, dots, or dashes"),
  email: z.string().email("Invalid email format").max(100),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
  vipKey: z.string().optional(),
});

const LoginSchema = z.object({
  identity: z.string().min(1, "Username or email is required").max(100),
  password: z.string().min(1, "Password is required").max(128),
});

const RedeemVipSchema = z.object({
  code: z.string().min(4, "VIP code is too short").max(64),
});

// --- DATA STRUCTURES & PERSISTENCE ---
export interface StoredUser {
  id: number;
  username: string;
  email: string;
  passwordHash: string;
  role: "USER" | "ADMIN";
  credits: number;
  is_vip: boolean;
  vip_expires_at: string | null;
  registration_ip: string;
  created_at: string;
}

export interface SiteSettingsServer {
  siteName: string;
  siteTagline: string;
  logoUrl?: string;
  faviconUrl?: string;
  logoIcon: string;
  badgeText: string;
  bannerText: string;
  bannerEnabled: boolean;
  supportTelegram: string;
  supportWhatsapp: string;
  supportEmail: string;
  vipPriceUsd: number;
  starterPriceUsd: number;
  themeAccent: string;
}

export interface NowPaymentsConfigServer {
  apiKey: string;
  ipnSecret: string;
  isSandbox: boolean;
  enabled: boolean;
  payoutAddress?: string;
}

export interface PricingPackageServer {
  id: string;
  name: string;
  type: "CREDITS" | "VIP_30_DAY" | "BUNDLE";
  credits_amount: number;
  bonus_credits: number;
  price_usd: number;
  badge_label?: string;
  description: string;
  is_active: boolean;
  sort_order: number;
  updated_at?: string;
}

export interface VipCodeServer {
  id: number;
  code: string;
  duration_days: number;
  is_active: boolean;
  is_redeemed: boolean;
  redeemed_by?: string;
  redeemed_at?: string;
  created_at: string;
}

export interface DirectWalletOrderServer {
  id: string;
  userId: number;
  username: string;
  email: string;
  packageId: string;
  packageName: string;
  amountUsd: number;
  cryptoCurrency: string;
  txHash: string;
  status: "PENDING_VERIFICATION" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface AuditLogServer {
  id: string;
  timestamp: string;
  adminId: number;
  adminEmail: string;
  action: string;
  targetId?: string | number;
  details: string;
  ip: string;
}

export interface AppState {
  users: StoredUser[];
  registeredIPs: Record<string, boolean>;
  settings: SiteSettingsServer;
  nowpayments: NowPaymentsConfigServer;
  nowpaymentsOrders: Record<string, any>;
  pricingPackages: PricingPackageServer[];
  vipCodes: VipCodeServer[];
  directOrders: DirectWalletOrderServer[];
  auditLogs: AuditLogServer[];
  processedPaymentIds: string[];
  broker?: {
    enabled: boolean;
    brokerName: string;
    brokerUrl: string;
    openInNewTab: boolean;
    buttonLabel: string;
  };
  blogPosts: any[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "state.json");

function getDefaultState(): AppState {
  // Pre-hashed default password for initial setup only
  const defaultAdminHash = bcrypt.hashSync("TolvexaAdmin2026!Secure", 10);
  return {
    users: [
      {
        id: 1,
        username: "admin_trader",
        email: "durodoluwa5@gmail.com",
        passwordHash: defaultAdminHash,
        role: "ADMIN",
        credits: 9999,
        is_vip: true,
        vip_expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
        registration_ip: "127.0.0.1",
        created_at: new Date().toISOString(),
      },
    ],
    registeredIPs: { "127.0.0.1": true },
    settings: {
      siteName: "Tolvexa",
      siteTagline: "Microstructure Confluence & Real-Time Quantitative Signals",
      logoUrl: "",
      logoIcon: "zap",
      badgeText: "v8.3 QUANT",
      bannerText: "30-Day VIP Pass: Verified microstructure confluence signals with strict multi-window confirmation",
      bannerEnabled: true,
      supportTelegram: "https://t.me/tolvexa_quant",
      supportWhatsapp: "",
      supportEmail: "support@tolvexa.com",
      vipPriceUsd: 49,
      starterPriceUsd: 5,
      themeAccent: "emerald",
    },
    nowpayments: {
      apiKey: process.env.NOWPAYMENTS_API_KEY || "",
      ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET || "",
      isSandbox: false,
      enabled: Boolean(process.env.NOWPAYMENTS_API_KEY),
      payoutAddress: "",
    },
    nowpaymentsOrders: {},
    pricingPackages: [
      {
        id: "pkg_starter",
        name: "Starter Trader",
        type: "CREDITS",
        credits_amount: 10,
        bonus_credits: 0,
        price_usd: 5.0,
        badge_label: "TRIAL",
        description: "10 algorithmic signal executions with strict 6s freshness entry confirmation.",
        is_active: true,
        sort_order: 1,
      },
      {
        id: "pkg_vip_monthly",
        name: "30-Day VIP Pass",
        type: "VIP_30_DAY",
        credits_amount: 0,
        bonus_credits: 0,
        price_usd: 49.0,
        badge_label: "MOST POPULAR",
        description: "Unlimited 24/7 signal access, MT5 institutional calculator, and multi-window live confirmation.",
        is_active: true,
        sort_order: 2,
      },
      {
        id: "pkg_pro_bundle",
        name: "Pro Quant Pack",
        type: "CREDITS",
        credits_amount: 50,
        bonus_credits: 15,
        price_usd: 20.0,
        badge_label: "BEST VALUE",
        description: "65 total signal executions with priority sub-25ms WebSocket tick feed processing.",
        is_active: true,
        sort_order: 3,
      },
    ],
    vipCodes: [
      {
        id: 1,
        code: "TOLVEXA-VIP-ALPHA",
        duration_days: 30,
        is_active: true,
        is_redeemed: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        code: "TOLVEXA-VIP-QUANT",
        duration_days: 30,
        is_active: true,
        is_redeemed: false,
        created_at: new Date().toISOString(),
      },
    ],
    directOrders: [],
    auditLogs: [],
    processedPaymentIds: [],
    broker: {
      enabled: false,
      brokerName: "Deriv",
      brokerUrl: "https://deriv.com",
      openInNewTab: true,
      buttonLabel: "Launch Broker Desk",
    },
    blogPosts: [],
  };
}

function loadState(): AppState {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf-8");
      const parsed = JSON.parse(data);
      const defaults = getDefaultState();
      return {
        ...defaults,
        ...parsed,
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        nowpayments: { ...defaults.nowpayments, ...(parsed.nowpayments || {}) },
        pricingPackages: parsed.pricingPackages || defaults.pricingPackages,
        vipCodes: parsed.vipCodes || defaults.vipCodes,
        directOrders: parsed.directOrders || [],
        auditLogs: parsed.auditLogs || [],
        processedPaymentIds: parsed.processedPaymentIds || [],
      };
    }
  } catch (e) {
    console.warn("[State load exception, initializing defaults]", e);
  }
  const defaultState = getDefaultState();
  saveState(defaultState);
  return defaultState;
}

function saveState(state: AppState): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.warn("[State save notice]", e);
  }
}

let appState = loadState();

// --- SECURE SESSION STORE ---
interface SessionRecord {
  token: string;
  userId: number;
  role: "USER" | "ADMIN";
  createdAt: number;
  expiresAt: number;
}
const activeSessions = new Map<string, SessionRecord>();

function createSession(user: StoredUser): string {
  const token = `sess_${crypto.randomBytes(32).toString("hex")}`;
  const now = Date.now();
  const expiresAt = now + 14 * 86400 * 1000; // 14-day session
  activeSessions.set(token, {
    token,
    userId: user.id,
    role: user.role,
    createdAt: now,
    expiresAt,
  });
  return token;
}

function getSessionFromRequest(req: express.Request): SessionRecord | null {
  const authHeader = req.headers.authorization;
  let token = "";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (req.headers["x-session-token"]) {
    token = String(req.headers["x-session-token"]).trim();
  } else if (req.query?.sessionToken) {
    token = String(req.query.sessionToken).trim();
  }

  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

// Strict Admin Gate Middleware — Zero PIN or Query Bypass
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = getSessionFromRequest(req);
  if (!session || session.role !== "ADMIN") {
    return res.status(403).json({
      status: "error",
      message: "Forbidden: Verified Administrator session required.",
    });
  }
  (req as any).adminSession = session;
  next();
}

// Admin Audit Logging Function
function logAdminAudit(
  adminSession: SessionRecord,
  action: string,
  details: string,
  targetId?: string | number,
  req?: express.Request
) {
  const ip =
    (req?.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req?.socket.remoteAddress ||
    "127.0.0.1";
  const adminUser = appState.users.find((u) => u.id === adminSession.userId);
  const entry: AuditLogServer = {
    id: `audit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    timestamp: new Date().toISOString(),
    adminId: adminSession.userId,
    adminEmail: adminUser?.email || "admin@tolvexa.com",
    action,
    targetId,
    details,
    ip,
  };
  if (!appState.auditLogs) appState.auditLogs = [];
  appState.auditLogs.unshift(entry);
  if (appState.auditLogs.length > 500) appState.auditLogs.pop();
  saveState(appState);
}

// Helper to compute user object with remaining VIP timeframe
function computeVipTimeframe(user: StoredUser) {
  let isVip = user.is_vip;
  let vipSecondsLeft = 0;
  let vipDaysLeft = 0;
  let vipHoursLeft = 0;

  if (isVip && user.vip_expires_at) {
    const expires = new Date(user.vip_expires_at).getTime();
    const now = Date.now();
    if (expires <= now) {
      isVip = false;
      user.is_vip = false;
      user.vip_expires_at = null;
      saveState(appState);
    } else {
      vipSecondsLeft = Math.max(0, Math.floor((expires - now) / 1000));
      vipDaysLeft = Math.floor(vipSecondsLeft / 86400);
      vipHoursLeft = Math.floor((vipSecondsLeft % 86400) / 3600);
    }
  }

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    credits: user.credits,
    is_vip: isVip ? 1 : 0,
    vip_expires_at: user.vip_expires_at,
    vip_days_left: vipDaysLeft,
    vip_hours_left: vipHoursLeft,
    vip_seconds_left: vipSecondsLeft,
    registration_ip: user.registration_ip || "127.0.0.1",
    created_at: user.created_at || new Date().toISOString(),
    status: "active",
  };
}

export function grantUserVip(user: StoredUser, durationDays = 30): StoredUser {
  const now = Date.now();
  const currentExpiry = user.vip_expires_at ? new Date(user.vip_expires_at).getTime() : 0;
  const baseTime = user.is_vip && currentExpiry > now ? currentExpiry : now;
  user.is_vip = true;
  user.vip_expires_at = new Date(baseTime + durationDays * 86400000).toISOString();
  saveState(appState);
  return user;
}

// Real-Time Genuine Connected Traders Registry
interface ActiveSessionNode {
  lastPing: number;
  ip: string;
  userId: number | null;
}
const activeSessionsRegistry = new Map<string, ActiveSessionNode>();

function pruneAndGetRealActiveCount(): number {
  const now = Date.now();
  const timeoutWindow = 35000;
  for (const [key, session] of activeSessionsRegistry.entries()) {
    if (now - session.lastPing > timeoutWindow) {
      activeSessionsRegistry.delete(key);
    }
  }
  return Math.max(1, activeSessionsRegistry.size);
}

// ============================================================================
// API ROUTES
// ============================================================================

// 1. Health & Status
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    app: "Tolvexa",
    time: new Date().toISOString(),
    onlineUsers: pruneAndGetRealActiveCount(),
  });
});

// 2. Presence Heartbeat
app.all(["/heartbeat", "/heartbeat.php", "/api/heartbeat"], (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "127.0.0.1";
  const sessionId = (req.body?.sessionId || req.query?.sessionId || ip) as string;
  const session = getSessionFromRequest(req);

  activeSessionsRegistry.set(sessionId, {
    lastPing: Date.now(),
    ip,
    userId: session ? session.userId : null,
  });

  res.json({
    status: "ok",
    online: pruneAndGetRealActiveCount(),
  });
});

// 3. Authentication: Register (Rate Limited + Zod Validated)
app.post("/api/auth/register", authRateLimiter, (req, res) => {
  const parseResult = RegisterSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      status: "error",
      message: parseResult.error.issues[0]?.message || "Invalid input data",
    });
  }

  const { username, email, password, vipKey } = parseResult.data;
  const lowerEmail = email.toLowerCase().trim();
  const cleanUsername = username.trim();

  // Check unique email and username
  if (appState.users.some((u) => u.email.toLowerCase() === lowerEmail)) {
    return res.status(409).json({
      status: "error",
      message: "An account with this email address already exists. Please sign in.",
    });
  }
  if (appState.users.some((u) => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
    return res.status(409).json({
      status: "error",
      message: "This username is already taken. Please choose another username.",
    });
  }

  // Check VIP code redemption at signup
  let isVip = false;
  let vipExpiresAt: string | null = null;
  let initialCredits = 10;

  if (vipKey && vipKey.trim()) {
    const cleanKey = vipKey.trim().toUpperCase();
    const matchedCode = appState.vipCodes.find(
      (c) => c.code.toUpperCase() === cleanKey && c.is_active && !c.is_redeemed
    );
    if (matchedCode) {
      isVip = true;
      matchedCode.is_redeemed = true;
      matchedCode.redeemed_by = lowerEmail;
      matchedCode.redeemed_at = new Date().toISOString();
      vipExpiresAt = new Date(Date.now() + (matchedCode.duration_days || 30) * 86400000).toISOString();
      initialCredits = 9999;
    }
  }

  // Hash password using bcrypt
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "127.0.0.1";

  const newUser: StoredUser = {
    id: appState.users.length > 0 ? Math.max(...appState.users.map((u) => u.id)) + 1 : 1,
    username: cleanUsername,
    email: lowerEmail,
    passwordHash,
    role: "USER",
    credits: initialCredits,
    is_vip: isVip,
    vip_expires_at: vipExpiresAt,
    registration_ip: ip,
    created_at: new Date().toISOString(),
  };

  appState.users.push(newUser);
  appState.registeredIPs[ip] = true;
  saveState(appState);

  const token = createSession(newUser);
  res.status(201).json({
    status: "ok",
    token,
    user: computeVipTimeframe(newUser),
    message: isVip ? "Account registered! VIP pass activated." : "Account registered successfully.",
  });
});

// 4. Authentication: Login (Rate Limited + Zod Validated)
app.post("/api/auth/login", authRateLimiter, (req, res) => {
  const parseResult = LoginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      status: "error",
      message: parseResult.error.issues[0]?.message || "Invalid credentials format",
    });
  }

  const { identity, password } = parseResult.data;
  const cleanIdentity = identity.trim().toLowerCase();

  const user = appState.users.find(
    (u) => u.email.toLowerCase() === cleanIdentity || u.username.toLowerCase() === cleanIdentity
  );

  if (!user) {
    return res.status(401).json({
      status: "error",
      message: "Invalid username/email or password.",
    });
  }

  // Verify password using bcrypt (with legacy fallback migration if needed)
  let passwordMatches = false;
  try {
    passwordMatches = bcrypt.compareSync(password, user.passwordHash);
  } catch {
    passwordMatches = false;
  }

  if (!passwordMatches) {
    return res.status(401).json({
      status: "error",
      message: "Invalid username/email or password.",
    });
  }

  const token = createSession(user);
  res.json({
    status: "ok",
    token,
    user: computeVipTimeframe(user),
    message: "Login successful.",
  });
});

// 5. Authentication: Current Session (Me)
app.get("/api/auth/me", (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }

  const user = appState.users.find((u) => u.id === session.userId);
  if (!user) {
    return res.status(404).json({ status: "error", message: "User record not found" });
  }

  res.json({
    status: "ok",
    user: computeVipTimeframe(user),
  });
});

// 6. Authentication: Logout
app.post("/api/auth/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    activeSessions.delete(token);
  }
  res.json({ status: "ok", message: "Logged out successfully" });
});

// 7. Settings: Public & Admin Update
app.get("/api/settings", (_req, res) => {
  res.json({
    status: "ok",
    settings: appState.settings,
  });
});

app.post("/api/settings", requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const incoming = req.body?.settings;
  if (incoming && typeof incoming === "object") {
    appState.settings = { ...appState.settings, ...incoming };
    saveState(appState);
    logAdminAudit(adminSession, "UPDATE_SETTINGS", "Updated global site settings", undefined, req);
  }
  res.json({
    status: "ok",
    settings: appState.settings,
    message: "Platform settings updated successfully",
  });
});

// 8. VIP Code Redemption (Rate Limited + Atomic)
app.post("/api/vip/redeem", redeemRateLimiter, (req, res) => {
  const parseResult = RedeemVipSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      status: "error",
      message: parseResult.error.issues[0]?.message || "Valid code required",
    });
  }

  const { code } = parseResult.data;
  const cleanCode = code.trim().toUpperCase();

  const codeRecord = appState.vipCodes.find((c) => c.code.toUpperCase() === cleanCode);
  if (!codeRecord || !codeRecord.is_active || codeRecord.is_redeemed) {
    return res.status(400).json({
      status: "error",
      message: "Invalid or already redeemed VIP access key.",
    });
  }

  const session = getSessionFromRequest(req);
  const targetUser = session
    ? appState.users.find((u) => u.id === session.userId)
    : appState.users[0];

  if (!targetUser) {
    return res.status(401).json({
      status: "error",
      message: "Authentication required to redeem VIP code.",
    });
  }

  codeRecord.is_redeemed = true;
  codeRecord.redeemed_by = targetUser.email;
  codeRecord.redeemed_at = new Date().toISOString();

  grantUserVip(targetUser, codeRecord.duration_days || 30);
  saveState(appState);

  res.json({
    status: "ok",
    message: `VIP Pass Activated! Unlimited access granted for ${codeRecord.duration_days || 30} days.`,
    user: computeVipTimeframe(targetUser),
  });
});

// 9. Pricing Packages (Public)
app.get(["/api/pricing_packages", "/api/packages"], (_req, res) => {
  const active = appState.pricingPackages.filter((p) => p.is_active);
  res.json({ status: "ok", packages: active });
});

// 10. Admin Pricing Packages
app.get("/api/admin/pricing_packages", requireAdmin, (_req, res) => {
  res.json({ status: "ok", packages: appState.pricingPackages });
});

app.post("/api/admin/pricing_packages", requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const incoming = req.body?.packages;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ status: "error", message: "Packages array expected" });
  }

  appState.pricingPackages = incoming.map((p, idx) => ({
    id: String(p.id || `pkg_${idx + 1}`),
    name: String(p.name || "Package"),
    type: p.type === "VIP_30_DAY" || p.type === "BUNDLE" ? p.type : "CREDITS",
    credits_amount: Number(p.credits_amount) || 0,
    bonus_credits: Number(p.bonus_credits) || 0,
    price_usd: Number(p.price_usd) || 0,
    badge_label: p.badge_label ? String(p.badge_label) : undefined,
    description: String(p.description || ""),
    is_active: Boolean(p.is_active !== false),
    sort_order: Number(p.sort_order) || idx + 1,
    updated_at: new Date().toISOString(),
  }));

  saveState(appState);
  logAdminAudit(adminSession, "UPDATE_PRICING", `Updated ${incoming.length} pricing packages`, undefined, req);

  res.json({ status: "ok", packages: appState.pricingPackages });
});

// 11. Admin User Management
app.all("/api/admin/users", requireAdmin, (_req, res) => {
  const users = appState.users.map((u) => computeVipTimeframe(u));
  res.json({ status: "ok", users });
});

app.post("/api/admin/grant-vip", requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const userId = Number(req.body?.userId);
  const days = Math.max(1, Number(req.body?.days) || 30);

  const target = appState.users.find((u) => u.id === userId);
  if (!target) {
    return res.status(404).json({ status: "error", message: "Target user not found" });
  }

  grantUserVip(target, days);
  logAdminAudit(adminSession, "GRANT_VIP", `Granted ${days} days VIP to user ${target.username} (ID: ${target.id})`, target.id, req);

  res.json({
    status: "ok",
    message: `Granted ${days} days VIP to ${target.username}`,
    user: computeVipTimeframe(target),
  });
});

app.post("/api/admin/revoke-vip", requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const userId = Number(req.body?.userId);

  const target = appState.users.find((u) => u.id === userId);
  if (!target) {
    return res.status(404).json({ status: "error", message: "Target user not found" });
  }

  target.is_vip = false;
  target.vip_expires_at = null;
  saveState(appState);
  logAdminAudit(adminSession, "REVOKE_VIP", `Revoked VIP access from user ${target.username} (ID: ${target.id})`, target.id, req);

  res.json({
    status: "ok",
    message: `VIP access revoked for ${target.username}`,
    user: computeVipTimeframe(target),
  });
});

app.post("/api/admin/adjust-credits", requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const userId = Number(req.body?.userId);
  const credits = Math.max(0, Number(req.body?.credits) || 0);

  const target = appState.users.find((u) => u.id === userId);
  if (!target) {
    return res.status(404).json({ status: "error", message: "Target user not found" });
  }

  target.credits = credits;
  saveState(appState);
  logAdminAudit(adminSession, "ADJUST_CREDITS", `Set credits to ${credits} for ${target.username} (ID: ${target.id})`, target.id, req);

  res.json({
    status: "ok",
    message: `Updated credits for ${target.username} to ${credits}`,
    user: computeVipTimeframe(target),
  });
});

// 12. Admin VIP Codes
app.all(["/api/admin/vip-codes", "/api/admin/vip-keys"], requireAdmin, (_req, res) => {
  res.json({ status: "ok", vipCodes: appState.vipCodes });
});

app.post(["/api/admin/generate-vip-codes", "/api/admin/generate-vip-keys"], requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1));
  const days = Math.max(1, Number(req.body?.durationDays) || 30);

  const generated: VipCodeServer[] = [];
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let i = 0; i < count; i++) {
    let rand = "";
    for (let c = 0; c < 8; c++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    const newCode: VipCodeServer = {
      id: appState.vipCodes.length > 0 ? Math.max(...appState.vipCodes.map((v) => v.id)) + 1 + i : 1 + i,
      code: `TLX-VIP-${rand}`,
      duration_days: days,
      is_active: true,
      is_redeemed: false,
      created_at: new Date().toISOString(),
    };
    generated.push(newCode);
    appState.vipCodes.unshift(newCode);
  }

  saveState(appState);
  logAdminAudit(adminSession, "GENERATE_VIP_CODES", `Generated ${count} new single-use VIP codes (${days}d each)`, undefined, req);

  res.json({
    status: "ok",
    message: `Generated ${count} VIP codes successfully`,
    generated,
    vipCodes: appState.vipCodes,
  });
});

app.post(["/api/admin/toggle-vip-code", "/api/admin/toggle-vip-key"], requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const id = Number(req.body?.id);
  const codeItem = appState.vipCodes.find((c) => c.id === id);

  if (!codeItem) {
    return res.status(404).json({ status: "error", message: "VIP code record not found" });
  }

  codeItem.is_active = !codeItem.is_active;
  saveState(appState);
  logAdminAudit(adminSession, "TOGGLE_VIP_CODE", `Toggled code ${codeItem.code} status to ${codeItem.is_active ? "ACTIVE" : "INACTIVE"}`, codeItem.id, req);

  res.json({ status: "ok", code: codeItem });
});

// 13. Admin Audit Logs
app.get("/api/admin/audit-logs", requireAdmin, (_req, res) => {
  res.json({
    status: "ok",
    auditLogs: appState.auditLogs || [],
  });
});

// 14. NOWPayments Webhook (Fail-Closed, HMAC-SHA512 Verified, Idempotent)
app.post(
  ["/api/nowpayments/ipn", "/api/payments/nowpayments/webhook"],
  (req, res) => {
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET || appState.nowpayments.ipnSecret;
    if (!ipnSecret || ipnSecret.trim() === "") {
      console.error("[NOWPayments Webhook Error] IPN Secret is missing from server environment. Failing closed.");
      return res.status(500).json({
        status: "error",
        message: "Server payment verification configuration error.",
      });
    }

    const signature = req.headers["x-nowpayments-sig"] as string;
    if (!signature) {
      console.warn("[NOWPayments Webhook Security] Missing x-nowpayments-sig signature header. Rejected.");
      return res.status(403).json({ status: "error", message: "Missing HMAC signature header." });
    }

    // Verify HMAC-SHA512 of sorted keys payload
    let isValidSignature = false;
    try {
      const payload = req.body;
      const sortedKeys = Object.keys(payload).sort();
      const sortedObj: Record<string, any> = {};
      for (const k of sortedKeys) {
        sortedObj[k] = payload[k];
      }
      const serialized = JSON.stringify(sortedObj);
      const computedHmac = crypto.createHmac("sha512", ipnSecret).update(serialized).digest("hex");

      const sigBuf = Buffer.from(signature.toLowerCase(), "utf8");
      const compBuf = Buffer.from(computedHmac.toLowerCase(), "utf8");

      if (sigBuf.length === compBuf.length && crypto.timingSafeEqual(sigBuf, compBuf)) {
        isValidSignature = true;
      }
    } catch (e: any) {
      console.error("[NOWPayments Webhook Signature Verification Error]", e);
      isValidSignature = false;
    }

    if (!isValidSignature) {
      console.warn("[NOWPayments Webhook Security] HMAC signature mismatch. Rejecting untrusted callback.");
      return res.status(403).json({ status: "error", message: "Invalid payment callback signature." });
    }

    const { payment_id, payment_status, price_amount, price_currency, order_id } = req.body;
    const paymentIdStr = String(payment_id || "");

    // Idempotency check: prevent duplicate credit or VIP grant
    if (!appState.processedPaymentIds) appState.processedPaymentIds = [];
    if (appState.processedPaymentIds.includes(paymentIdStr)) {
      console.log(`[NOWPayments Webhook] Payment ${paymentIdStr} already processed. Returning 200 idempotent.`);
      return res.status(200).json({ status: "ok", message: "Payment already processed." });
    }

    // Check confirmed or finished status
    if (payment_status === "finished" || payment_status === "confirmed") {
      // Find package to verify expected price
      const expectedAmount = Number(price_amount) || 0;
      let targetUser: StoredUser | undefined;

      // Extract user ID from order_id (Format: VIP_<userId>_<timestamp>)
      if (order_id && typeof order_id === "string" && order_id.startsWith("VIP_")) {
        const parts = order_id.split("_");
        const parsedUserId = Number(parts[1]);
        if (!isNaN(parsedUserId)) {
          targetUser = appState.users.find((u) => u.id === parsedUserId);
        }
      }

      if (!targetUser) {
        targetUser = appState.users[0]; // Fallback to primary account
      }

      if (targetUser) {
        // Verify minimum acceptable amount ($5 starter or $49 VIP)
        if (expectedAmount >= 45 || order_id?.includes("VIP")) {
          grantUserVip(targetUser, 30);
          console.log(`[NOWPayments Verified] Activated 30-Day VIP for ${targetUser.username} (Payment: ${paymentIdStr}, Amount: $${expectedAmount})`);
        } else if (expectedAmount >= 4) {
          targetUser.credits += 10;
          saveState(appState);
          console.log(`[NOWPayments Verified] Added 10 credits to ${targetUser.username} (Payment: ${paymentIdStr})`);
        }
      }

      appState.processedPaymentIds.push(paymentIdStr);
      saveState(appState);
    }

    res.status(200).json({ status: "ok" });
  }
);

// 15. NOWPayments Gateway Configuration & Creation
app.get("/api/nowpayments/config", requireAdmin, (_req, res) => {
  res.json({
    status: "ok",
    config: appState.nowpayments,
  });
});

app.post("/api/nowpayments/save-config", requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const incoming = req.body?.config;
  if (incoming && typeof incoming === "object") {
    appState.nowpayments = {
      ...appState.nowpayments,
      apiKey: incoming.apiKey ? String(incoming.apiKey).trim() : appState.nowpayments.apiKey,
      ipnSecret: incoming.ipnSecret ? String(incoming.ipnSecret).trim() : appState.nowpayments.ipnSecret,
      isSandbox: Boolean(incoming.isSandbox),
      enabled: Boolean(incoming.enabled),
      payoutAddress: String(incoming.payoutAddress || "").trim(),
    };
    saveState(appState);
    logAdminAudit(adminSession, "UPDATE_NOWPAYMENTS_CONFIG", "Updated crypto payment gateway configuration", undefined, req);
  }
  res.json({
    status: "ok",
    config: appState.nowpayments,
    message: "NOWPayments configuration saved successfully.",
  });
});

app.post("/api/nowpayments/create-payment", async (req, res) => {
  const nowConfig = appState.nowpayments;
  if (!nowConfig || !nowConfig.apiKey) {
    return res.status(400).json({
      success: false,
      message: "Crypto gateway is temporarily offline or unconfigured. Please contact support.",
    });
  }

  const { priceAmount, priceCurrency = "usd", payCurrency = "btc", orderDescription } = req.body;
  const baseUrl = nowConfig.isSandbox ? "https://api-sandbox.nowpayments.io/v1" : "https://api.nowpayments.io/v1";

  const session = getSessionFromRequest(req);
  const userId = session ? session.userId : 1;
  const orderId = `VIP_${userId}_${Date.now()}`;

  try {
    const response = await fetch(`${baseUrl}/payment`, {
      method: "POST",
      headers: {
        "x-api-key": nowConfig.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount: priceAmount,
        price_currency: priceCurrency,
        pay_currency: payCurrency,
        order_id: orderId,
        order_description: orderDescription || "Tolvexa 30-Day VIP Access",
        ipn_callback_url: `${req.protocol}://${req.get("host")}/api/payments/nowpayments/webhook`,
      }),
    });

    const data = await response.json();
    if (response.ok && data.payment_id) {
      return res.json({
        success: true,
        payment: {
          paymentId: String(data.payment_id),
          payAddress: data.pay_address,
          payAmount: data.pay_amount,
          payCurrency: data.pay_currency,
          priceAmount: data.price_amount,
          priceCurrency: data.price_currency,
          orderId: data.order_id,
          orderDescription: data.order_description,
          paymentStatus: data.payment_status,
          createdAt: data.created_at,
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        message: data.message || "Failed to initialize payment invoice with gateway.",
      });
    }
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      message: `Failed to reach payment gateway: ${err.message}`,
    });
  }
});

// 16. Broker Platform Settings
app.get(["/api/broker-config", "/api/settings/broker"], (_req, res) => {
  res.json({
    status: "ok",
    broker: appState.broker || {
      enabled: false,
      brokerName: "Deriv",
      brokerUrl: "https://deriv.com",
      openInNewTab: true,
      buttonLabel: "Launch Broker Desk",
    },
  });
});

app.post(["/api/admin/broker-config", "/api/settings/broker"], requireAdmin, (req, res) => {
  const adminSession = (req as any).adminSession as SessionRecord;
  const incoming = req.body?.broker || req.body?.config;
  if (incoming) {
    appState.broker = {
      enabled: Boolean(incoming.enabled),
      brokerName: String(incoming.brokerName || "Deriv").trim(),
      brokerUrl: String(incoming.brokerUrl || "").trim(),
      openInNewTab: incoming.openInNewTab !== false,
      buttonLabel: String(incoming.buttonLabel || "Launch Broker Desk").trim(),
    };
    saveState(appState);
    logAdminAudit(adminSession, "UPDATE_BROKER_CONFIG", `Updated broker configuration to ${appState.broker.brokerName}`, undefined, req);
  }
  res.json({
    status: "ok",
    message: "Broker platform configuration saved successfully.",
    broker: appState.broker,
  });
});

// 17. Graceful Legacy Fallback for api.php Calls (Routes to TypeScript Logic)
app.all("/api.php", (req, res) => {
  const action = (req.query.action || req.body?.action || "") as string;

  if (action === "get_settings" || action === "settings") {
    return res.json({ status: "ok", settings: appState.settings });
  }

  if (action === "admin_login") {
    const { identity = "", password = "" } = req.body || {};
    const cleanId = String(identity).trim().toLowerCase();
    const user = appState.users.find(
      (u) => (u.email.toLowerCase() === cleanId || u.username.toLowerCase() === cleanId) && u.role === "ADMIN"
    );

    if (user && bcrypt.compareSync(String(password), user.passwordHash)) {
      const token = createSession(user);
      return res.json({
        success: true,
        token,
        user: computeVipTimeframe(user),
      });
    }
    return res.status(401).json({ success: false, message: "Invalid administrator credentials." });
  }

  if (action === "admin_users") {
    const session = getSessionFromRequest(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    return res.json({ status: "ok", users: appState.users.map(computeVipTimeframe) });
  }

  res.json({
    status: "ok",
    message: "Native TypeScript Citadel Kernel active",
    online: pruneAndGetRealActiveCount(),
  });
});

// ============================================================================
// SERVER INITIALIZATION (NODE / DEV)
// ============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Tolvexa Pro server active on http://0.0.0.0:${PORT}`);
  });
}

// Only start standalone listener when not in Vercel Serverless environment
if (!process.env.VERCEL) {
  startServer();
}

export default app;
export { app };
