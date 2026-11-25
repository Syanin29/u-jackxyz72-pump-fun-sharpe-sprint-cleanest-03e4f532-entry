// Clean Sharpe Sniper — paper bot for the agent-fun/replay/v2 harness
// (pump.fun bonding curves, 10 SOL of paper capital, a 6-hour final window).
//
// The scoreboard ranks HOURLY SHARPE, not raw PnL: sharpe equals the mean
// divided by the standard deviation of hourly equity returns (six hourly
// buckets across the final window). A bot that collects many small, steady,
// diversified wins with tiny drawdowns outranks a bot that bets everything
// on a single moonshot. Every decision below serves that aim: small stakes,
// short holds, tight stops, partial profit-taking, and a trailing stop that
// lets one runner pay for several small losers without ever letting a single
// hour blow up the equity curve.
//
// What the dev window (24h, 1222 mints, Nov 2-3 2026) actually measured,
// graded with the kit's grade-local (full table in README.md):
//   - The builder's first draft lost money: -0.557 SOL, Sharpe -0.947, win
//     rate 14.5% (256 round trips). The advertised "+2-3% net, 55-62% win
//     rate" early entry did NOT reproduce: the creator's first buy lands in
//     the same slot as creation 99.6% of the time and lifts the price +6.7%
//     (median) before any bot can fill, and every naive rule tried offline
//     (early entry, momentum, dip-buying, late/proven entry, wide-SL big-TP
//     holds) loses -4% to -16% per trade after fees.
//   - The single filter that flips the sign is the EARLY CROWD: at least 6
//     distinct non-creator buyers within 6 slots of creation (minBuyers 6,
//     minTrades 1, maxAge 6). With it the bot moves from -0.557 SOL /
//     Sharpe -0.947 to +0.049 SOL / Sharpe +0.164, win rate 31.8%, max
//     drawdown 0.43% (66 round trips, 58 mints on dev). minBuyers 7+ admits
//     nothing (maxBuyers is 6), so 6 is the ceiling of this filter, not a
//     tuned point.
//   - Fills land 2 slots after the decision and the first buys move the
//     price, so buys tolerate at most 5% slippage (buySlipBps 500; 100%
//     slippage accepted terrible fills) and never chase a run-up; bundled
//     launches are filtered out (creator sold, too many early buyers,
//     creator bought too much).
//   - Fees dominate small stakes: one round trip costs ~2.5% curve fees plus
//     2 x 105,000 lamports of tx fees, so no buy under 0.01 SOL is ever sent
//     (it could not count toward the 20-coin guardrail anyway). The 0.05 SOL
//     stake (versus 0.02) dilutes the fixed tx fee and lifts both PnL and
//     Sharpe.
//   - Guardrail pacing: the snipe fires on only ~14 coins in a 6h window at
//     the dev rate, so probes (maxProbes 3, targetCoins 30) top the count up
//     toward 20+ with 0.01 SOL round trips; each probe costs ~0.0005 SOL.
//   - Honest caveat: dev is ONE 24h sample and the final window is a fresh
//     6h draw; the stress band (README.md) shows the spread. Nothing here
//     promises a positive final PnL.
//
// Exits, in order of preference: bank half at +takeProfit, trail the rest
// (arms at +trailArm, exits on a -trail pullback from the peak), hard stop at
// -stopLoss, time limit (unless far up), exit at once when the creator sells
// or a single sell of >= bigSellSol lands. A completing curve is closed by
// the replay itself at its final reserves.
//
// Guardrail pacing: the run must end with round trips of >= 0.01 SOL on at
// least 20 distinct mints. The snipe flow normally clears that on its own;
// only when fills/coins lag the pace (scaled by block time over 6h) does the
// bot open tiny 0.01 SOL probe round trips, one at a time.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream, so the
// two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest/oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Trades seen on the coin before an entry is allowed. */
  minTrades: number;
  /** Distinct non-creator buyers seen: at least this many, at most this many. */
  minBuyers: number;
  maxBuyers: number;
  /** Creator's own buys (SOL) at most this; skip the coin when the creator sold. */
  maxDevBuy: number;
  skipDevSold: boolean;
  /** Real SOL reserve window (SOL) at decision time. */
  minRq: number;
  maxRq: number;
  /** Price now over the create price, minus 1: window. Never chase a run-up. */
  minRunup: number;
  maxRunup: number;
  /** Net SOL (buys minus sells) over the recent tape must be at least this. */
  minFlow: number;
  /** The most recent trade must be a buy. */
  lastMustBeBuy: boolean;
  /** First buy (SOL), each add-on buy (SOL), most SOL per position in total. */
  initialSol: number;
  addSol: number;
  stakeSol: number;
  /** Most add-on buys after the first one. */
  maxAdds: number;
  /** Add only once the price is this far above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Bank this share of the position once it is worth cost * (1 + takeProfit). */
  takeProfit: number;
  takePart: number;
  /** Hard stop: exit when the close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: arms at cost * (1 + trailArm), exits on a fall of trail from the peak. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots, unless up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Exit at once when a single recorded sell of at least this many SOL lands. */
  bigSellSol: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Most main (snipe) positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with round trips of >= 0.01 SOL on at
   * least 20 coins. When the bot's own fills or counted coins lag
   * targetFills / targetCoins scaled by the share of paceSecs elapsed (block
   * time since the first batch), it opens tiny probe round trips (buy
   * probeSol, sell it all as soon as the buy lands) until back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Defaults: picked on the dev window by grading ~25 variants with the kit's
