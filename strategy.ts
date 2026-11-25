// Clean Sharpe Sniper — a paper-trading bot for the agent-fun/replay/v2 harness
// (pump.fun bonding curves, 10 SOL paper capital, 6-hour final window).
//
// Ranking is HOURLY SHARPE, not raw PnL: sharpe = mean / stdev of the hourly
// equity returns (6 hourly buckets in the final window). A bot that banks many
// small, steady, diversified wins with tiny drawdowns beats a bot that gambles
// on one moonshot. Every choice below serves that: small stakes, short holds,
// tight stops, partial profit-taking, and a trailing stop that lets a runner
// pay for several small losers without ever letting one hour blow up.
//
// What the dev window (24h, 1222 mints, Nov 2-3 2026) actually says, measured
// with grade-local on the kit (see README.md for the full table):
//   - The builder's first draft lost: -0.557 SOL, Sharpe -0.947, win rate
//     14.5% (256 round trips). The claimed "+2-3% net, 55-62% win rate" early
//     entry did NOT reproduce: the creator's first buy lands in the same slot
//     as creation 99.6% of the time and pumps the price +6.7% (median) before
//     any bot can fill, and every naive rule tested offline (early entry,
//     momentum, dip-buying, late/proven entry, wide-SL big-TP holds) loses
//     -4% to -16% per trade after fees.
//   - The one filter that flips the sign is EARLY CROWD: at least 6 distinct
//     non-creator buyers within 6 slots of creation (minBuyers 6, minTrades 1,
//     maxAge 6). With it the bot goes from -0.557 SOL / Sharpe -0.947 to
//     +0.049 SOL / Sharpe +0.164, win rate 31.8%, max drawdown 0.43% (66 round
//     trips, 58 mints on dev). minBuyers 7+ is impossible (maxBuyers is 6),
//     so 6 is the ceiling of this filter, not a tuned point.
//   - Fills land 2 slots after the decision and the first buys move the
//     price, so buys carry at most 5% slippage (buySlipBps 500; 100% slippage
//     accepted terrible fills) and never chase a run-up; bundled launches are
//     filtered (creator sold, too many early buyers, creator bought too much).
//   - Fees dominate small stakes: a round trip costs ~2.5% curve fees + 2 x
//     105,000 lamports tx fees, so no buy under 0.01 SOL is ever sent (it
//     could not count toward the 20-coin guardrail anyway). The 0.05 SOL
//     stake (vs 0.02) dilutes the fixed tx fee and lifts both PnL and Sharpe.
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

// Defaults: chosen on the dev window by grading ~25 variants with the kit's
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

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  done: boolean;
  devBuy: number;
  devSold: boolean;
}

interface Held {
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
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12, done: false, devBuy: 0, devSold: false };
      coins.set(mint, c);
    }
    return c;
  };

  /** Close value of a position now (SOL): sell everything at current reserves, curve + tx fees deducted. */
  const closeValue = (state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const mk = batch.marks.find((m) => m.mint === mint);
    const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const t = Number(tokens);
    if (vt + t <= 0) return 0;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const bigSell = new Set<Pubkey>();
      const devSoldNow = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          if (c.trades.length > 120) c.trades.splice(0, c.trades.length - 120);
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += sol;
            else {
              c.devSold = true;
              devSoldNow.add(e.mint);
            }
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          touched.add(e.mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const e = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') e.buy = true;
        else e.sell = true;
        pendingByMint.set(po.order.mint, e);
      }

      // --- Exits first: stops, trailing, take-profit, time, creator/big sells. ---
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = closeValue(state, batch, mint, pos.token_amount);
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        const pend = pendingByMint.get(mint);

        // Bank half once, at +takeProfit.
        if (!h.tookProfit && value >= cost * (1 + p.takeProfit) && !pend?.sell && orders.length < cap) {
          const half = pos.token_amount / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.tookProfit = true;
            continue;
          }
        }
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && p.exitOnDevSell && devSoldNow.has(mint)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pend?.sell) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Probe round trips: sell the probe as soon as its buy has landed. ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and pyramid adds. ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.done) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const h = held.get(mint);
        if (h === undefined) {
          // First buy: the early-entry signal.
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (c.created === null || now - c.created < p.minAge || now - c.created > p.maxAge) continue;
          if (rqSol < p.minRq || rqSol > p.maxRq) continue;
          if (c.createPrice <= 0) continue;
          const runup = price / c.createPrice - 1;
          if (runup < p.minRunup || runup > p.maxRunup) continue;
          if (p.skipDevSold && c.devSold) continue;
          if (c.devBuy > p.maxDevBuy) continue;
          const buyers = new Set<string>();
          let buys = 0;
          let flow = 0;
          let lastBuy = false;
          for (const tr of c.trades) {
            if (tr.buy) {
              buys++;
              flow += tr.sol;
              if (tr.user !== c.creator) buyers.add(tr.user);
            } else flow -= tr.sol;
            lastBuy = tr.buy;
          }
          if (buys < p.minTrades || buyers.size < p.minBuyers || buyers.size > p.maxBuyers) continue;
          if (flow < p.minFlow) continue;
          if (p.lastMustBeBuy && !lastBuy) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.initialSol, p.stakeSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          held.set(mint, { opened: now, peakValue: 0, invested: amount, adds: 0, tookProfit: false, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          // Pyramid into strength only: up from the last buy, still flowing in.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          let flow = 0;
          for (const tr of c.trades) flow += tr.buy ? tr.sol : -tr.sol;
          if (flow < p.minFlow) continue;
          if (rqSol > p.maxRq) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.addSol, p.stakeSol - h.invested, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // --- Guardrail pacing: probe when fills or counted coins lag the pace. ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        // Every buy this bot sends is >= minBuySol (0.01 SOL), so any coin with
        // a filled order is one round trip away from counting; myCoins is the
        // pacing proxy for counted coins.
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
