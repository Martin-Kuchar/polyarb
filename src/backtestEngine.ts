import { readFile } from "fs/promises";
import { DumpHedgeTrader } from "./dumpHedgeTrader";
import type { MarketSnapshot } from "./models";

export interface HistoricalPoint {
  timestamp: number;
  up_price: number;
  down_price: number;
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
    days?: number;
    fetched_at?: number;
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
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<HistoricalPayload>;
  if (!Array.isArray(parsed.histories) || parsed.histories.length === 0) {
    throw new Error(`Invalid historical payload in ${filePath}: expected non-empty histories array`);
  }
  return parsed as HistoricalPayload;
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

      const upPrice = point.up_price;
      const downPrice = point.down_price;
      if (!(upPrice > 0 && upPrice < 1 && downPrice > 0 && downPrice < 1)) {
        continue;
      }

      const upQuote = applySyntheticSpread(upPrice);
      const downQuote = applySyntheticSpread(downPrice);

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