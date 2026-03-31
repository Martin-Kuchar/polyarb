import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config";
import { runBacktest, type BacktestResult, type CliOptions } from "./backtester";

export interface OptimizerArgs {
  filePath: string;
  population: number;
  generations: number;
  elite: number;
  mutationRate: number;
  seed: number;
  reportPath: string;
}

export interface CandidateSettings {
  sumTarget: number;
  moveThreshold: number;
  windowMinutes: number;
  stopLossMaxWaitMinutes: number;
  stopLossPercentage: number;
}

export interface EvaluatedCandidate {
  settings: CandidateSettings;
  result: BacktestResult;
  totalProfit: number;
  averageProfitPerTrade: number;
  maxDrawdown: number;
  winRate: number;
  fitness: number;
}

export interface OptimizerReport {
  generated_at: number;
  settings: {
    dump_hedge_sum_target: number;
    dump_hedge_move_threshold: number;
    dump_hedge_window_minutes: number;
    dump_hedge_stop_loss_max_wait_minutes: number;
    dump_hedge_stop_loss_percentage: number;
  };
  stats: {
    periods_seen: number;
    periods_traded: number;
    cycles_hedged: number;
    forced_stop_hedges: number;
    realized_trades: number;
    total_profit: number;
    average_profit_per_trade: number;
    max_drawdown: number;
    win_rate: number;
    fitness: number;
  };
  args: {
    filePath: string;
    population: number;
    generations: number;
    elite: number;
    mutationRate: number;
    seed: number;
    reportPath: string;
  };
}

export interface OptimizationResult {
  args: OptimizerArgs;
  best: EvaluatedCandidate;
  report: OptimizerReport;
}

const SEARCH_RANGES = {
  sumTarget: { min: 0.82, max: 0.99 },
  moveThreshold: { min: 0.05, max: 0.3 },
  windowMinutes: { min: 1, max: 5 },
  stopLossMaxWaitMinutes: { min: 1, max: 10 },
  stopLossPercentage: { min: 0.05, max: 0.5 },
};

function parseArgs(argv: string[]): Partial<OptimizerArgs> {
  const args: Partial<OptimizerArgs> = {};

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    if (current === "--file" && argv[i + 1]) {
      args.filePath = argv[++i];
      continue;
    }
    if (current === "--population" && argv[i + 1]) {
      args.population = Number(argv[++i]);
      continue;
    }
    if (current === "--generations" && argv[i + 1]) {
      args.generations = Number(argv[++i]);
      continue;
    }
    if (current === "--elite" && argv[i + 1]) {
      args.elite = Number(argv[++i]);
      continue;
    }
    if (current === "--mutation-rate" && argv[i + 1]) {
      args.mutationRate = Number(argv[++i]);
      continue;
    }
    if (current === "--seed" && argv[i + 1]) {
      args.seed = Number(argv[++i]);
      continue;
    }
    if (current === "--report" && argv[i + 1]) {
      args.reportPath = argv[++i];
      continue;
    }
  }

  return args;
}

export function buildOptimizerArgs(argv: string[]): OptimizerArgs {
  const cli = parseArgs(argv);
  const filePath = path.resolve(cli.filePath ?? "history.toml");
  const reportPath = path.resolve(cli.reportPath ?? path.join("cache", "ga_last_result.json"));
  const population = clampInteger(cli.population ?? 24, 6, 200);
  const generations = clampInteger(cli.generations ?? 12, 1, 200);
  const elite = clampInteger(cli.elite ?? 6, 1, Math.max(1, population - 1));
  const mutationRate = clamp(cli.mutationRate ?? 0.2, 0.01, 1);
  const seed = Number.isFinite(cli.seed) ? cli.seed as number : 42;

  return {
    filePath,
    population,
    generations,
    elite,
    mutationRate,
    seed,
    reportPath,
  };
}

