import { createReadStream } from "fs";
import { createInterface } from "readline";
import { DumpHedgeTrader } from "./dumpHedgeTrader";
import type { MarketSnapshot } from "./models";

export interface HistoricalPoint {
  timestamp: number;
  up_price: number;
  down_price: number;
  up_bid?: number;
  up_ask?: number;
  down_bid?: number;
  down_ask?: number;
}

export interface HistoricalPeriod {
  slug: string;
  period_ts: number;
  condition_id: string;
  resolved_winner?: "Up" | "Down" | null;
  points: HistoricalPoint[];
}

export interface HistoricalPayload {
  meta?: {
    source?: string;
    count?: number;
  };
  histories: HistoricalPeriod[];
}

export interface ReplaySettings {
  shares: number;
  sumTarget: number;
  moveThreshold: number;
  windowMinutes: number;
  stopLossMaxWaitMinutes: number;
  stopLossPercentage: number;
}

const BACKTEST_SYNTHETIC_SPREAD = 0.01;
const PERIOD_DURATION_SECONDS = 15 * 60;
const BTC_QUOTE_LINE_PATTERN =
  /^BTC 15m Up Token BID:\$(\d+(?:\.\d+)?) ASK:\$(\d+(?:\.\d+)?) Down Token BID:\$(\d+(?:\.\d+)?) ASK:\$(\d+(?:\.\d+)?) remaining time:(.+) market_timestamp:(\d+)$/;
const PERIOD_RESET_LINE_PATTERN = /^Dump-Hedge Trader: Period reset$/;

function clampProbability(value: number): number {
  return Math.max(0.001, Math.min(0.999, value));
}

function clampBid(value: number, ask: number): number {
  return Math.max(0, Math.min(ask, value));
}

function parseRemainingTimeSeconds(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (!match) return null;

  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return minutes * 60 + seconds;
}

function createHistoricalPeriod(periodTs: number, sequence: number): HistoricalPeriod {
  return {
    slug: "btc-15m",
    period_ts: periodTs,
    condition_id: `btc-15m-${periodTs}-${sequence}`,
    resolved_winner: null,
    points: [],
  };
}

function inferResolvedWinner(points: HistoricalPoint[], periodTs: number): "Up" | "Down" | null {
  if (points.length === 0) return null;

  const nearCloseThreshold = periodTs + PERIOD_DURATION_SECONDS - 2;
  const fallbackThreshold = periodTs + PERIOD_DURATION_SECONDS - 5;
  const nearClosePoints = points.filter((point) => point.timestamp >= nearCloseThreshold);
  const candidate = nearClosePoints[nearClosePoints.length - 1] ?? points[points.length - 1];
  if (!candidate || candidate.timestamp < fallbackThreshold) {
    return null;
  }

  const upBid = candidate.up_bid ?? candidate.up_price;
  const upAsk = candidate.up_ask ?? candidate.up_price;
  const downBid = candidate.down_bid ?? candidate.down_price;
  const downAsk = candidate.down_ask ?? candidate.down_price;
  const upMid = (upBid + upAsk) / 2;
  const downMid = (downBid + downAsk) / 2;

  if (!Number.isFinite(upMid) || !Number.isFinite(downMid) || upMid === downMid) {
    return null;
  }

  return upMid > downMid ? "Up" : "Down";
}

function applySyntheticSpread(mid: number): { bid: number; ask: number } {
  const halfSpread = BACKTEST_SYNTHETIC_SPREAD / 2;
  const ask = Math.max(0.001, Math.min(0.999, mid + halfSpread));
  const bid = Math.max(0.001, Math.min(ask, mid - halfSpread));
  return { bid, ask };
}

export interface BacktestStats {
  periodsSeen: number;
  periodsWithPrices: number;
  periodsTraded: number;
  cyclesHedged: number;
  forcedStopHedges: number;
  upPumpsDetected: number;
  downPumpsDetected: number;
  totalProfit: number;
  averageProfitPerTrade: number;
  maxDrawdown: number;
  winRate: number;
  fitness: number;
}

