/**
 * PulseTrade Pro - Shared TypeScript Definitions
 */

export interface AssetConfig {
  symbol: string;
  name: string;
  type: 'FOREX' | 'COMMODITY' | 'SYNTH' | 'CRYPTO' | 'STOCK' | 'INDEX';
  decimals: number;
  pipSize: number;
  basePrice?: number;
  marketHours?: string;
  category?: string;
}

export interface TimestampedTick {
  time: number;
  price: number;
}

export interface SafeCloseAnalysis {
  volatilityLevel: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  recommendedSeconds: number;
  peakMomentumWindow: string;
  safeProfitPips: number;
  advisoryText: string;
  earlyCloseRecommended: boolean;
  reversalRisk: 'LOW' | 'MODERATE' | 'ELEVATED';
}

export interface SignalHistoryItem {
  id: string;
  asset: string;
  timeframe: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  entryPrice: number;
  targetPrice?: number;
  generatedAt: number;
  confidence: number;
  outcome?: 'WIN' | 'LOSS' | 'IN_TRADE' | 'PENDING' | 'WAIT';
  sparkline: number[];
  pipDiff?: number;
  safeCloseSuggestion?: string;
  platform?: string;
  platformProfile?: AnalysisProfile;
}

export interface LiveRegimeInfo {
  regime: 'DIRECTIONAL' | 'CHOP' | 'HIGH_VOLATILITY' | 'THIN';
  badgeLabel: string;
  subText: string;
  color: string;
  dotColor: string;
  borderColor: string;
  textColor: string;
  utcSession: string;
  volatilityPips: number;
  efficiencyRatio: number;
}

export interface VipScreenerAsset {
  symbol: string;
  name: string;
  type: 'FOREX' | 'COMMODITY' | 'SYNTH' | 'CRYPTO' | 'STOCK' | 'INDEX';
  price: number;
  decimals: number;
  change24h: number;
  volatility: 'LOW' | 'NORMAL' | 'HIGH';
  safetyRating: 'SAFE TO TRADE' | 'MODERATE RISK' | 'WAIT / VOLATILE';
  recommendedAction: 'CALL' | 'PUT' | 'WAIT';
  bestTimeframe: '30s' | '1m' | '5m' | '15m' | '1h';
  confluenceScore: number;
  safeCloseTiming: string;
  reason: string;
  sparkline: number[];
}

export interface TechnicalAudit {
  rsi: number;
  rsiState: 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL' | 'BULLISH_MOMENTUM' | 'BEARISH_MOMENTUM';
  emaFast: number;
  emaSlow: number;
  emaSpread: number;
  emaTrend: 'BULLISH' | 'BEARISH' | 'CROSSOVER_UP' | 'CROSSOVER_DOWN';
  orderFlowBuyPct: number;
  orderFlowSellPct: number;
  tickVelocity: number;
  tickAcceleration: number;
  bollingerBandStatus: 'PIERCED_LOWER' | 'PIERCED_UPPER' | 'MIDDLE_EXPANDING' | 'SQUEEZE';
  bollingerPctB: number;
  confluenceScore: number;
  confluenceFactors: string[];
  recheckSteps: string[];
  setupName: string;
  recommendedAction: 'CALL' | 'PUT' | 'WAIT';
}

export type MarketStructureType = 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';
export type StructureCue = 'HH_HL' | 'LH_LL' | 'RANGE_CONSOLIDATION' | 'COMPRESSION' | 'EXPANSION' | 'INSUFFICIENT_DATA';
export type AnalysisMode = 'quick' | 'mt5';
export type FactorSeverity = 'HARD' | 'CORE' | 'SOFT' | 'CONTEXT';

export interface ConfluenceFactorItem {
  id: 'live_path' | 'ema' | 'rsi' | 'volume' | 'liquidity_sweep' | 'fvg' | 'volatility';
  name: string;
  status: 'PASS' | 'FAIL' | 'UNSURE' | 'WARN';
  detail: string;
  severity: FactorSeverity;
  isAdvanced?: boolean;
}

export interface VolumeProfileContext {
  pocPrice: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  highVolumeNodePips: number;
  rangeHigh: number;
  rangeLow: number;
}

