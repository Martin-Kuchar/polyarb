import * as fs from "fs";
import * as readline from "readline";
import { loadConfig } from "./config";

type Side = "Up" | "Down";

interface Snapshot {
  marketName: string;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  remainingSeconds: number;
  marketTimestamp: number;
  currentTime: number;
}

export interface CliOptions {
  filePath: string;
  shares: number;
  sumTarget: number;
  moveThreshold: number;
  windowMinutes: number;
  stopLossMaxWaitMinutes: number;
  stopLossPercentage: number;
}

export interface CliOverrides {
  filePath?: string;
  shares?: number;
  sumTarget?: number;
  moveThreshold?: number;
  windowMinutes?: number;
  stopLossMaxWaitMinutes?: number;
  stopLossPercentage?: number;
}

export interface SimTrade {
  marketName: string;
  marketTimestamp: number;
  leg1Side: Side;
  leg1Price: number;
  leg2Side?: Side;
  leg2Price?: number;
  shares: number;
  expectedProfit?: number;
  realizedProfit?: number;
  stopLoss: boolean;
  stopLossElapsedMinutes?: number;
  settledByWinner?: Side;
}

interface PeriodState {
  marketName: string;
  marketTimestamp: number;
  upPriceHistory: Array<[number, number]>;
  downPriceHistory: Array<[number, number]>;
  lastUpAsk: number;
  lastDownAsk: number;
  lastRemainingSeconds: number;
  phase:
    | {
        kind: "WatchingForDump";
        roundStartTime: number;
        windowEndTime: number;
      }
    | {
        kind: "WaitingForHedge";
        leg1Side: Side;
        leg1Price: number;
        shares: number;
        leg1Timestamp: number;
      }
    | {
        kind: "CycleComplete";
      };
  trade?: SimTrade;
  realized: boolean;
}

export interface BacktestStats {
  linesRead: number;
  snapshotsRead: number;
  periodsSeen: number;
  leg1Buys: number;
  targetHedges: number;
  stopLossHedges: number;
  dumpedUp: number;
  dumpedDown: number;
  realizedTrades: number;
  unresolvedDirectional: number;
  totalExpectedProfit: number;
  totalRealizedProfit: number;
}

export interface BacktestResult {
  opts: CliOptions;
  stats: BacktestStats;
  settledTrades: SimTrade[];
}

const SNAPSHOT_REGEX = /^(.*?) Up Token BID:\$(\d+(?:\.\d+)?) ASK:\$(\d+(?:\.\d+)?) Down Token BID:\$(\d+(?:\.\d+)?) ASK:\$(\d+(?:\.\d+)?) remaining time:(\d+)m (\d+)s market_timestamp:(\d+)$/;
const WINNER_REGEX = /^Market Closed - (Up|Down) Winner:/i;

export function parseArgs(argv: string[]): CliOverrides {
  const opts: CliOverrides = {};

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && argv[i + 1]) {
      opts.filePath = argv[++i];
      continue;
    }
    if (a === "--shares" && argv[i + 1]) {
      opts.shares = Number(argv[++i]);
      continue;
    }
    if (a === "--sum-target" && argv[i + 1]) {
      opts.sumTarget = Number(argv[++i]);
      continue;
    }
    if (a === "--move-threshold" && argv[i + 1]) {
      opts.moveThreshold = Number(argv[++i]);
      continue;
    }
    if (a === "--window-minutes" && argv[i + 1]) {
      opts.windowMinutes = Number(argv[++i]);
      continue;
    }
    if (a === "--stop-loss-max-wait-minutes" && argv[i + 1]) {
      opts.stopLossMaxWaitMinutes = Number(argv[++i]);
      continue;
    }
    if (a === "--stop-loss-percentage" && argv[i + 1]) {
      opts.stopLossPercentage = Number(argv[++i]);
      continue;
    }
  }

  return opts;
}

export function buildOptionsFromEnvAndCli(argv: string[]): CliOptions {
  const config = loadConfig();
  const cli = parseArgs(argv);
  const trading = config.trading;

  return {
    filePath: cli.filePath ?? "history.toml",
    shares: cli.shares ?? trading.dumpHedgeShares,
    sumTarget: cli.sumTarget ?? trading.dumpHedgeSumTarget,
    moveThreshold: cli.moveThreshold ?? trading.dumpHedgeMoveThreshold,
    windowMinutes: cli.windowMinutes ?? trading.dumpHedgeWindowMinutes,
    stopLossMaxWaitMinutes:
      cli.stopLossMaxWaitMinutes ?? trading.dumpHedgeStopLossMaxWaitMinutes,
    stopLossPercentage:
      cli.stopLossPercentage ?? trading.dumpHedgeStopLossPercentage,
  };
}

