import type {
  AnalysisProfile,
  AssetConfig,
  BinaryExpiryWindow,
  FeedHealthStatus,
  PriceDistributionProxy,
  SignalStrength,
  TimestampedTick,
} from '../../types.ts';
import type { Candle, FeedStatus } from '../../services/liveFeed.ts';

export type BinaryExpiry = BinaryExpiryWindow;
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
  preferredExpiry?: BinaryExpiry;
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
  feedSource: string;
  inputsSnapshot: Record<string, unknown>;
}

export type {
  AnalysisProfile,
  AssetConfig,
  Candle,
  PriceDistributionProxy,
  SignalStrength,
  TimestampedTick,
};