export interface ConfluenceGateResult {
  passed: boolean;
  blocked: boolean;
  blockedReason?: string;
  mode: AnalysisMode;
  structure: MarketStructureType;
  structureCue: StructureCue;
  structureSummary: string;
  factors: ConfluenceFactorItem[];
  allFactorsPassed: boolean;
  corePassed: boolean;
  failReasons: string[];
  volumeProfile?: VolumeProfileContext;
}

export interface EntryZone {
  min: number;
  max: number;
}

export interface MT5TradeParameters {
  symbol: string;
  orderType: 'BUY' | 'SELL';
  entryPrice: number;
  stopLossPrice: number;
  stopLossPips: number;
  takeProfit1Price: number;
  takeProfit1Pips: number;
  takeProfit2Price: number;
  takeProfit2Pips: number;
  riskRewardRatio: string;
  recommendedLot: number;
  accountRiskAmount: number;
  formattedText: string;
  accountSizingWarning?: string;
}

export interface SignalData {
  asset: string;
  timeframe: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  confidence: number;
  trend: 'Bullish' | 'Bearish' | 'Neutral';
  velocity: string;
  generatedAt: number;
  targetPrice?: number;
  entryPrice?: number;
  technicalAudit?: TechnicalAudit;
  expirySeconds?: number;
  mt5?: MT5TradeParameters;

  // Dual Analysis Mode Extensions
  mode?: AnalysisMode;
  status?: 'READY' | 'ANALYSIS_BLOCKED';
  blockedReason?: string;
  marketStructure?: MarketStructureType;
  structureCue?: StructureCue;
  structureSummary?: string;
  confluenceFactorsList?: ConfluenceFactorItem[];
  gatePassed?: boolean;
  entryZone?: EntryZone;
  invalidationLevel?: number;
  invalidationReason?: string;
  plainLanguageReason?: string;
  riskNote?: string;
  shortHoldGuidance?: string;
  peakMomentumWindow?: string;
  volumeProfile?: VolumeProfileContext;
  accountSizingWarning?: string;
  whyBullets?: string[];
  sessionNote?: string;
  sessionQuality?: 'PRIME' | 'NORMAL' | 'CAUTION' | 'THIN';
  suggestedExpiryWindow?: string;
  suggestedExpiryMinutes?: number;
  suggestedExpiryReason?: string;
  platform?: string;
  platformName?: string;
  analysisProfile?: AnalysisProfile;
  multiWindow?: MultiWindowConfirmation;
  historyLearning?: HistoryLearningContext;
}

export type AnalysisProfile = 'BINARY_QUICK' | 'MT5';

export interface BrokerPlatformItem {
  id: string;
  name: string;
  profile: AnalysisProfile;
  enabled: boolean;
  referralUrl?: string;
  badge?: string;
  icon?: string;
  description?: string;
  sortOrder: number;
}

export interface MultiWindowConfirmation {
  longWindowDesc: string;
  longBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  midWindowDesc: string;
  midBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  shortWindowDesc: string;
  shortBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  allAgreed: boolean;
  conflictSummary?: string;
  suggestedExpiryMinutes?: number;
  suggestedExpiryReason?: string;
}

export interface HistoryLearningContext {
  totalRecent: number;
  wins: number;
  losses: number;
  winRatePct: number;
  penaltyApplied: number;
  adjustedWaitThreshold: number;
  status: 'FAVORABLE' | 'NEUTRAL' | 'CAUTION_RAISED_THRESHOLD';
  note: string;
}

export interface DirectWalletOrder {
  id: string;
  user_id?: string | number;
  userId?: string | number;
  username: string;
  email?: string;
  userEmail?: string;
  package_id?: string | number;
  package_name?: string;
  packageName?: string;
  package_type?: 'CREDITS' | 'VIP_30_DAY' | 'BUNDLE' | 'VIP_30';
  packageType?: 'CREDITS' | 'VIP_30_DAY' | 'BUNDLE' | 'VIP_30';
  credits_amount?: number;
  creditsAmount?: number;
  price_usd?: number;
  amountUsd?: number;
  coin_symbol?: string;
  coinSymbol?: string;
  network?: string;
  wallet_address?: string;
  depositAddress?: string;
  tx_hash?: string;
  txHash?: string;
  notes?: string;
  status: 'pending_admin' | 'approved' | 'rejected';
  created_at?: string;
  createdAt?: string;
  reviewed_at?: string;
  reviewed_by?: string;
  processedAt?: string;
}