export async function loadHistoricalPayload(filePath: string): Promise<HistoricalPayload> {
  const histories: HistoricalPeriod[] = [];
  let currentPeriod: HistoricalPeriod | null = null;
  let periodSequence = 0;

  const finalizeCurrentPeriod = (): void => {
    if (!currentPeriod || currentPeriod.points.length === 0) {
      currentPeriod = null;
      return;
    }
    currentPeriod.resolved_winner = inferResolvedWinner(
      currentPeriod.points,
      currentPeriod.period_ts
    );
    histories.push(currentPeriod);
    currentPeriod = null;
  };

  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) continue;

    if (PERIOD_RESET_LINE_PATTERN.test(line)) {
      finalizeCurrentPeriod();
      continue;
    }

    const match = line.match(BTC_QUOTE_LINE_PATTERN);
    if (!match) continue;

    const [, upBidRaw, upAskRaw, downBidRaw, downAskRaw, remainingRaw, periodTsRaw] = match;
    const remainingSeconds = parseRemainingTimeSeconds(remainingRaw);
    const periodTs = Number(periodTsRaw);
    if (remainingSeconds == null || !Number.isFinite(periodTs)) {
      continue;
    }

    const upAsk = clampProbability(Number(upAskRaw));
    const downAsk = clampProbability(Number(downAskRaw));
    const upBid = clampBid(Number(upBidRaw), upAsk);
    const downBid = clampBid(Number(downBidRaw), downAsk);
    if (![upBid, upAsk, downBid, downAsk].every((value) => Number.isFinite(value))) {
      continue;
    }

    if (!currentPeriod || currentPeriod.period_ts !== periodTs) {
      finalizeCurrentPeriod();
      currentPeriod = createHistoricalPeriod(periodTs, periodSequence);
      periodSequence += 1;
    }

    const elapsedSeconds = Math.max(0, PERIOD_DURATION_SECONDS - remainingSeconds);
    const point: HistoricalPoint = {
      timestamp: periodTs + elapsedSeconds,
      up_price: upAsk,
      down_price: downAsk,
      up_bid: upBid,
      up_ask: upAsk,
      down_bid: downBid,
      down_ask: downAsk,
    };

    const lastPoint = currentPeriod.points[currentPeriod.points.length - 1];
    if (lastPoint && lastPoint.timestamp === point.timestamp) {
      currentPeriod.points[currentPeriod.points.length - 1] = point;
    } else {
      currentPeriod.points.push(point);
    }
  }

  finalizeCurrentPeriod();

  if (histories.length === 0) {
    throw new Error(`Invalid historical payload in ${filePath}: expected BTC 15m quote lines in history log`);
  }

  return {
    meta: {
      source: "history.toml",
      count: histories.length,
    },
    histories,
  };
}

export function normalizeHistories(payload: HistoricalPayload): HistoricalPeriod[] {
  return payload.histories
    .filter((history) => Array.isArray(history.points) && history.points.length > 0)
    .sort((left, right) => left.period_ts - right.period_ts);
}

export function envLinesForSettings(settings: ReplaySettings): string[] {
  return [
    `DUMP_HEDGE_SUM_TARGET=${settings.sumTarget.toFixed(4)}`,
    `DUMP_HEDGE_MOVE_THRESHOLD=${settings.moveThreshold.toFixed(4)}`,
    `DUMP_HEDGE_WINDOW_MINUTES=${settings.windowMinutes}`,
    `DUMP_HEDGE_STOP_LOSS_MAX_WAIT_MINUTES=${settings.stopLossMaxWaitMinutes}`,
    `DUMP_HEDGE_STOP_LOSS_PERCENTAGE=${settings.stopLossPercentage.toFixed(4)}`,
  ];
}

export function calculateFitness(stats: BacktestStats, sumTarget?: number): number {
  if (sumTarget != null && sumTarget >= 0.95) {
    return -1e9;
  }

  const tradeCount = Math.max(1, stats.cyclesHedged);
  const forcedStopRatio = stats.forcedStopHedges / tradeCount;

  let coveragePenalty = 0;
  if (stats.periodsWithPrices > 0) {
    const tradeRatio = stats.periodsTraded / stats.periodsWithPrices;
    coveragePenalty = Math.abs(tradeRatio - 0.2) * 5;
  }

  // Live execution is highly sensitive to spread/latency. Penalize settings
  // that depend too much on forced stop hedges or produce tiny edge per trade.
  const forcedStopPenalty = forcedStopRatio * 40 + stats.forcedStopHedges * 0.05;
  const thinEdgePenalty = Math.max(0, 0.12 - stats.averageProfitPerTrade) * 200;

  return (
    stats.totalProfit +
    20 * stats.winRate +
    4 * stats.averageProfitPerTrade +
    0.4 * stats.cyclesHedged +
    1.5 * stats.maxDrawdown -
    coveragePenalty -
    forcedStopPenalty -
    thinEdgePenalty -
    (tradeCount < 3 ? 2 : 0)
  );
}