function parseSnapshot(line: string): Snapshot | null {
  const m = line.match(SNAPSHOT_REGEX);
  if (!m) return null;

  const marketName = m[1].trim();
  const upBid = Number(m[2]);
  const upAsk = Number(m[3]);
  const downBid = Number(m[4]);
  const downAsk = Number(m[5]);
  const remMins = Number(m[6]);
  const remSecs = Number(m[7]);
  const marketTimestamp = Number(m[8]);

  const remainingSeconds = remMins * 60 + remSecs;
  const currentTime = marketTimestamp + 900 - remainingSeconds;

  if (
    !Number.isFinite(upAsk) ||
    !Number.isFinite(downAsk) ||
    !Number.isFinite(currentTime) ||
    !Number.isFinite(marketTimestamp)
  ) {
    return null;
  }

  return {
    marketName,
    upBid,
    upAsk,
    downBid,
    downAsk,
    remainingSeconds,
    marketTimestamp,
    currentTime,
  };
}

function periodKey(marketName: string, marketTimestamp: number): string {
  return `${marketName}:${marketTimestamp}`;
}

function checkDump(priceHistory: Array<[number, number]>, currentTime: number, moveThreshold: number): boolean {
  if (priceHistory.length < 2) return false;

  const threeSecondsAgo = currentTime - 3;
  let oldPrice: number | null = null;
  let oldTs: number | null = null;
  let newPrice: number | null = null;
  let newTs: number | null = null;

  for (const [ts, price] of priceHistory) {
    if (ts <= threeSecondsAgo) {
      if (oldTs == null || ts > oldTs) {
        oldPrice = price;
        oldTs = ts;
      }
    }
    if (newTs == null || ts > newTs) {
      newPrice = price;
      newTs = ts;
    }
  }

  if (oldPrice == null && priceHistory.length > 0) {
    oldPrice = priceHistory[0][1];
    oldTs = priceHistory[0][0];
  }

  if (newPrice == null && priceHistory.length > 0) {
    const latest = priceHistory[priceHistory.length - 1];
    newPrice = latest[1];
    newTs = latest[0];
  }

  if (oldPrice == null || newPrice == null || oldTs == null || newTs == null || oldPrice <= 0) {
    return false;
  }

  const timeDiff = newTs - oldTs;
  if (timeDiff < 1 || timeDiff > 5) return false;

  const priceDrop = oldPrice - newPrice;
  const dropPercent = priceDrop / oldPrice;
  return dropPercent >= moveThreshold && priceDrop > 0;
}

function realizeDirectionalTrade(state: PeriodState, winner: Side): number {
  const trade = state.trade;
  if (!trade) return 0;

  const leg1Payout = trade.leg1Side === winner ? trade.shares : 0;
  const realized = leg1Payout - trade.leg1Price * trade.shares;
  trade.realizedProfit = realized;
  trade.settledByWinner = winner;
  state.realized = true;
  return realized;
}

function inferWinner(state: PeriodState): Side {
  return state.lastUpAsk >= state.lastDownAsk ? "Up" : "Down";
}

function settlePeriod(
  state: PeriodState,
  winnerQueue: Side[],
  stats: BacktestStats,
  settledTrades: SimTrade[]
): void {
  if (state.realized || !state.trade) return;

  const trade = state.trade;
  if (trade.realizedProfit != null) {
    state.realized = true;
    settledTrades.push(trade);
    return;
  }

  if (trade.leg2Price != null) {
    const expected = trade.expectedProfit ?? 0;
    trade.realizedProfit = expected;
    state.realized = true;
    stats.totalRealizedProfit += expected;
    stats.realizedTrades += 1;
    settledTrades.push(trade);
    return;
  }

  const winner = winnerQueue.length > 0 ? winnerQueue.shift()! : inferWinner(state);
  const realized = realizeDirectionalTrade(state, winner);
  stats.totalRealizedProfit += realized;
  stats.realizedTrades += 1;
  settledTrades.push(trade);
}

