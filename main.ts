// Clean Sharpe Sniper — paper-trading bot for make.fun's Pump.fun Sharpe Sprint.
// A single strategy program, main.ts on Node 22: it trades paper SOL across
// a 6-hour pump.fun forward replay (agent-fun/replay/v2), ranked by hourly
// Sharpe ratio. No model calls, no network, no clock, no randomness — a pure
// function of the batch stream, so the two graded executions agree byte for
// byte.
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
const faults: string[] = [];
const mustHold = (ok: boolean, why: string): void => {
  if (!ok) faults.push(why);
};
mustHold(
  cfg.minAge >= 0 && cfg.minAge <= cfg.maxAge,
  'entry age window is inverted',
);
mustHold(cfg.minTrades >= 1, 'an entry needs at least one prior trade');
mustHold(
  cfg.minBuyers > 0 && cfg.minBuyers <= cfg.maxBuyers,
  'buyer-count window is inverted',
);
mustHold(
  cfg.minRq > 0 && cfg.minRq <= cfg.maxRq,
  'reserve window is inverted',
);
mustHold(cfg.minRunup <= cfg.maxRunup, 'run-up window is inverted');
mustHold(
  cfg.minBuySol > 0 && cfg.initialSol >= cfg.minBuySol,
  'first stake is below the smallest buy',
);
mustHold(
  cfg.stakeSol >= cfg.initialSol &&
    cfg.maxExposureSol >= cfg.stakeSol,
  'stake sits above the exposure cap',
);
mustHold(
  cfg.buySlipBps > 0 && cfg.buySlipBps <= 10_000,
  'buy slippage outside the 0..10000 bps range',
);
mustHold(
  cfg.takeProfit > 0 && cfg.takePart > 0 && cfg.takePart <= 1,
  'take-profit share outside (0, 1]',
);
mustHold(
  cfg.stopLoss > 0 && cfg.stopLoss < 1,
  'hard stop outside (0, 1)',
);
mustHold(
  cfg.trailArm >= 0 && cfg.trail > 0 && cfg.trail < 1,
  'trailing stop outside (0, 1)',
);
mustHold(
  cfg.maxHold > 0 && cfg.cooldown >= 0 && cfg.maxEntries >= 1,
  'hold/cooldown/entry limits are invalid',
);
mustHold(
  cfg.maxMain >= 1 && cfg.maxExposureSol > 0,
  'position/exposure caps are invalid',
);
mustHold(
  cfg.targetCoins >= 20 && cfg.targetFills >= cfg.targetCoins,
  'pacing targets sit below the guardrail floor',
);
mustHold(
  cfg.paceSecs > 0 &&
    cfg.probeSol >= cfg.minBuySol &&
    cfg.maxProbes >= 1,
  'probe pacing is invalid',
);
mustHold(cfg.addSol >= cfg.minBuySol && cfg.maxAdds >= 0 && cfg.addStep >= 0 && cfg.addIfUp >= 0, 'pyramid add below smallest buy or step/trigger negative');
mustHold(cfg.bigSellSol > 0 && cfg.holdIfUp >= 0 && cfg.maxDevBuy >= 0, 'exit/dev thresholds invalid');
if (faults.length > 0) {
  throw new Error(`invalid strategy config: ${faults.join('; ')}`);
}

await runBot(createStrategy(DEFAULT_PARAMS));
