import type {
  AnalysisProfile,
  AssetConfig,
  BinaryExpirySelection,
  BinaryExpiryWindow,
  DistanceUnit,
  FeedHealthStatus,
  PriceDistributionProxy,
  SignalStrength,
  TimestampedTick,
} from '../../types.ts';
import type { Candle, FeedStatus } from '../../services/liveFeed.ts';

export type BinaryExpiry = BinaryExpiryWindow;
export type BinaryExpiryChoice = BinaryExpirySelection;
export type EngineFeedStatus = FeedStatus | FeedHealthStatus;

export interface MarketEventItem {
  id?: string;
  starts_at: string;
  ends_at?: string | null;
  currency: string;
  title: string;
  impact: 'LOW' | 'MEDIUM' | 'HIGH' | 'HOLIDAY';
}

export interface KeyLevels {
  nearestSupport: number;
  nearestResistance: number;
  swingHighs: number[];
  swingLows: number[];
}

export interface BinaryEngineInput {
  asset: AssetConfig;
  platform: string;
  platformName?: string;
  m1Candles: Candle[];
  m5Candles?: Candle[];
  m15Candles: Candle[];
  ticks: TimestampedTick[];
  feedStatus: EngineFeedStatus;
  feedSource?: string;
  payoutPct?: number;
  isOtc?: boolean;
  marketEvents?: MarketEventItem[];
  preferredExpiry?: BinaryExpiryChoice;
  nowMs?: number;
}

export interface BinarySignalOutput {
  engine: 'binary_v1';
  profile: 'BINARY_QUICK';
  platform: string;
  platformName?: string;
  asset: string;
  symbol: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  expiry: BinaryExpiry;
  expirySeconds: number;
  strength: SignalStrength;
  rawScore: number;
  reasons: [string, string, string];
  whyNotTrade?: string;
  payoutPct: number;
  breakEvenWinRatePct: number;
  breakEvenMessage: string;
  enterWithinSeconds: number;
  createdAt: string;
  validUntil: string;
  generatedAt: number;
  entryPrice: number;
  distanceUnit?: DistanceUnit;
  feedSource: string;
  inputsSnapshot: Record<string, unknown>;
}

export interface DailyPivotLevels {
  pivot: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
}

export interface MT5KeyLevels extends KeyLevels {
  pdh: number | null;
  pdl: number | null;
  pwh: number | null;
  pwl: number | null;
  dailyPivot: DailyPivotLevels | null;
  roundNumbers: number[];
}

export interface MT5EngineInput {
  asset: AssetConfig;
  platform: string;
  platformName?: string;
  d1Candles: Candle[];
  h4Candles: Candle[];
  h1Candles: Candle[];
  m15Candles: Candle[];
  m5Candles: Candle[];
  structureTimeframe?: 'H1' | 'M15';
  feedStatus: EngineFeedStatus;
  feedSource?: string;
  isOtc?: boolean;
  marketEvents?: MarketEventItem[];
  instrumentSpec?: Partial<import('../../types.ts').InstrumentSpec>;
  accountCurrency?: import('../../types.ts').UserTradingProfile['accountCurrency'] | string;
  accountBalance?: number;
  riskPct?: number;
  leverage?: number;
  spreadPips?: number;
  spreadPrice?: number;
  contractSizeOverride?: number;
  conversionRates?: Record<string, number>;
  nowMs?: number;
}

export interface MT5SignalOutput {
  engine: 'mt5_v1';
  profile: 'MT5';
  platform: string;
  platformName?: string;
  asset: string;
  symbol: string;
  direction: 'BUY' | 'SELL' | 'WAIT';
  orderKind: 'MARKET' | 'LIMIT';
  entryPrice: number;
  entryZone: { min: number; max: number } | null;
  stopLoss: number | null;
  stopLossPips: number | null;
  takeProfit1: number | null;
  takeProfit1Pips: number | null;
  takeProfit2: number | null;
  takeProfit2Pips: number | null;
  lotSize: number;
  riskMoney: number;
  accountCurrency: string;
  rewardRiskTp1: number | null;
  rewardRiskTp2: number | null;
  rewardRiskRatio: string;
  validityCandles: number;
  validityMinutes: number;
  validityWindowDesc: string;
  validUntil: string;
  invalidationLevel: number | null;
  invalidationDriftPrice: number | null;
  invalidationRule: string;
  sessionNote: string;
  sessionQuality: 'PRIME' | 'NORMAL' | 'CAUTION' | 'THIN';
  tradeManagementNote: string;
  copyOrderText: string;
  strength: SignalStrength;
  rawScore: number;
  reasons: [string, string, string];
  whyNotTrade?: string;
  accountSizingWarning?: string;
  riskWarning?: string;
  distanceUnit?: DistanceUnit;
  structureTimeframe: 'H1' | 'M15';
  timeframe: string;
  createdAt: string;
  generatedAt: number;
  feedSource: string;
  inputsSnapshot: Record<string, unknown>;
}

export type { Candle } from '../../services/liveFeed.ts';
export type {
  AnalysisProfile,
  AssetConfig,
  DistanceUnit,
  InstrumentSpec,
  PriceDistributionProxy,
  SignalStrength,
  TimestampedTick,
  UserTradingProfile,
} from '../../types.ts';