export async function runBacktest(opts: CliOptions): Promise<BacktestResult> {
  if (!fs.existsSync(opts.filePath)) {
    throw new Error(`History file not found: ${opts.filePath}`);
  }

  const stats: BacktestStats = {
    linesRead: 0,
    snapshotsRead: 0,
    periodsSeen: 0,
    leg1Buys: 0,
    targetHedges: 0,
    stopLossHedges: 0,
    dumpedUp: 0,
    dumpedDown: 0,
    realizedTrades: 0,
    unresolvedDirectional: 0,
    totalExpectedProfit: 0,
    totalRealizedProfit: 0,
  };

  const winnerQueue: Side[] = [];
  const activeByMarket = new Map<string, PeriodState>();
  const settledTrades: SimTrade[] = [];

  const stream = fs.createReadStream(opts.filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const lineRaw of rl) {
    const line = lineRaw.trim();
    stats.linesRead += 1;

    const winnerMatch = line.match(WINNER_REGEX);
    if (winnerMatch) {
      winnerQueue.push((winnerMatch[1][0].toUpperCase() + winnerMatch[1].slice(1).toLowerCase()) as Side);
      continue;
    }

    const snapshot = parseSnapshot(line);
    if (!snapshot) {
      continue;
    }

    stats.snapshotsRead += 1;

    const existingState = activeByMarket.get(snapshot.marketName);
    if (!existingState || existingState.marketTimestamp !== snapshot.marketTimestamp) {
      if (existingState) {
        settlePeriod(existingState, winnerQueue, stats, settledTrades);
      }

      activeByMarket.set(snapshot.marketName, {
        marketName: snapshot.marketName,
        marketTimestamp: snapshot.marketTimestamp,
        upPriceHistory: [],
        downPriceHistory: [],
        lastUpAsk: snapshot.upAsk,
        lastDownAsk: snapshot.downAsk,
        lastRemainingSeconds: snapshot.remainingSeconds,
        phase: {
          kind: "WatchingForDump",
          roundStartTime: snapshot.marketTimestamp,
          windowEndTime: snapshot.marketTimestamp + opts.windowMinutes * 60,
        },
        trade: undefined,
        realized: false,
      });
      stats.periodsSeen += 1;
    }

    const state = activeByMarket.get(snapshot.marketName)!;

    state.lastUpAsk = snapshot.upAsk;
    state.lastDownAsk = snapshot.downAsk;
    state.lastRemainingSeconds = snapshot.remainingSeconds;

    if (snapshot.upAsk <= 0 || snapshot.downAsk <= 0) {
      continue;
    }

    state.upPriceHistory.push([snapshot.currentTime, snapshot.upAsk]);
    state.downPriceHistory.push([snapshot.currentTime, snapshot.downAsk]);
    if (state.upPriceHistory.length > 10) state.upPriceHistory.shift();
    if (state.downPriceHistory.length > 10) state.downPriceHistory.shift();

    if (state.phase.kind === "WatchingForDump") {
      if (snapshot.currentTime > state.phase.windowEndTime) {
        state.phase = { kind: "CycleComplete" };
        continue;
      }

      const upDump = checkDump(state.upPriceHistory, snapshot.currentTime, opts.moveThreshold);
      const downDump = checkDump(state.downPriceHistory, snapshot.currentTime, opts.moveThreshold);

      if (upDump || downDump) {
        const leg1Side: Side = upDump ? "Up" : "Down";
        const leg1Price = upDump ? snapshot.upAsk : snapshot.downAsk;

        state.trade = {
          marketName: snapshot.marketName,
          marketTimestamp: snapshot.marketTimestamp,
          leg1Side,
          leg1Price,
          shares: opts.shares,
          stopLoss: false,
        };

        stats.leg1Buys += 1;
        if (upDump) stats.dumpedUp += 1;
        if (downDump) stats.dumpedDown += 1;

        state.phase = {
          kind: "WaitingForHedge",
          leg1Side,
          leg1Price,
          shares: opts.shares,
          leg1Timestamp: snapshot.currentTime,
        };
      }
      continue;
    }

    if (state.phase.kind === "WaitingForHedge") {
      const oppositeAsk = state.phase.leg1Side === "Up" ? snapshot.downAsk : snapshot.upAsk;
      const oppositeSide: Side = state.phase.leg1Side === "Up" ? "Down" : "Up";
      const totalPrice = state.phase.leg1Price + oppositeAsk;

      const elapsedMinutes = Math.floor((snapshot.currentTime - state.phase.leg1Timestamp) / 60);
      const lossPerShare = totalPrice - 1;
      const lossRatio = totalPrice > 0 ? lossPerShare / totalPrice : 0;

      if (totalPrice <= opts.sumTarget) {
        if (state.trade) {
          state.trade.leg2Side = oppositeSide;
          state.trade.leg2Price = oppositeAsk;
          state.trade.expectedProfit = opts.shares - totalPrice * opts.shares;
          state.trade.realizedProfit = state.trade.expectedProfit;
          stats.totalExpectedProfit += state.trade.expectedProfit;
          stats.totalRealizedProfit += state.trade.expectedProfit;
          stats.realizedTrades += 1;
          settledTrades.push(state.trade);
        }
        stats.targetHedges += 1;
        state.realized = true;
        state.phase = { kind: "CycleComplete" };
        continue;
      }

      if (elapsedMinutes >= opts.stopLossMaxWaitMinutes && lossRatio > opts.stopLossPercentage) {
        if (state.trade) {
          state.trade.stopLoss = true;
          state.trade.stopLossElapsedMinutes = elapsedMinutes;
          state.trade.leg2Side = oppositeSide;
          state.trade.leg2Price = oppositeAsk;
          state.trade.expectedProfit = opts.shares - totalPrice * opts.shares;
          state.trade.realizedProfit = state.trade.expectedProfit;
          stats.totalExpectedProfit += state.trade.expectedProfit;
          stats.totalRealizedProfit += state.trade.expectedProfit;
          stats.realizedTrades += 1;
          settledTrades.push(state.trade);
        }
        stats.stopLossHedges += 1;
        state.realized = true;
        state.phase = { kind: "CycleComplete" };
      }
    }
  }

  for (const state of activeByMarket.values()) {
    if (!state.trade) continue;

    if (state.trade.leg2Price == null && state.trade.realizedProfit == null) {
      stats.unresolvedDirectional += 1;
    }

    settlePeriod(state, winnerQueue, stats, settledTrades);
  }

  return {
    opts,
    stats,
    settledTrades,
  };
}