export async function evaluateBacktest(
  histories: HistoricalPeriod[],
  settings: ReplaySettings
): Promise<BacktestStats> {
  const trader = new DumpHedgeTrader(
    null,
    true,
    settings.shares,
    settings.sumTarget,
    settings.moveThreshold,
    settings.windowMinutes,
    settings.stopLossMaxWaitMinutes,
    settings.stopLossPercentage
  );

  const equityCurve = [0];
  const tradePnls: number[] = [];

  const stats: BacktestStats = {
    periodsSeen: 0,
    periodsWithPrices: 0,
    periodsTraded: 0,
    cyclesHedged: 0,
    forcedStopHedges: 0,
    upPumpsDetected: 0,
    downPumpsDetected: 0,
    totalProfit: 0,
    averageProfitPerTrade: 0,
    maxDrawdown: 0,
    winRate: 0,
    fitness: -1e9,
  };

  let pendingClose:
    | {
        conditionId: string;
        periodTs: number;
        lastPoint: HistoricalPoint;
        resolvedWinner?: "Up" | "Down" | null;
      }
    | null = null;

  for (const history of histories) {
    if (pendingClose) {
      trader.finalizePeriodAtClose(
        pendingClose.conditionId,
        pendingClose.periodTs,
        pendingClose.lastPoint.up_price,
        pendingClose.lastPoint.down_price,
        pendingClose.resolvedWinner
      );
      pendingClose = null;
    }

    const periodTs = history.period_ts;
    stats.periodsSeen += 1;
    let hasPrices = false;
    let lastValidPoint: HistoricalPoint | null = null;
    const totalProfitBefore = await trader.getTotalProfit();

    for (const point of history.points) {
      const ts = point.timestamp;
      if (ts < periodTs || ts > periodTs + 900) continue;

      const hasActualQuotes =
        point.up_ask != null &&
        point.down_ask != null &&
        point.up_bid != null &&
        point.down_bid != null;
      const upQuote = hasActualQuotes
        ? {
            bid: clampBid(point.up_bid ?? 0, clampProbability(point.up_ask ?? point.up_price)),
            ask: clampProbability(point.up_ask ?? point.up_price),
          }
        : applySyntheticSpread(point.up_price);
      const downQuote = hasActualQuotes
        ? {
            bid: clampBid(point.down_bid ?? 0, clampProbability(point.down_ask ?? point.down_price)),
            ask: clampProbability(point.down_ask ?? point.down_price),
          }
        : applySyntheticSpread(point.down_price);

      if (!(upQuote.ask > 0 && upQuote.ask < 1 && downQuote.ask > 0 && downQuote.ask < 1)) {
        continue;
      }

      hasPrices = true;
      lastValidPoint = point;
      const snapshot: MarketSnapshot = {
        marketName: "BTC 15m",
        btcMarket15m: {
          conditionId: history.condition_id,
          marketName: "BTC 15m",
          upToken: {
            tokenId: `${history.condition_id}-up`,
            bid: upQuote.bid,
            ask: upQuote.ask,
          },
          downToken: {
            tokenId: `${history.condition_id}-down`,
            bid: downQuote.bid,
            ask: downQuote.ask,
          },
        },
        timestamp: ts * 1000,
        btc15mTimeRemaining: Math.max(0, periodTs + 900 - ts),
        btc15mPeriodTimestamp: periodTs,
      };

      await trader.processSnapshot(snapshot);
    }

    if (hasPrices && lastValidPoint) {
      pendingClose = {
        conditionId: history.condition_id,
        periodTs,
        lastPoint: lastValidPoint,
        resolvedWinner: history.resolved_winner,
      };
    }

    if (hasPrices) {
      stats.periodsWithPrices += 1;
    }

    const totalProfitAfter = await trader.getTotalProfit();
    const periodPnl = totalProfitAfter - totalProfitBefore;
    if (periodPnl !== 0) {
      tradePnls.push(periodPnl);
    }
    equityCurve.push(totalProfitAfter);
  }

  if (pendingClose) {
    trader.finalizePeriodAtClose(
      pendingClose.conditionId,
      pendingClose.periodTs,
      pendingClose.lastPoint.up_price,
      pendingClose.lastPoint.down_price,
      pendingClose.resolvedWinner
    );
  }

  stats.totalProfit = await trader.getTotalProfit();
  if (tradePnls.length > 0) {
    const wins = tradePnls.filter((value) => value > 0).length;
    stats.winRate = wins / tradePnls.length;
    stats.averageProfitPerTrade =
      tradePnls.reduce((sum, value) => sum + value, 0) / tradePnls.length;
  }

  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  stats.maxDrawdown = maxDrawdown;

  const traderStats = trader.getStats();
  stats.periodsTraded = traderStats.periodsTraded;
  stats.cyclesHedged = traderStats.cyclesHedged;
  stats.forcedStopHedges = traderStats.forcedStopHedges;
  stats.upPumpsDetected = traderStats.upPumpsDetected;
  stats.downPumpsDetected = traderStats.downPumpsDetected;
  stats.fitness = calculateFitness(stats, settings.sumTarget);

  return stats;
}