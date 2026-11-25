// Clean Sharpe Sniper — paper-trading bot for make.fun's Pump.fun Sharpe Sprint.
// One strategy program, main.ts on Node 22: it trades paper SOL on a 6-hour
// pump.fun forward replay (agent-fun/replay/v2), ranked by hourly Sharpe ratio.
// No model calls, no network, no clock, no randomness — a pure function of the
// batch stream, so the two graded executions agree byte for byte.
//
// Strategy in one line: snipe a new coin's first trades through a rug filter,
// bank half at +10%, trail the rest, cut every loser at -10% or on a time
// limit. See strategy.ts for the full reasoning and README.md for the numbers.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Reviser check (2026-11-26): before the harness starts, confirm the shipped
// parameter set is internally consistent — every window ordered, every
// fraction inside its range, every stake above the smallest buy the bot will
// ever send, and the guardrail pacing target at or above the 20-coin floor.
// These are read-only sanity checks on values that already exist; they emit
// nothing and cannot change any order the strategy sends. They only refuse
// to run a self-contradictory config.
const cfg = DEFAULT_PARAMS;
const broken: string[] = [];
const mustHold = (ok: boolean, why: string): void => {
  if (!ok) broken.push(why);
};
mustHold(cfg.minAge >= 0 && cfg.minAge <= cfg.maxAge, 'entry age window inverted');
mustHold(cfg.minTrades >= 1, 'entry needs at least one prior trade');
mustHold(cfg.minBuyers > 0 && cfg.minBuyers <= cfg.maxBuyers, 'buyer-count window inverted');
mustHold(cfg.minRq > 0 && cfg.minRq <= cfg.maxRq, 'reserve window inverted');
mustHold(cfg.minRunup <= cfg.maxRunup, 'run-up window inverted');
mustHold(cfg.minBuySol > 0 && cfg.initialSol >= cfg.minBuySol, 'first stake below smallest buy');
mustHold(cfg.stakeSol >= cfg.initialSol && cfg.maxExposureSol >= cfg.stakeSol, 'stake above exposure cap');
mustHold(cfg.buySlipBps > 0 && cfg.buySlipBps <= 10_000, 'buy slippage outside 0..10000 bps');
mustHold(cfg.takeProfit > 0 && cfg.takePart > 0 && cfg.takePart <= 1, 'take-profit share outside (0, 1]');
mustHold(cfg.stopLoss > 0 && cfg.stopLoss < 1, 'hard stop outside (0, 1)');
mustHold(cfg.trailArm >= 0 && cfg.trail > 0 && cfg.trail < 1, 'trailing stop outside (0, 1)');
mustHold(cfg.maxHold > 0 && cfg.cooldown >= 0 && cfg.maxEntries >= 1, 'hold/cooldown/entry limits invalid');
mustHold(cfg.maxMain >= 1 && cfg.maxExposureSol > 0, 'position/exposure caps invalid');
mustHold(cfg.targetCoins >= 20 && cfg.targetFills >= cfg.targetCoins, 'pacing targets below guardrail floor');
mustHold(cfg.paceSecs > 0 && cfg.probeSol >= cfg.minBuySol && cfg.maxProbes >= 1, 'probe pacing invalid');
if (broken.length > 0) throw new Error(`invalid strategy config: ${broken.join('; ')}`);

await runBot(createStrategy(DEFAULT_PARAMS));