export function printBacktestSummary(result: BacktestResult): void {
  const { opts, stats, settledTrades } = result;
  const avgProfit = stats.realizedTrades > 0 ? stats.totalRealizedProfit / stats.realizedTrades : 0;
  const stopLossRate = stats.leg1Buys > 0 ? (stats.stopLossHedges / stats.leg1Buys) * 100 : 0;

  console.log("Backtest Summary");
  console.log("----------------");
  console.log(`File: ${opts.filePath}`);
  console.log(`Lines read: ${stats.linesRead}`);
  console.log(`Snapshots: ${stats.snapshotsRead}`);
  console.log(`Periods seen: ${stats.periodsSeen}`);
  console.log(`Leg1 entries: ${stats.leg1Buys}`);
  console.log(`UP dumps: ${stats.dumpedUp}`);
  console.log(`DOWN dumps: ${stats.dumpedDown}`);
  console.log(`Target hedges: ${stats.targetHedges}`);
  console.log(`Stop-loss hedges: ${stats.stopLossHedges}`);
  console.log(`Stop-loss max wait threshold: ${opts.stopLossMaxWaitMinutes}m`);
  console.log(`Stop-loss rate: ${stopLossRate.toFixed(2)}%`);
  console.log(`Directional settlements: ${Math.max(0, stats.realizedTrades - stats.targetHedges - stats.stopLossHedges)}`);
  console.log(`Expected PnL (hedged only): $${stats.totalExpectedProfit.toFixed(2)}`);
  console.log(`Realized PnL: $${stats.totalRealizedProfit.toFixed(2)}`);
  console.log(`Avg PnL per settled trade: $${avgProfit.toFixed(4)}`);

  if (settledTrades.length > 0) {
    console.log("\nSettled Trades (in order)");
    console.log("-------------------------");
    let runningProfit = 0;
    for (const [index, t] of settledTrades.entries()) {
      const realized = t.realizedProfit ?? 0;
      runningProfit += realized;
      const leg2Text = t.leg2Price != null && t.leg2Side
        ? `${t.leg2Side}@$${t.leg2Price.toFixed(4)}`
        : `UNHEDGED winner=${t.settledByWinner ?? "?"}`;
      const stopLossText = t.stopLoss
        ? `yes(trigger=${t.stopLossElapsedMinutes ?? "?"}m threshold=${opts.stopLossMaxWaitMinutes}m)`
        : "no";
      console.log(
        `#${index + 1} ${t.marketName} period=${t.marketTimestamp} leg1=${t.leg1Side}@$${t.leg1Price.toFixed(4)} leg2=${leg2Text} stopLoss=${stopLossText} currentProfit=$${runningProfit.toFixed(4)}`
      );
    }
  }
}

async function main(): Promise<void> {
  const opts = buildOptionsFromEnvAndCli(process.argv);
  const result = await runBacktest(opts);
  printBacktestSummary(result);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Backtest failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