export interface SessionStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface PricingTier {
  id: number;
  credits: number;
  bonus: number;
  price: number;
  label: string;
  badge?: string;
}

export interface PricingPackage {
  id: number | string;
  name: string;
  type: 'CREDITS' | 'VIP_30_DAY' | 'BUNDLE';
  credits_amount: number;
  bonus_credits: number;
  price_usd: number;
  badge_label?: string;
  description?: string;
  is_active: boolean;
  sort_order: number;
}

export interface VipCodeItem {
  id: string | number;
  code: string;
  duration_days: number;
  is_active: boolean;
  is_redeemed: boolean;
  redeemed_by?: string | null;
  redeemed_by_username?: string | null;
  redeemed_by_user_id?: string | number | null;
  redeemed_at?: string | null;
  created_at: string;
  created_by?: string | null;
}

export interface AdminUserItem {
  id: number | string;
  auth_user_id?: string;
  username: string;
  email: string;
  role: 'USER' | 'ADMIN' | 'VIP';
  credits: number;
  is_vip: boolean;
  vip_expires_at?: string | null;
  vip_days_left: number;
  vip_hours_left: number;
  registration_ip?: string;
  created_at?: string;
  status?: string;
}

export interface BlogPostItem {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  cover_url?: string;
  category?: string;
  author?: string;
  author_role?: string;
  read_time?: string;
  is_published: boolean;
  created_at: string;
  updated_at?: string;
}

export interface CryptoWallet {
  id: number;
  coinName: string;
  symbol: string;
  network: string;
  address: string;
  active: boolean;
}

export interface UserProfile {
  id: number;
  username: string;
  email: string;
  role: 'USER' | 'ADMIN';
  credits: number;
  is_vip: boolean;
  vip_expires_at?: string | null;
  vip_days_left: number;
  vip_hours_left: number;
  vip_seconds_left: number;
}

export interface BlogArticle {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string[];
  author: string;
  authorRole: string;
  readTime: string;
  date: string;
  category: string;
  imageUrl: string;
  tags: string[];
  keyTakeaways: string[];
}

export interface BrokerItemConfig {
  enabled: boolean;
  label: string;
  referralUrl: string;
  openInNewTab: boolean;
}

export interface ReferralBonusConfig {
  enabled: boolean;
  extraCredits: number;
  message: string;
  referralCode?: string;
}

export interface BrokersSettings {
  brokers: {
    deriv: BrokerItemConfig;
    expertOption: BrokerItemConfig;
  };
  referralBonus: ReferralBonusConfig;
}

export interface ExternalBrokerConfig {
  enabled: boolean;
  brokerName: string;
  brokerUrl: string;
  openInNewTab: boolean;
  buttonLabel: string;
}

export interface SiteSettings {
  siteName: string;
  siteTagline: string;
  logoUrl?: string;
  faviconUrl?: string;
  logoIcon: 'zap' | 'activity' | 'shield' | 'flame' | 'trending';
  badgeText: string;
  bannerText: string;
  bannerEnabled: boolean;
  supportTelegram: string;
  supportWhatsapp: string;
  supportEmail: string;
  vipPriceUsd: number;
  starterPriceUsd: number;
  themeAccent: 'emerald' | 'amber' | 'blue' | 'purple';
}

export interface NowPaymentsConfig {
  apiKey: string;
  ipnSecret: string;
  isSandbox: boolean;
  enabled: boolean;
  payoutAddress?: string;
}

export interface NowPaymentsPayment {
  paymentId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  priceAmount: number;
  priceCurrency: string;
  orderId: string;
  orderDescription: string;
  paymentStatus: 'waiting' | 'confirming' | 'confirmed' | 'sending' | 'finished' | 'failed' | 'refunded' | 'expired';
  createdAt: string;
  updatedAt?: string;
  actuallyPaid?: number;
}

export type PageView = 'landing' | 'cockpit' | 'blog' | 'about' | 'pricing' | 'admin' | 'files' | 'supabase';

export type AuthModalMode = 'login' | 'register' | 'profile' | 'redeem-vip' | null;