// grade-local (one knob at a time, then combinations). The winning direction
// was not exits (TP/SL/trailing changes all stayed negative) but the entry
// filter: minBuyers 2 -> 6. Flat-region preference still applies — 6 is the
// filter ceiling (maxBuyers 6), and the neighbouring cells (minBuyers 4: -0.089
// SOL / -0.443; minBuyers 5: -0.031 SOL / -0.160) rise monotonically toward it,
// so this is a slope, not a single lucky cell. See README.md for the table.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 6,
  minTrades: 1,
  minBuyers: 6,
  maxBuyers: 6,
  maxDevBuy: 2.5,
  skipDevSold: true,
  minRq: 1.0,
  maxRq: 30,
  minRunup: -0.05,
  maxRunup: 0.5,
  minFlow: 0,
  lastMustBeBuy: true,
  initialSol: 0.05,
  addSol: 0.05,
  stakeSol: 0.15,
  maxAdds: 0,
  addStep: 0.05,
  addIfUp: 0,
  minBuySol: 0.01,
  buySlipBps: 500,
  takeProfit: 0.1,
  takePart: 0.5,
  stopLoss: 0.1,
  trailArm: 0.05,
  trail: 0.15,
  maxHold: 600,
  holdIfUp: 0.5,
  cooldown: 150,
  maxEntries: 1,
  bigSellSol: 1,
  exitOnDevSell: true,
  maxMain: 5,
  maxExposureSol: 1.5,
  targetCoins: 30,
  targetFills: 80,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 3,
};

const LAMPORTS_PER_SOL = 1e9;
const CURVE_FEE_RATE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinState {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
  done: boolean;
  devBuy: number;
  devSold: boolean;
}

interface OpenPosition {
  opened: number;
  peakValue: number;
  invested: number;
  adds: number;
  tookProfit: boolean;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coinBook = new Map<Pubkey, CoinState>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probeState = new Map<Pubkey, boolean>();
  let fillCount = 0;
  const filledCoins = new Set<Pubkey>();
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;

  const lookupCoin = (mint: Pubkey): CoinState => {
    let found = coinBook.get(mint);
    if (found === undefined) {
      found = {
        created: null,
        creator: null,
        createPrice: 0,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        done: false,
        devBuy: 0,
        devSold: false,
      };
      coinBook.set(mint, found);
    }
    return found;
  };