function mulberry32(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current += 0x6d2b79f5;
    let temp = current;
    temp = Math.imul(temp ^ (temp >>> 15), temp | 1);
    temp ^= temp + Math.imul(temp ^ (temp >>> 7), temp | 61);
    return ((temp ^ (temp >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

function buildBaseOptions(filePath: string): CliOptions {
  const trading = loadConfig().trading;
  return {
    filePath,
    shares: trading.dumpHedgeShares,
    sumTarget: trading.dumpHedgeSumTarget,
    moveThreshold: trading.dumpHedgeMoveThreshold,
    windowMinutes: trading.dumpHedgeWindowMinutes,
    stopLossMaxWaitMinutes: trading.dumpHedgeStopLossMaxWaitMinutes,
    stopLossPercentage: trading.dumpHedgeStopLossPercentage,
  };
}

function randomCandidate(base: CliOptions, random: () => number): CandidateSettings {
  const useBaseBias = random() < 0.25;
  return normalizeCandidate({
    sumTarget: useBaseBias ? base.sumTarget : randomBetween(random, SEARCH_RANGES.sumTarget.min, SEARCH_RANGES.sumTarget.max),
    moveThreshold: useBaseBias ? base.moveThreshold : randomBetween(random, SEARCH_RANGES.moveThreshold.min, SEARCH_RANGES.moveThreshold.max),
    windowMinutes: useBaseBias ? base.windowMinutes : randomBetween(random, SEARCH_RANGES.windowMinutes.min, SEARCH_RANGES.windowMinutes.max),
    stopLossMaxWaitMinutes: useBaseBias ? base.stopLossMaxWaitMinutes : randomBetween(random, SEARCH_RANGES.stopLossMaxWaitMinutes.min, SEARCH_RANGES.stopLossMaxWaitMinutes.max),
    stopLossPercentage: useBaseBias ? base.stopLossPercentage : randomBetween(random, SEARCH_RANGES.stopLossPercentage.min, SEARCH_RANGES.stopLossPercentage.max),
  });
}

function normalizeCandidate(candidate: CandidateSettings): CandidateSettings {
  return {
    sumTarget: roundTo(clamp(candidate.sumTarget, SEARCH_RANGES.sumTarget.min, SEARCH_RANGES.sumTarget.max), 4),
    moveThreshold: roundTo(clamp(candidate.moveThreshold, SEARCH_RANGES.moveThreshold.min, SEARCH_RANGES.moveThreshold.max), 4),
    windowMinutes: clampInteger(candidate.windowMinutes, SEARCH_RANGES.windowMinutes.min, SEARCH_RANGES.windowMinutes.max),
    stopLossMaxWaitMinutes: clampInteger(candidate.stopLossMaxWaitMinutes, SEARCH_RANGES.stopLossMaxWaitMinutes.min, SEARCH_RANGES.stopLossMaxWaitMinutes.max),
    stopLossPercentage: roundTo(clamp(candidate.stopLossPercentage, SEARCH_RANGES.stopLossPercentage.min, SEARCH_RANGES.stopLossPercentage.max), 4),
  };
}

function crossover(a: CandidateSettings, b: CandidateSettings, random: () => number): CandidateSettings {
  return normalizeCandidate({
    sumTarget: random() < 0.5 ? a.sumTarget : b.sumTarget,
    moveThreshold: random() < 0.5 ? a.moveThreshold : b.moveThreshold,
    windowMinutes: random() < 0.5 ? a.windowMinutes : b.windowMinutes,
    stopLossMaxWaitMinutes: random() < 0.5 ? a.stopLossMaxWaitMinutes : b.stopLossMaxWaitMinutes,
    stopLossPercentage: random() < 0.5 ? a.stopLossPercentage : b.stopLossPercentage,
  });
}

function mutate(candidate: CandidateSettings, mutationRate: number, random: () => number): CandidateSettings {
  const mutated: CandidateSettings = { ...candidate };

  if (random() < mutationRate) {
    mutated.sumTarget += randomBetween(random, -0.03, 0.03);
  }
  if (random() < mutationRate) {
    mutated.moveThreshold += randomBetween(random, -0.04, 0.04);
  }
  if (random() < mutationRate) {
    mutated.windowMinutes += randomBetween(random, -1, 1);
  }
  if (random() < mutationRate) {
    mutated.stopLossMaxWaitMinutes += randomBetween(random, -2, 2);
  }
  if (random() < mutationRate) {
    mutated.stopLossPercentage += randomBetween(random, -0.05, 0.05);
  }

  return normalizeCandidate(mutated);
}

function candidateKey(candidate: CandidateSettings): string {
  return [
    candidate.sumTarget.toFixed(4),
    candidate.moveThreshold.toFixed(4),
    candidate.windowMinutes,
    candidate.stopLossMaxWaitMinutes,
    candidate.stopLossPercentage.toFixed(4),
  ].join("|");
}

function calculateMaxDrawdown(settledTrades: BacktestResult["settledTrades"]): number {
  let runningProfit = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of settledTrades) {
    runningProfit += trade.realizedProfit ?? 0;
    if (runningProfit > peak) {
      peak = runningProfit;
    }
    const drawdown = runningProfit - peak;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

function tournamentSelect(population: EvaluatedCandidate[], random: () => number): EvaluatedCandidate {
  let best = population[clampInteger(randomBetween(random, 0, population.length - 1), 0, population.length - 1)];
  for (let i = 0; i < 2; i++) {
    const challenger = population[clampInteger(randomBetween(random, 0, population.length - 1), 0, population.length - 1)];
    if (challenger.fitness > best.fitness) {
      best = challenger;
    }
  }
  return best;
}

async function evaluateCandidate(
  baseOptions: CliOptions,
  settings: CandidateSettings,
  cache: Map<string, EvaluatedCandidate>
): Promise<EvaluatedCandidate> {
  const key = candidateKey(settings);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const result = await runBacktest({
    ...baseOptions,
    sumTarget: settings.sumTarget,
    moveThreshold: settings.moveThreshold,
    windowMinutes: settings.windowMinutes,
    stopLossMaxWaitMinutes: settings.stopLossMaxWaitMinutes,
    stopLossPercentage: settings.stopLossPercentage,
  });

  const totalProfit = result.stats.totalRealizedProfit;
  const averageProfitPerTrade =
    result.stats.realizedTrades > 0 ? totalProfit / result.stats.realizedTrades : 0;
  const winRate =
    result.settledTrades.length > 0
      ? result.settledTrades.filter((trade) => (trade.realizedProfit ?? 0) > 0).length / result.settledTrades.length
      : 0;
  const maxDrawdown = calculateMaxDrawdown(result.settledTrades);
  const fitness =
    totalProfit +
    averageProfitPerTrade * 0.25 +
    winRate * 2 -
    Math.abs(Math.min(0, maxDrawdown)) * 0.1 +
    result.stats.realizedTrades * 0.02;

  const evaluated: EvaluatedCandidate = {
    settings,
    result,
    totalProfit,
    averageProfitPerTrade,
    maxDrawdown,
    winRate,
    fitness,
  };

  cache.set(key, evaluated);
  return evaluated;
}

function buildReport(best: EvaluatedCandidate, args: OptimizerArgs): OptimizerReport {
  return {
    generated_at: Math.floor(Date.now() / 1000),
    settings: {
      dump_hedge_sum_target: best.settings.sumTarget,
      dump_hedge_move_threshold: best.settings.moveThreshold,
      dump_hedge_window_minutes: best.settings.windowMinutes,
      dump_hedge_stop_loss_max_wait_minutes: best.settings.stopLossMaxWaitMinutes,
      dump_hedge_stop_loss_percentage: best.settings.stopLossPercentage,
    },
    stats: {
      periods_seen: best.result.stats.periodsSeen,
      periods_traded: best.result.stats.leg1Buys,
      cycles_hedged: best.result.stats.targetHedges,
      forced_stop_hedges: best.result.stats.stopLossHedges,
      realized_trades: best.result.stats.realizedTrades,
      total_profit: best.totalProfit,
      average_profit_per_trade: best.averageProfitPerTrade,
      max_drawdown: best.maxDrawdown,
      win_rate: best.winRate,
      fitness: best.fitness,
    },
    args: {
      filePath: args.filePath,
      population: args.population,
      generations: args.generations,
      elite: args.elite,
      mutationRate: args.mutationRate,
      seed: args.seed,
      reportPath: args.reportPath,
    },
  };
}

function printBest(best: EvaluatedCandidate, args: OptimizerArgs): void {
  console.log("GA Optimization Complete");
  console.log("------------------------");
  console.log(`File: ${args.filePath}`);
  console.log(`Population: ${args.population}`);
  console.log(`Generations: ${args.generations}`);
  console.log(`Seed: ${args.seed}`);
  console.log("");
  console.log("Best Settings");
  console.log(`DUMP_HEDGE_SUM_TARGET=${best.settings.sumTarget.toFixed(4)}`);
  console.log(`DUMP_HEDGE_MOVE_THRESHOLD=${best.settings.moveThreshold.toFixed(4)}`);
  console.log(`DUMP_HEDGE_WINDOW_MINUTES=${best.settings.windowMinutes}`);
  console.log(`DUMP_HEDGE_STOP_LOSS_MAX_WAIT_MINUTES=${best.settings.stopLossMaxWaitMinutes}`);
  console.log(`DUMP_HEDGE_STOP_LOSS_PERCENTAGE=${best.settings.stopLossPercentage.toFixed(4)}`);
  console.log("");
  console.log("Best Stats");
  console.log(`Realized PnL: $${best.totalProfit.toFixed(4)}`);
  console.log(`Avg PnL per trade: $${best.averageProfitPerTrade.toFixed(4)}`);
  console.log(`Win rate: ${(best.winRate * 100).toFixed(2)}%`);
  console.log(`Max drawdown: $${best.maxDrawdown.toFixed(4)}`);
  console.log(`Fitness: ${best.fitness.toFixed(4)}`);
  console.log(`Trades: ${best.result.stats.realizedTrades}`);
  console.log(`Report: ${args.reportPath}`);
}

export async function runOptimizer(args: OptimizerArgs): Promise<OptimizationResult> {
  if (!fs.existsSync(args.filePath)) {
    throw new Error(`History file not found: ${args.filePath}`);
  }

  const random = mulberry32(args.seed);
  const baseOptions = buildBaseOptions(args.filePath);
  const evaluationCache = new Map<string, EvaluatedCandidate>();
  let population: CandidateSettings[] = [];

  for (let i = 0; i < args.population; i++) {
    population.push(randomCandidate(baseOptions, random));
  }

  population[0] = normalizeCandidate({
    sumTarget: baseOptions.sumTarget,
    moveThreshold: baseOptions.moveThreshold,
    windowMinutes: baseOptions.windowMinutes,
    stopLossMaxWaitMinutes: baseOptions.stopLossMaxWaitMinutes,
    stopLossPercentage: baseOptions.stopLossPercentage,
  });

  let bestOverall: EvaluatedCandidate | null = null;

  for (let generation = 0; generation < args.generations; generation++) {
    const evaluated: EvaluatedCandidate[] = [];
    for (const candidate of population) {
      evaluated.push(await evaluateCandidate(baseOptions, candidate, evaluationCache));
    }

    evaluated.sort((left, right) => right.fitness - left.fitness);
    const best = evaluated[0];
    if (!bestOverall || best.fitness > bestOverall.fitness) {
      bestOverall = best;
    }

    console.log(
      `Generation ${generation + 1}/${args.generations} best fitness=${best.fitness.toFixed(4)} pnl=$${best.totalProfit.toFixed(4)} trades=${best.result.stats.realizedTrades}`
    );

    if (generation === args.generations - 1) {
      break;
    }

    const nextPopulation = evaluated.slice(0, args.elite).map((entry) => ({ ...entry.settings }));
    while (nextPopulation.length < args.population) {
      const parentA = tournamentSelect(evaluated, random);
      const parentB = tournamentSelect(evaluated, random);
      const child = mutate(crossover(parentA.settings, parentB.settings, random), args.mutationRate, random);
      nextPopulation.push(child);
    }
    population = nextPopulation;
  }

  if (!bestOverall) {
    throw new Error("Optimizer failed to evaluate any candidates");
  }

  const report = buildReport(bestOverall, args);
  fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
  fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2));
  return {
    args,
    best: bestOverall,
    report,
  };
}

async function main(): Promise<void> {
  const args = buildOptimizerArgs(process.argv);
  const optimization = await runOptimizer(args);
  printBest(optimization.best, optimization.args);
}

main().catch((err) => {
  console.error("Optimization failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});