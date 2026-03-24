import assert from "node:assert/strict";
import { evaluateBacktest, type HistoricalPeriod } from "./backtestEngine";
import { setLoggingEnabled } from "./logger";

async function run(): Promise<void> {
  setLoggingEnabled(false);

  const periodTs = 1_000;
  const histories: HistoricalPeriod[] = [
    {
      slug: "btc-up-or-down-15m-test",
      period_ts: periodTs,
      condition_id: "cond-test-close-before-hedge",
      resolved_winner: "Down",
      points: [
        { timestamp: periodTs, up_price: 0.7, down_price: 0.3 },
        // Up dumps >20% within 3 seconds, so leg-1 buy should trigger on Up.
        { timestamp: periodTs + 3, up_price: 0.5, down_price: 0.5 },
        // Keep sum above target so hedge never triggers.
        { timestamp: periodTs + 200, up_price: 0.52, down_price: 0.48 },
        // Close with Down as winner so unhedged Up should realize a loss.
        { timestamp: periodTs + 900, up_price: 0.1, down_price: 0.9 },
      ],
    },
  ];

  const shares = 5;
  const stats = await evaluateBacktest(histories, {
    shares,
    sumTarget: 0.8,
    moveThreshold: 0.2,
    windowMinutes: 5,
    stopLossMaxWaitMinutes: 60,
    stopLossPercentage: 1.0,
  });

  const expectedLoss = -shares * 0.505;

  assert.equal(stats.periodsSeen, 1, "should evaluate exactly one period");
  assert.equal(stats.periodsWithPrices, 1, "period should have valid prices");
  assert.equal(stats.periodsTraded, 1, "dump should open leg-1 trade");
  assert.equal(stats.cyclesHedged, 0, "leg-2 hedge should not be bought");
  assert.ok(
    Math.abs(stats.totalProfit - expectedLoss) < 1e-9,
    `expected totalProfit ${expectedLoss}, got ${stats.totalProfit}`
  );

  console.log("Backtest close-before-hedge regression test passed.");
}

run().catch((error) => {
  console.error("Backtest close-before-hedge regression test failed:", error);
  process.exit(1);
});
