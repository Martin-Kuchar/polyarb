import { writeFile } from "fs/promises";
import path from "path";
import {
  envLinesForSettings,
  evaluateBacktest,
  loadHistoricalPayload,
  normalizeHistories,
  type BacktestStats,
  type ReplaySettings,
} from "./backtestEngine";
import { loadConfig } from "./config";
import { setLoggingEnabled } from "./logger";

interface Candidate {
  settings: ReplaySettings;
  stats: BacktestStats;
}

interface CliArgs {
  filePath: string;
  population: number;
  generations: number;
  elite: number;
  seed: number;
  writeEnv?: string;
  reportPath: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const getValue = (flag: string): string | undefined => {
    const index = args.findIndex((arg) => arg === flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    filePath: path.resolve(getValue("--file") ?? path.join("history.toml")),
    population: Number(getValue("--population") ?? "40"),
    generations: Number(getValue("--generations") ?? "20"),
    elite: Number(getValue("--elite") ?? "8"),
    seed: Number(getValue("--seed") ?? "42"),
    writeEnv: getValue("--write-env"),
    reportPath: path.resolve(getValue("--report-path") ?? path.join("cache", "ga_last_result.json")),
  };
}

function randomSettings(baseShares: number, randomizer: () => number): ReplaySettings {
  return {
    shares: baseShares,
    sumTarget: Number((0.86 + randomizer() * (0.99 - 0.86)).toFixed(4)),
    moveThreshold: Number((0.01 + randomizer() * (0.25 - 0.01)).toFixed(4)),
    windowMinutes: Math.floor(1 + randomizer() * 8),
    stopLossMaxWaitMinutes: Math.floor(1 + randomizer() * 10),
    stopLossPercentage: Number((0.01 + randomizer() * (0.35 - 0.01)).toFixed(4)),
  };
}

function crossover(a: ReplaySettings, b: ReplaySettings, randomizer: () => number): ReplaySettings {
  return {
    shares: a.shares,
    sumTarget:
      randomizer() < 0.7
        ? Number((((a.sumTarget + b.sumTarget) / 2)).toFixed(4))
        : (randomizer() < 0.5 ? a.sumTarget : b.sumTarget),
    moveThreshold:
      randomizer() < 0.7
        ? Number((((a.moveThreshold + b.moveThreshold) / 2)).toFixed(4))
        : (randomizer() < 0.5 ? a.moveThreshold : b.moveThreshold),
    windowMinutes: randomizer() < 0.5 ? a.windowMinutes : b.windowMinutes,
    stopLossMaxWaitMinutes:
      randomizer() < 0.5 ? a.stopLossMaxWaitMinutes : b.stopLossMaxWaitMinutes,
    stopLossPercentage:
      randomizer() < 0.7
        ? Number((((a.stopLossPercentage + b.stopLossPercentage) / 2)).toFixed(4))
        : (randomizer() < 0.5 ? a.stopLossPercentage : b.stopLossPercentage),
  };
}

function mutate(settings: ReplaySettings, randomizer: () => number, rate = 0.22): ReplaySettings {
  let sumTarget = settings.sumTarget;
  let moveThreshold = settings.moveThreshold;
  let windowMinutes = settings.windowMinutes;
  let stopWait = settings.stopLossMaxWaitMinutes;
  let stopPct = settings.stopLossPercentage;

  if (randomizer() < rate) {
    sumTarget = Number(Math.min(0.995, Math.max(0.82, sumTarget + (randomizer() * 0.06 - 0.03))).toFixed(4));
  }
  if (randomizer() < rate) {
    moveThreshold = Number(Math.min(0.35, Math.max(0.005, moveThreshold + (randomizer() * 0.06 - 0.03))).toFixed(4));
  }
  if (randomizer() < rate) {
    windowMinutes = Math.min(12, Math.max(1, windowMinutes + Math.floor(randomizer() * 5) - 2));
  }
  if (randomizer() < rate) {
    stopWait = Math.min(15, Math.max(1, stopWait + Math.floor(randomizer() * 5) - 2));
  }
  if (randomizer() < rate) {
    stopPct = Number(Math.min(0.5, Math.max(0.005, stopPct + (randomizer() * 0.1 - 0.05))).toFixed(4));
  }

  return {
    shares: settings.shares,
    sumTarget,
    moveThreshold,
    windowMinutes,
    stopLossMaxWaitMinutes: stopWait,
    stopLossPercentage: stopPct,
  };
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function runGa(histories: ReturnType<typeof normalizeHistories>, args: CliArgs): Promise<Candidate> {
  const baseConfig = loadConfig();
  const randomizer = createSeededRandom(args.seed);
  let population = Array.from({ length: args.population }, () =>
    randomSettings(baseConfig.trading.dumpHedgeShares, randomizer)
  );
  let bestCandidate: Candidate | null = null;

  for (let generation = 0; generation < args.generations; generation += 1) {
    const scored: Candidate[] = [];
    for (const settings of population) {
      const stats = await evaluateBacktest(histories, settings);
      scored.push({ settings, stats });
    }

    scored.sort((left, right) => right.stats.fitness - left.stats.fitness);
    if (!bestCandidate || scored[0].stats.fitness > bestCandidate.stats.fitness) {
      bestCandidate = scored[0];
    }

    const generationBest = scored[0];
    console.log(
      `Generation ${String(generation + 1).padStart(2, "0")}/${args.generations} | ` +
        `fitness=${generationBest.stats.fitness.toFixed(4)} ` +
        `profit=${generationBest.stats.totalProfit.toFixed(2)} ` +
        `trades=${generationBest.stats.cyclesHedged} ` +
        `win_rate=${(generationBest.stats.winRate * 100).toFixed(2)}%`
    );

    const elite = scored.slice(0, args.elite).map((candidate) => candidate.settings);
    const nextPopulation = [...elite];
    while (nextPopulation.length < args.population) {
      const parentA = elite[Math.floor(randomizer() * elite.length)];
      const parentB = elite[Math.floor(randomizer() * elite.length)];
      nextPopulation.push(mutate(crossover(parentA, parentB, randomizer), randomizer));
    }
    population = nextPopulation;
  }

  if (!bestCandidate) {
    throw new Error("GA failed to produce a candidate");
  }
  return bestCandidate;
}

async function main(): Promise<void> {
  setLoggingEnabled(false);
  const startedAt = Date.now();
  const args = parseArgs();
  if (args.elite <= 1 || args.elite > args.population) {
    throw new Error("--elite must be in range [2, population]");
  }

  const payload = await loadHistoricalPayload(args.filePath);
  const histories = normalizeHistories(payload);
  const pointCount = histories.reduce((sum, history) => sum + history.points.length, 0);
  console.log(`Loaded BTC 15m history log: ${args.filePath}`);
  if (payload.meta?.source) {
    console.log(`History source: ${payload.meta.source} count=${payload.meta.count ?? histories.length}`);
  }
  console.log(`Loaded ${histories.length} BTC 15m histories with ${pointCount} price points across ${histories.length} periods`);

  const best = await runGa(histories, args);
  console.log("\n=== BEST SETTINGS ===");
  for (const line of envLinesForSettings(best.settings)) {
    console.log(line);
  }

  console.log("\n=== BACKTEST SUMMARY ===");
  console.log(`periods_seen=${best.stats.periodsSeen}`);
  console.log(`periods_with_prices=${best.stats.periodsWithPrices}`);
  console.log(`periods_traded=${best.stats.periodsTraded}`);
  console.log(`cycles_hedged=${best.stats.cyclesHedged}`);
  console.log(`forced_stop_hedges=${best.stats.forcedStopHedges}`);
  console.log(`win_rate=${(best.stats.winRate * 100).toFixed(2)}%`);
  console.log(`total_profit=${best.stats.totalProfit.toFixed(4)}`);
  console.log(`avg_profit_per_trade=${best.stats.averageProfitPerTrade.toFixed(6)}`);
  console.log(`max_drawdown=${best.stats.maxDrawdown.toFixed(4)}`);
  console.log(`fitness=${best.stats.fitness.toFixed(4)}`);
  console.log(`elapsed_seconds=${((Date.now() - startedAt) / 1000).toFixed(2)}`);

  if (args.writeEnv) {
    await writeFile(path.resolve(args.writeEnv), `${envLinesForSettings(best.settings).join("\n")}\n`, "utf8");
    console.log(`\nSaved optimized env block to: ${args.writeEnv}`);
  }

  await writeFile(
    args.reportPath,
    JSON.stringify(
      {
        generated_at: Math.floor(Date.now() / 1000),
        settings: {
          dump_hedge_sum_target: best.settings.sumTarget,
          dump_hedge_move_threshold: best.settings.moveThreshold,
          dump_hedge_window_minutes: best.settings.windowMinutes,
          dump_hedge_stop_loss_max_wait_minutes: best.settings.stopLossMaxWaitMinutes,
          dump_hedge_stop_loss_percentage: best.settings.stopLossPercentage,
        },
        stats: {
          periods_seen: best.stats.periodsSeen,
          periods_with_prices: best.stats.periodsWithPrices,
          periods_traded: best.stats.periodsTraded,
          cycles_hedged: best.stats.cyclesHedged,
          forced_stop_hedges: best.stats.forcedStopHedges,
          total_profit: best.stats.totalProfit,
          average_profit_per_trade: best.stats.averageProfitPerTrade,
          max_drawdown: best.stats.maxDrawdown,
          win_rate: best.stats.winRate,
          fitness: best.stats.fitness,
        },
        args,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Saved report: ${args.reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});