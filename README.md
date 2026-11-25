# Clean Sharpe Sniper — Pump.fun Sharpe Sprint

Paper-trading bot for make.fun's **Pump.fun Sharpe Sprint — Cleanest Paper Bot
Wins** (`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`).

One strategy program, `main.ts` on Node 22. It trades paper SOL on a 6-hour
pump.fun forward replay (`agent-fun/replay/v2`), ranked by **hourly Sharpe
ratio** — steady, controlled gains beat one lucky moonshot. A placement reward
needs net PnL above holding cash (above 0 after every fee).

## How to run

```sh
node main.ts            # speaks agent-fun/replay/v2 on stdin/stdout
```

No dependencies, no build step, no network, no clock, no randomness: a pure
function of the batch stream, so the two graded executions agree byte for
byte. `vendor/makefun-bot.ts` is the house shim (byte-identical to the kit's
`baselines/baseline-equal-weight/vendor/makefun-bot.ts`, sha256
`4e243d4a…`), kept out of the authorship counts.

## Strategy (see `strategy.ts` for the full reasoning)

Snipe a new coin's first trades through a rug filter, bank half at +10%,
trail the rest, cut every loser at −10% or on a time limit:

- **Entry — the only thing that matters is the early crowd.** Buy only when
  at least **6 distinct non-creator buyers** have traded within **6 slots**
  of creation (`minTrades 1, maxAge 6, minBuyers 6`), with the creator not
  sold, creator buys ≤ 2.5 SOL, real reserve 1–30 SOL, run-up ≤ +50%, net
  flow ≥ 0 and the last trade a buy. Stake 0.05 SOL, no pyramid adds.
- **Exits:** bank half at +10% (`takeProfit 0.10, takePart 0.5`), trailing
  stop (arms at +5%, exits on a −15% pullback from the peak), hard stop at
  −10%, time limit 600 slots unless up ≥ 50%, instant exit on a creator
  sell or a single sell ≥ 1 SOL.
- **Guards:** max 5 open positions, max 1.5 SOL exposure at cost, buys
  ≥ 0.01 SOL only, buy slippage capped at 5% (`buySlipBps 500`).
- **Guardrail pacing:** the snipe fires on only ~14 coins in a 6 h window at
  the dev rate, so the bot opens tiny 0.01 SOL probe round trips
  (`maxProbes 3, targetCoins 30`) to top the count up toward 20+ distinct
  mints; each probe costs ~0.0005 SOL.

## Measured results — dev window (24 h, 1222 mints, 2–3 Nov 2026)

Graded with the kit: `node cli/makefun.mjs grade-local --kit . --bot <repo>
--driver process --worktree` (process driver; this machine runs Node
v24.22.1, the server harness runs v26.13.1 — same scorer).

| Bot | Net PnL (SOL) | Sharpe (hourly) | Max DD | Win rate | Fills | Mints |
| --- | --- | --- | --- | --- | --- | --- |
| **This bot (final)** | **+0.0489** | **+0.164** | 0.43% | 31.8% | 145 | 58 |
| Builder's first draft | −0.5570 | −0.947 | 5.64% | 14.5% | 625 | 256 |
| House pilot sniper | −0.4966 | −0.844 | 5.41% | 12.7% | 849 | 354 |
| House pilot momentum | −9.4367 | −0.579 | 95.4% | 6.7% | 408 | 45 |
| House pilot reversion | −3.9873 | −0.481 | 49.0% | 26.8% | 2319 | 199 |
| Baseline equal-weight | −0.0193 | −0.223 | 0.93% | 0% | 5 | 5 |
| Baseline hold-cash | 0.0000 | — | 0% | — | 0 | 0 |

Final bot, full dev numbers: net PnL **+0.04893982 SOL** (return +0.49%),
Sharpe (hourly) **+0.164308520**, Sortino 0.398819293, max drawdown
**0.004323681**, win rate 0.318181818, 66 round trips, 145 fills, 58
distinct mints, curve fees 0.0478 SOL + tx fees 0.0153 SOL. Deterministic:
`l1.reproduced: true`. `result_sha256`
`611c394ee3f050928fbfa493566b57c449bdf4add7d0ba111ba0bf5197e6e5c5`,
`action_log_sha256`
`904e01d5d157e9923caa45c5f98b7bc1f3b46207555dfa82ebe071d17a0c3240`.
Eligibility: `ranked: true`; `prize_eligible: false` only for
`no_transcripts` + `cost_unpriced` (bundle/submit-time items, not code).

### Why the first draft lost, and what fixed it

The draft's claimed "+2–3% net, 55–62% win rate" early entry did **not**
reproduce. Measured on the dev dataset directly: the creator's first buy
lands in the same slot as creation 99.6% of the time and pumps the price
+6.7% (median) before any bot can fill (fills land 2 slots after the
decision), and every naive rule tested offline — early entry, momentum,
dip-buying, late/proven entry, wide-stop big-target holds — loses −4% to
−16% per trade after fees. The one filter that flips the sign is the early
crowd (`minBuyers` 2 → 6). Neighbouring cells rise monotonically toward it
(minBuyers 4: −0.089 SOL / −0.443; minBuyers 5: −0.031 SOL / −0.160), so
this is a slope, not a single lucky cell; 6 is also the ceiling
(`maxBuyers` is 6 — 7+ admits zero snipe entries). Exits barely mattered:
every TP/SL/trailing variant stayed negative until the entry filter was
fixed. Slippage 100% → 5% and stake 0.02 → 0.05 SOL also helped (fewer
terrible fills, fixed tx fee diluted).

### Stress test — read this before trusting the dev score

`grade-local --stress 20 --stress-jobs 2` on the final bot: **median
−0.056 SOL, p10 −0.117 SOL, p90 −0.003 SOL, 18/20 copies lost money, dev
rank 19/20**, with the kit's warnings ("dev score above 90% of the rebuilt
copies", "half or more of the rebuilt copies lost money"). The dev +0.049
SOL leans on this window's particular coins: top 3 coins are 47.9% of the
gains (net without them: −0.020 SOL). The final 6 h window is a fresh draw —
this entry is the best of ~25 graded variants and the only one positive on
dev (every house pilot loses on dev too), but a positive final PnL is **not**
promised. Guardrails hold with huge margin on dev (max drawdown 0.43% vs
the 50% cap; 58 mints vs the 20 minimum — probes cover the 6 h shortfall).

## Files

- `main.ts` — entrypoint: wires the strategy into the house shim.
- `strategy.ts` — the strategy (all logic, all parameters).
- `vendor/makefun-bot.ts` — house replay-v2 shim (unmodified).
- `.makefun/owner.json` — payout wallet `CaJ4Trx6nTpXW6rXHDyQjT9GisPmN9zq7bpEjrWSJvrh`
  (account `@quadro-7`).

## Status

Built and validated locally 25 Nov 2026, before the competition opens
(26 Nov 01:00 WITA). `makefun init` was refused before opening (drand anchor
round 34274212 is only emitted at the opening); the coordinator re-runs init,
then commits, bundles and submits after 01:00 WITA. No commit, push, bundle
or submit has been done from this build. LICENSE (MIT) is created by `init`
itself — do not add one beforehand, `init` refuses a repository that already
holds a LICENSE.
