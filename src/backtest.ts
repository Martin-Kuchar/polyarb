import { writeFile } from "fs/promises";
import path from "path";
import { loadConfig } from "./config";
import { setLoggingEnabled } from "./logger";
import {
  envLinesForSettings,
  evaluateBacktest,
  loadHistoricalPayload,
  normalizeHistories,
  type BacktestStats,
  type HistoricalPayload,
  type HistoricalPeriod,
} from "./backtestEngine";

function parseArgs(): { filePath: string; reportPath?: string } {
  const args = process.argv.slice(2);
  const fileIndex = args.findIndex((arg) => arg === "--file");
  const reportIndex = args.findIndex((arg) => arg === "--report-path");
  const explicitFile = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  const explicitReport = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
  return {
    filePath: explicitFile
      ? path.resolve(explicitFile)
      : path.resolve(process.cwd(), "cache", "btc_15m_second_history.json"),
    reportPath: explicitReport ? path.resolve(explicitReport) : undefined,
  };
}

async function writeReport(reportPath: string, stats: BacktestStats, elapsedMs: number): Promise<void> {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generated_at: Math.floor(Date.now() / 1000),
        stats: {
          periods_seen: stats.periodsSeen,
          periods_with_prices: stats.periodsWithPrices,
          periods_traded: stats.periodsTraded,
          cycles_hedged: stats.cyclesHedged,
          forced_stop_hedges: stats.forcedStopHedges,
          up_pumps_detected: stats.upPumpsDetected,
          down_pumps_detected: stats.downPumpsDetected,
          total_profit: stats.totalProfit,
          average_profit_per_trade: stats.averageProfitPerTrade,
          max_drawdown: stats.maxDrawdown,
          win_rate: stats.winRate,
          fitness: stats.fitness,
          elapsed_seconds: elapsedMs / 1000,
        },
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Saved report: ${reportPath}`);
}

async function printResults(
  filePath: string,
  payload: HistoricalPayload,
  histories: HistoricalPeriod[],
  elapsedMs: number,
  reportPath?: string
): Promise<void> {
  const config = loadConfig();
  const pointCount = histories.reduce((sum, history) => sum + history.points.length, 0);
  const stats = await evaluateBacktest(histories, {
    shares: config.trading.dumpHedgeShares,
    sumTarget: config.trading.dumpHedgeSumTarget,
    moveThreshold: config.trading.dumpHedgeMoveThreshold,
    windowMinutes: config.trading.dumpHedgeWindowMinutes,
    stopLossMaxWaitMinutes: config.trading.dumpHedgeStopLossMaxWaitMinutes,
    stopLossPercentage: config.trading.dumpHedgeStopLossPercentage,
  });

  console.log(`Loaded BTC 15m second history from JSON: ${filePath}`);
  if (payload.meta?.days != null) {
    console.log(`Cache meta: days=${payload.meta.days} count=${payload.meta.count ?? histories.length}`);
  }
  console.log(`Loaded ${histories.length} BTC 15m histories with ${pointCount} price points across ${histories.length} periods`);
  console.log("");
  console.log("=== BACKTEST SETTINGS ===");
  console.log(`DUMP_HEDGE_SHARES=${config.trading.dumpHedgeShares}`);
  for (const line of envLinesForSettings({
    shares: config.trading.dumpHedgeShares,
    sumTarget: config.trading.dumpHedgeSumTarget,
    moveThreshold: config.trading.dumpHedgeMoveThreshold,
    windowMinutes: config.trading.dumpHedgeWindowMinutes,
    stopLossMaxWaitMinutes: config.trading.dumpHedgeStopLossMaxWaitMinutes,
    stopLossPercentage: config.trading.dumpHedgeStopLossPercentage,
  })) {
    console.log(line);
  }
  console.log("");
  console.log("=== BACKTEST SUMMARY ===");
  console.log(`periods_seen=${stats.periodsSeen}`);
  console.log(`periods_with_prices=${stats.periodsWithPrices}`);
  console.log(`periods_traded=${stats.periodsTraded}`);
  console.log(`cycles_hedged=${stats.cyclesHedged}`);
  console.log(`forced_stop_hedges=${stats.forcedStopHedges}`);
  console.log(`up_pumps_detected=${stats.upPumpsDetected}`);
  console.log(`down_pumps_detected=${stats.downPumpsDetected}`);
  console.log(`win_rate=${(stats.winRate * 100).toFixed(2)}%`);
  console.log(`total_profit=${stats.totalProfit.toFixed(4)}`);
  console.log(`avg_profit_per_trade=${stats.averageProfitPerTrade.toFixed(6)}`);
  console.log(`max_drawdown=${stats.maxDrawdown.toFixed(4)}`);
  console.log(`fitness=${stats.fitness.toFixed(4)}`);
  console.log(`elapsed_seconds=${(elapsedMs / 1000).toFixed(2)}`);

  if (reportPath) {
    await writeReport(reportPath, stats, elapsedMs);
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  const { filePath, reportPath } = parseArgs();
  setLoggingEnabled(false);
  const payload = await loadHistoricalPayload(filePath);
  const histories = normalizeHistories(payload);

  if (histories.length === 0) {
    throw new Error(`No non-empty histories found in ${filePath}`);
  }

  await printResults(filePath, payload, histories, Date.now() - start, reportPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});