  /** Close value of a position now (SOL): sell everything at current reserves, curve + tx fees deducted. */
  const exitValue = (
    state: BotState,
    batch: Batch,
    mint: Pubkey,
    tokens: bigint,
  ): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const mark = batch.marks.find((m) => m.mint === mint);
    const quoteReserves =
      mark !== undefined
        ? Number(mark.virtual_quote_reserves)
        : Number(curve.virtual_quote_reserves);
    const tokenReserves =
      mark !== undefined
        ? Number(mark.virtual_token_reserves)
        : Number(curve.virtual_token_reserves);
    const amount = Number(tokens);
    if (tokenReserves + amount <= 0) return 0;
    const feeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    const grossSol =
      ((amount * quoteReserves) / (tokenReserves + amount)) / LAMPORTS_PER_SOL;
    const afterFee = grossSol * (1 - CURVE_FEE_RATE);
    return afterFee - feeSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slotNow = batch.slot;
      const feeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
      const bigSells = new Set<Pubkey>();
      const devDumped = new Set<Pubkey>();
      const active = new Set<Pubkey>();
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          fillCount++;
          filledCoins.add(fill.mint);
        }
      }
      for (const ev of batch.events) {
        if (ev.block_time !== null) {
          if (firstSeen === null) firstSeen = ev.block_time;
          if (lastSeen === null || ev.block_time > lastSeen) {
            lastSeen = ev.block_time;
          }
        }
        if (ev.event === 'CreateEvent') {
          const coin = lookupCoin(ev.mint);
          coin.created = ev.slot;
          coin.creator = ev.creator;
          coin.createPrice =
            Number(ev.virtual_quote_reserves) /
            Number(ev.virtual_token_reserves);
        } else if (ev.event === 'TradeEvent') {
          const coin = lookupCoin(ev.mint);
          const solAmt = Number(ev.sol_amount) / LAMPORTS_PER_SOL;
          coin.trades.push({
            slot: ev.slot,
            buy: ev.is_buy,
            sol: solAmt,
            user: ev.user,
            price:
              Number(ev.virtual_quote_reserves) /
              Number(ev.virtual_token_reserves),
          });
          if (coin.trades.length > 120) {
            coin.trades.splice(0, coin.trades.length - 120);
          }
          if (ev.user === coin.creator) {
            if (ev.is_buy) {
              coin.devBuy += solAmt;
            } else {
              coin.devSold = true;
              devDumped.add(ev.mint);
            }
          }
          if (!ev.is_buy && solAmt >= p.bigSellSol) bigSells.add(ev.mint);
          active.add(ev.mint);
        }
      }

      const out: OrderInput[] = [];
      const batchCap = state.hello.caps.max_orders_per_batch;
      const pendingMap = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const pendingOrder of state.pending.values()) {
        const flags =
          pendingMap.get(pendingOrder.order.mint) ?? { buy: false, sell: false };
        if (pendingOrder.order.side === 'buy') flags.buy = true;
        else flags.sell = true;
        pendingMap.set(pendingOrder.order.mint, flags);
      }

      // --- Exits first: stops, trailing, take-profit, time, creator/big sells. ---
      for (const [mint, heldPos] of open) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pendingMap.has(mint)) {
            open.delete(mint);
            const coin = lookupCoin(mint);
            if (heldPos.filled) coin.lastExit = slotNow;
            else coin.entries--;
          }
          continue;
        }
        heldPos.filled = true;
        if (curve === undefined || curve.complete) continue;
        const costSol = Number(position.cost_lamports) / LAMPORTS_PER_SOL;
        const worth = exitValue(state, batch, mint, position.token_amount);
        if (worth > heldPos.peakValue) heldPos.peakValue = worth;
        heldPos.lastValue = worth;
        const coin = lookupCoin(mint);
        const pending = pendingMap.get(mint);

        // Bank half once, at +takeProfit.
        if (
          !heldPos.tookProfit &&
          worth >= costSol * (1 + p.takeProfit) &&
          !pending?.sell &&
          out.length < batchCap
        ) {
          const halfTokens = position.token_amount / 2n;
          if (halfTokens > 0n) {
            out.push({
              side: 'sell',
              mint,
              token_amount: halfTokens,
              max_slippage_bps: 10_000,
            });
            heldPos.tookProfit = true;
            continue;
          }
        }
        let shouldExit = heldPos.exiting;
        if (!shouldExit && worth < costSol * (1 - p.stopLoss)) {
          shouldExit = true;
        }
        if (
          !shouldExit &&
          heldPos.peakValue >= costSol * (1 + p.trailArm) &&
          worth < heldPos.peakValue * (1 - p.trail)
        ) {
          shouldExit = true;
        }
        if (
          !shouldExit &&
          slotNow - heldPos.opened > p.maxHold &&
          worth < costSol * (1 + p.holdIfUp)
        ) {
          shouldExit = true;
        }
        if (!shouldExit && p.exitOnDevSell && devDumped.has(mint)) {
          shouldExit = true;
        }
        if (!shouldExit && bigSells.has(mint)) shouldExit = true;
        if (!shouldExit) continue;
        heldPos.exiting = true;
        if (pending?.sell) continue;
        if (out.length >= batchCap) break;
        out.push({
          side: 'sell',
          mint,
          token_amount: position.token_amount,
          max_slippage_bps: 10_000,
        });
      }

      // --- Probe round trips: sell the probe as soon as its buy has landed. ---
      for (const [mint, isSelling] of probeState) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pendingMap.has(mint)) probeState.delete(mint);
          continue;
        }
        if (
          curve === undefined ||
          curve.complete ||
          pendingMap.has(mint)
        ) {
          continue;
        }
        if (out.length >= batchCap) break;
        out.push({
          side: 'sell',
          mint,
          token_amount: position.token_amount,
          max_slippage_bps: 10_000,
        });
        if (!isSelling) probeState.set(mint, true);
      }

      // --- Entries and pyramid adds. ---
      let cashLeft = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      let roomLeft =
        state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainRoom = p.maxMain - open.size;
      let exposureSol = 0;
      for (const [mint, heldPos] of open) {
        exposureSol += Math.max(
          heldPos.invested,
          Number(state.positions.get(mint)?.cost_lamports ?? 0n) /
            LAMPORTS_PER_SOL,
        );
      }
      for (const mint of active) {
        if (out.length >= batchCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingMap.has(mint) || probeState.has(mint)) continue;
        const coin = coinBook.get(mint)!;
        if (coin.done) continue;
        const px =
          Number(curve.virtual_quote_reserves) /
          Number(curve.virtual_token_reserves);
        const reserveSol =
          Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        const heldPos = open.get(mint);
        if (heldPos === undefined) {
          // First buy: the early-entry signal.
          if (roomLeft <= 0 || mainRoom <= 0) continue;
          if (coin.entries >= p.maxEntries || slotNow - coin.lastExit < p.cooldown) {
            continue;
          }
          if (
            coin.created === null ||
            slotNow - coin.created < p.minAge ||
            slotNow - coin.created > p.maxAge
          ) {
            continue;
          }
          if (reserveSol < p.minRq || reserveSol > p.maxRq) continue;
          if (coin.createPrice <= 0) continue;
          const rally = px / coin.createPrice - 1;
          if (rally < p.minRunup || rally > p.maxRunup) continue;
          if (p.skipDevSold && coin.devSold) continue;
          if (coin.devBuy > p.maxDevBuy) continue;
          const crowd = new Set<string>();
          let buyCount = 0;
          let netFlow = 0;
          let endedOnBuy = false;
          for (const tape of coin.trades) {
            if (tape.buy) {
              buyCount++;
              netFlow += tape.sol;
              if (tape.user !== coin.creator) crowd.add(tape.user);
            } else {
              netFlow -= tape.sol;
            }
            endedOnBuy = tape.buy;
          }
          if (
            buyCount < p.minTrades ||
            crowd.size < p.minBuyers ||
            crowd.size > p.maxBuyers
          ) {
            continue;
          }
          if (netFlow < p.minFlow) continue;
          if (p.lastMustBeBuy && !endedOnBuy) continue;
          const buyCap =
            Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
          let size = Math.min(
            buyCap,
            p.initialSol,
            p.stakeSol,
            p.maxExposureSol - exposureSol,
          );
          if (size > cashLeft - feeSol) size = cashLeft - feeSol;
          if (size < p.minBuySol) continue;
          const quoteLamports = BigInt(Math.floor(size * LAMPORTS_PER_SOL));
          out.push({
            side: 'buy',
            mint,
            quote_lamports: quoteLamports,
            max_slippage_bps: p.buySlipBps,
          });
          cashLeft -= size + feeSol;
          exposureSol += size;
          open.set(mint, {
            opened: slotNow,
            peakValue: 0,
            invested: size,
            adds: 0,
            tookProfit: false,
            exiting: false,
            filled: false,
            lastAddPrice: px,
            lastValue: 0,
          });
          coin.entries++;
          roomLeft--;
          mainRoom--;
        } else {
          // Pyramid into strength only: up from the last buy, still flowing in.
          if (
            heldPos.exiting ||
            !heldPos.filled ||
            heldPos.adds >= p.maxAdds ||
            heldPos.invested >= p.stakeSol - p.minBuySol
          ) {
            continue;
          }
          const position = state.positions.get(mint);
          if (position === undefined) continue;
          if (px < heldPos.lastAddPrice * (1 + p.addStep)) continue;
          if (
            heldPos.lastValue <
            (Number(position.cost_lamports) / LAMPORTS_PER_SOL) *
              (1 + p.addIfUp)
          ) {
            continue;
          }
          let flow = 0;
          for (const tape of coin.trades) {
            flow += tape.buy ? tape.sol : -tape.sol;
          }
          if (flow < p.minFlow) continue;
          if (reserveSol > p.maxRq) continue;
          const buyCap =
            Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
          let size = Math.min(
            buyCap,
            p.addSol,
            p.stakeSol - heldPos.invested,
            p.maxExposureSol - exposureSol,
          );
          if (size > cashLeft - feeSol) size = cashLeft - feeSol;
          if (size < p.minBuySol) continue;
          const quoteLamports = BigInt(Math.floor(size * LAMPORTS_PER_SOL));
          out.push({
            side: 'buy',
            mint,
            quote_lamports: quoteLamports,
            max_slippage_bps: p.buySlipBps,
          });
          cashLeft -= size + feeSol;
          exposureSol += size;
          heldPos.invested += size;
          heldPos.adds++;
          heldPos.lastAddPrice = px;
        }
      }

      // --- Guardrail pacing: probe when fills or counted coins lag the pace. ---
      if (
        probeState.size < p.maxProbes &&
        roomLeft > 0 &&
        firstSeen !== null &&
        lastSeen !== null
      ) {
        const elapsedShare = Math.min(
          1,
          (lastSeen - firstSeen) / p.paceSecs,
        );
        // Every buy this bot sends is >= minBuySol (0.01 SOL), so any coin with
        // a filled order is one round trip away from counting; filledCoins is the
        // pacing proxy for counted coins.
        const coinsShort =
          filledCoins.size < Math.ceil(p.targetCoins * elapsedShare);
        const fillsShort =
          fillCount < Math.ceil(p.targetFills * elapsedShare);
        if (coinsShort || fillsShort) {
          const minReserve =
            (p.probeSol * 10_000) /
            state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of active) {
            if (out.length >= batchCap || probeState.size >= p.maxProbes) break;
            if (
              open.has(mint) ||
              probeState.has(mint) ||
              pendingMap.has(mint) ||
              state.positions.has(mint)
            ) {
              continue;
            }
            if (coinsShort && !fillsShort && filledCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (
              Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL <
              minReserve * 1.5
            ) {
              continue;
            }
            if (cashLeft < p.probeSol + 2 * feeSol) break;
            out.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(
                Math.floor(p.probeSol * LAMPORTS_PER_SOL),
              ),
              max_slippage_bps: p.buySlipBps,
            });
            probeState.set(mint, false);
            cashLeft -= p.probeSol + feeSol;
          }
        }
      }
      return out;
    },
  };
}
